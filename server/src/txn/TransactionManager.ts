/**
 * ★难点 2：三方事务配对与超时状态机（§3.6 / §5.3）。
 *
 * 状态机：
 *   CREATED ──write──▶ WAITING_ACK ──0x8002──▶ WAITING_UDS_RESPONSE ──正响应──▶ COMPLETED
 *                            │                        │       └── 7F xx 78 ──▶ WAITING_PENDING ──▶ COMPLETED / FAILED_UDS_TIMEOUT
 *                            ├── 0x8003 ──▶ FAILED_NACK
 *                            └── ACK_WAIT 超时 ──▶ FAILED_ACK_TIMEOUT（★网关没收下）
 *   抑制正响应：WAITING_ACK ──0x8002──▶ SUPPRESSED（开 200ms NRC 观察窗）
 *
 * 关键约束：
 *  - 每个状态迁移必须清除上一个状态的 timer，避免"幽灵超时"
 *  - transition() 是唯一改 state 的方法，内置非法迁移拦截
 *  - ★FAILED_ACK_TIMEOUT 与 FAILED_UDS_TIMEOUT 严格区分（排查方向完全不同）
 *  - 连接断开时把所有非终态事务置 CANCELLED 并清 timer（防止进程因悬挂 timer 不退出）
 */

import {
  DOIP_DEFAULTS,
  FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES,
  FALLBACK_NRC_TABLE,
  LIMITS,
  describeCode,
  formatHex,
  nowMonoMs,
  parseHex,
} from '@doip/shared';
import type {
  DiagnosticMessageAckPayload,
  DiagnosticMessageNackPayload,
  DiagnosticMessagePayload,
  SendUdsRequest,
  SendUdsResult,
  TxnState,
} from '@doip/shared';
import { didToBytes, formatCode, parseCode, parseDid } from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getTiming } from '../config/defaults';
import { createTransaction, isTerminalState } from './Transaction';
import type { Transaction } from './Transaction';
import {
  NRC_RESPONSE_PENDING,
  expectPositiveSid,
  hasSubFunction,
  isNegativeResponse,
  isPositiveResponseFor,
  keyOf,
  negativeResponseSid,
  nrcOf,
  previousMessageMatches,
  suppressPositiveResponseOf,
} from './TxnMatchPolicy';

/** 事务写出通道（由 DoipClient 适配；连仿真与连真实走同一实现） */
export interface TxnSender {
  sendDiagnosticMessage(sa: number, ta: number, userData: Uint8Array): void;
}

export interface TxnSeqSource {
  next(): number;
}

export type TxnEvent =
  | { kind: 'created'; txn: Transaction }
  | { kind: 'state'; txn: Transaction; from: TxnState; to: TxnState }
  | { kind: 'unsolicited'; sa: number; ta: number; userData: Uint8Array; seq: number }
  | { kind: 'warn'; code: string; txnId: string | null; messageZh: string };

export interface TransactionManagerOptions {
  sender: TxnSender;
  sa: number;
  ta: number;
  sessionId?: string;
  /** Trace seq 分配器（M2 由 EventBus 提供；缺省用内部单调计数） */
  seqSource?: TxnSeqSource;
  now?: () => number;
  onEvent?: (event: TxnEvent) => void;
}

interface Deferred {
  resolve: (result: SendUdsResult) => void;
}

/**
 * 由 SendUdsRequest 构造 UDS 请求字节（表单模式 or 原始 hex 模式）。
 * ★Q6：这是"发送一个 UDS 请求"的唯一入口，P1 脚本层直接复用。
 */
export function buildUdsRequestBytes(req: SendUdsRequest): Uint8Array {
  if (req.rawHex !== undefined && req.rawHex.trim() !== '') {
    return parseHex(req.rawHex);
  }
  if (req.sid === undefined || req.sid.trim() === '') {
    throw new AppError('E_TXN_REQUEST_INVALID', '缺少 sid（也未提供 rawHex），无法构造 UDS 请求');
  }
  const bytes: number[] = [parseCode(req.sid)];
  if (req.subFunction !== undefined && req.subFunction.trim() !== '') {
    bytes.push(parseCode(req.subFunction));
  }
  for (const did of req.dids ?? []) {
    const [hi, lo] = didToBytes(parseDid(did));
    bytes.push(hi, lo);
  }
  if (req.dataHex !== undefined && req.dataHex.trim() !== '') {
    for (const b of parseHex(req.dataHex)) bytes.push(b);
  }
  return Uint8Array.from(bytes);
}

export class TransactionManager {
  private readonly log = getLogger('txn');
  private readonly byId = new Map<string, Transaction>();
  /** 待匹配索引：key = 响应方向 `${ta}->${sa}` */
  private readonly pending = new Map<string, Transaction[]>();
  private readonly completed: Transaction[] = [];
  private readonly waiters = new Map<string, Deferred>();

  private counter = 0;
  private seqCounter = 0;
  private sessionId: string;
  private sa: number;
  private ta: number;
  private readonly sender: TxnSender;
  private readonly seqSource: TxnSeqSource;
  private readonly now: () => number;
  private readonly onEvent?: (event: TxnEvent) => void;

  constructor(options: TransactionManagerOptions) {
    this.sender = options.sender;
    this.sa = options.sa;
    this.ta = options.ta;
    this.sessionId = options.sessionId ?? 'default';
    this.seqSource = options.seqSource ?? {
      next: () => {
        this.seqCounter += 1;
        return this.seqCounter;
      },
    };
    this.now = options.now ?? nowMonoMs;
    if (options.onEvent !== undefined) this.onEvent = options.onEvent;
  }

  /* ─────────────── 地址与查询 ─────────────── */

  setAddresses(sa: number, ta: number): void {
    this.sa = sa;
    this.ta = ta;
  }

  getAddresses(): { sa: number; ta: number } {
    return { sa: this.sa, ta: this.ta };
  }

  getTransaction(txnId: string): Transaction | undefined {
    return this.byId.get(txnId);
  }

  listCompleted(): readonly Transaction[] {
    return this.completed;
  }

  pendingTransactions(): Transaction[] {
    const out: Transaction[] = [];
    for (const txn of this.byId.values()) {
      if (!isTerminalState(txn.state)) out.push(txn);
    }
    return out;
  }

  /* ─────────────── 唯一发送入口 ─────────────── */

  async send(req: SendUdsRequest): Promise<SendUdsResult> {
    const bytes = buildUdsRequestBytes(req);
    const sid = bytes[0];
    if (sid === undefined) {
      throw new AppError('E_TXN_REQUEST_INVALID', 'UDS 请求为空');
    }
    this.counter += 1;
    const txnId = `tx-${String(this.counter).padStart(4, '0')}`;
    const createdAtMs = this.now();
    /**
     * ★缺陷修复（QA 终验）：功能寻址此前"只登记、不生效"。
     * `this.ta` 是 `connect()/setTargetAddress()` 写死的**物理**目标地址，
     * 而 `req.addressing` 只被塞进事务对象，从未参与选目标地址 ——
     *   结果功能寻址请求实际仍以物理 TA 发出，仿真侧只回一条，没有多 ECU 聚合。
     * 这里按 addressing 选真实目标地址，并让事务记录里也存实际使用的 TA（便于 Trace 对齐）。
     */
    const ta = req.addressing === 'functional' ? DOIP_DEFAULTS.FUNCTIONAL_ADDRESS : this.ta;
    const txn = createTransaction({
      txnId,
      sessionId: this.sessionId,
      addressing: req.addressing,
      sa: this.sa,
      ta,
      requestUdsBytes: bytes,
      requestUdsHex: formatHex(bytes),
      sid,
      expectedPositiveSid: expectPositiveSid(sid),
      suppressPositiveResponse: hasSubFunction(sid) && suppressPositiveResponseOf(bytes),
      createdAtMs,
    });
    // ★seq 由 EventBus 在帧发布时统一分配：帧发出后再回填，保证 seqRequest 指向真实 Trace 条目
    this.byId.set(txnId, txn);
    this.enqueuePending(txn);
    this.emit({ kind: 'created', txn });

    const promise = new Promise<SendUdsResult>((resolve) => {
      this.waiters.set(txnId, { resolve });
    });

    try {
      this.sender.sendDiagnosticMessage(this.sa, ta, bytes);
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError('E_TXN_REQUEST_INVALID', String(err));
      this.transition(txn, 'CANCELLED', `写出失败：${appErr.message}`);
      this.finalize(txn, false, appErr.code);
      return promise;
    }
    // 帧已发出 → Trace 条目已生成 → 取其 seq（§3.12：seq 只由 EventBus 分配）
    txn.seqRequest = this.seqSource.next();
    txn.requestAtMs = this.now();

    if (req.expectResponse === false) {
      this.transition(txn, 'COMPLETED', '已发送（按请求未等待响应）');
      this.finalize(txn, true, null);
      return promise;
    }

    this.transition(txn, 'WAITING_ACK');
    this.armAckTimer(txn);
    return promise;
  }

  /* ─────────────── 收帧回调（由 DoipSession/DoipClient 驱动） ─────────────── */

  onDiagnosticMessageAck(payload: DiagnosticMessageAckPayload, seq: number): void {
    const key = keyOf(payload.sourceAddress, payload.targetAddress);
    const txn = this.resolvePending(payload.sourceAddress, payload.targetAddress, (t) => t.state === 'WAITING_ACK');
    if (txn === null) {
      this.warn('E_TXN_UNMATCHED_ACK', null, `收到无法配对的 0x8002 ACK（${key}）`);
      return;
    }
    txn.seqAck = seq;
    txn.gatewayForwardLatencyMs = this.elapsedSinceRequest(txn);
    this.clearTimer(txn, 'ack');

    if (!previousMessageMatches(payload.previousMessage, txn.requestUdsBytes)) {
      this.warn('E_TXN_ACK_PREVIOUS_MISMATCH', txn.txnId, 'ACK 回显与本端请求不一致，已按 FIFO 继续配对');
    }

    if (txn.suppressPositiveResponse) {
      this.transition(txn, 'SUPPRESSED', '抑制正响应：网关已收下（0x8002），不等待正响应');
      this.armSuppressedWindow(txn);
      return;
    }
    this.transition(txn, 'WAITING_UDS_RESPONSE');
    if (txn.addressing === 'functional') this.armFunctionalWindow(txn);
    else this.armP2(txn);
  }

  onDiagnosticMessageNack(payload: DiagnosticMessageNackPayload, seq: number): void {
    const key = keyOf(payload.sourceAddress, payload.targetAddress);
    const txn = this.resolvePending(payload.sourceAddress, payload.targetAddress, (t) => t.state === 'WAITING_ACK');
    if (txn === null) {
      this.warn('E_TXN_UNMATCHED_ACK', null, `收到无法配对的 0x8003 NACK（${key}）`);
      return;
    }
    txn.seqNack = seq;
    txn.nackCode = payload.nackCode;
    const desc = describeCode(FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES, payload.nackCode);
    txn.nackNameZh = desc.nameZh;
    txn.latencyMs = this.elapsedSinceRequest(txn);
    this.clearTimer(txn, 'ack');
    // ★明确不查 NRC 表：NACK 是网关层结论，与 UDS 层的 NRC 无关
    this.transition(txn, 'FAILED_NACK', `网关未转发（非 UDS 层错误）：${desc.nameZh}`);
    this.finalize(txn, false, 'E_TXN_NACK');
  }

  onDiagnosticMessage(payload: DiagnosticMessagePayload, seq: number): void {
    const userData = payload.userData;
    const txn = this.resolvePending(
      payload.sourceAddress,
      payload.targetAddress,
      (t) => t.state === 'WAITING_UDS_RESPONSE' || t.state === 'WAITING_PENDING' || t.state === 'SUPPRESSED',
      userData,
    );
    if (txn === null) {
      this.emit({ kind: 'unsolicited', sa: payload.sourceAddress, ta: payload.targetAddress, userData, seq });
      return;
    }

    // ① 负响应 7F <reqSid> <nrc>
    if (isNegativeResponse(userData) && negativeResponseSid(userData) === txn.sid) {
      const nrc = nrcOf(userData);
      if (nrc === null) return;
      if (nrc === NRC_RESPONSE_PENDING) {
        this.clearTimer(txn, 'p2');
        this.transition(txn, 'WAITING_PENDING', 'ECU 返回 NRC 0x78（pending），转入 P2* 续等');
        this.armP2Star(txn);
        return;
      }
      const desc = describeCode(FALLBACK_NRC_TABLE, nrc);
      txn.nrc = nrc;
      txn.nrcNameZh = desc.nameZh;
      txn.latencyMs = this.elapsedSinceRequest(txn);
      txn.seqResponses.push(seq);
      txn.responseHex = formatHex(userData);
      if (txn.addressing === 'functional') {
        txn.functionalResponses.push({
          sa: payload.sourceAddress,
          seq,
          nrc,
          atMs: this.now(),
          hex: formatHex(userData),
        });
        return; // 等聚合窗口结束
      }
      if (txn.state === 'SUPPRESSED') {
        this.finalize(txn, false, null, `抑制正响应期间收到 NRC：${desc.nameZh}(${formatCode(nrc)})`);
        return;
      }
      this.transition(txn, 'COMPLETED', `ECU 返回负响应：${desc.nameZh}(${formatCode(nrc)})`);
      this.finalize(txn, false, null);
      return;
    }

    // ② 正响应
    if (isPositiveResponseFor(userData, txn.expectedPositiveSid)) {
      txn.seqResponses.push(seq);
      txn.responseHex = formatHex(userData);
      txn.latencyMs = txn.latencyMs ?? this.elapsedSinceRequest(txn);
      if (txn.addressing === 'functional') {
        txn.functionalResponses.push({
          sa: payload.sourceAddress,
          seq,
          nrc: null,
          atMs: this.now(),
          hex: formatHex(userData),
        });
        return; // 功能寻址：窗口结束再汇总
      }
      this.clearTimer(txn, 'p2');
      this.clearTimer(txn, 'p2star');
      this.transition(txn, 'COMPLETED', 'ECU 返回正响应');
      this.finalize(txn, true, null);
      return;
    }

    // ③ 既非期望正响应也非本事务负响应 → 无法归属
    this.warn(
      'E_TXN_UNMATCHED_ACK',
      txn.txnId,
      `收到无法归属到事务 ${txn.txnId} 的 0x8001（首字节 ${formatCode(userData[0] ?? 0)}）`,
    );
  }

  /** 连接断开：所有非终态事务 → CANCELLED，并清全部 timer */
  onSessionClosed(reason: string): void {
    let cancelled = 0;
    for (const txn of this.byId.values()) {
      if (isTerminalState(txn.state)) continue;
      this.clearAllTimers(txn);
      this.transition(txn, 'CANCELLED', `连接断开：${reason}`);
      this.finalize(txn, false, 'E_TXN_CANCELLED');
      cancelled += 1;
    }
    this.pending.clear();
    if (cancelled > 0) {
      this.log.info('连接断开，事务已取消', { reason, cancelled });
    }
  }

  /** 释放所有资源（进程退出前调用，确保无悬挂 timer） */
  dispose(): void {
    this.onSessionClosed('dispose');
    for (const waiter of this.waiters.values()) {
      waiter.resolve({
        ok: false,
        txnId: '',
        state: 'CANCELLED',
        errorCode: 'E_TXN_CANCELLED',
        note: '事务管理器已释放',
      });
    }
    this.waiters.clear();
    this.byId.clear();
  }

  /* ─────────────── 计时器 ─────────────── */

  private armAckTimer(txn: Transaction): void {
    this.clearTimer(txn, 'ack');
    const ms = getTiming('ACK_WAIT_TIMEOUT_MS');
    txn.timers.ack = setTimeout(() => {
      txn.timers.ack = null;
      this.clearAllTimers(txn);
      // ★"网关没收下"：与 FAILED_UDS_TIMEOUT 严格区分
      this.transition(
        txn,
        'FAILED_ACK_TIMEOUT',
        `网关未在 ${ms}ms 内返回 ACK/NACK，请求可能未进入网关`,
      );
      this.finalize(txn, false, 'E_TXN_ACK_TIMEOUT');
    }, ms);
  }

  private armP2(txn: Transaction): void {
    this.clearTimer(txn, 'p2');
    const ms = txn.p2TimeoutMs ?? getTiming('P2_CLIENT_MS');
    txn.timers.p2 = setTimeout(() => {
      txn.timers.p2 = null;
      this.clearAllTimers(txn);
      // ★"网关已转发但 ECU 未回"
      this.transition(
        txn,
        'FAILED_UDS_TIMEOUT',
        `网关已收下并转发（收到 0x8002 ACK），但 ECU 在 ${ms}ms 内未响应`,
      );
      this.finalize(txn, false, 'E_TXN_UDS_TIMEOUT');
    }, ms);
  }

  private armP2Star(txn: Transaction): void {
    this.clearTimer(txn, 'p2star');
    const ms = txn.p2StarTimeoutMs ?? getTiming('P2_STAR_CLIENT_MS');
    txn.timers.p2star = setTimeout(() => {
      txn.timers.p2star = null;
      this.clearAllTimers(txn);
      this.transition(
        txn,
        'FAILED_UDS_TIMEOUT',
        `ECU 持续返回 NRC 0x78 pending，P2*(${ms}ms) 内未给出最终响应`,
      );
      this.finalize(txn, false, 'E_TXN_UDS_TIMEOUT');
    }, ms);
  }

  private armFunctionalWindow(txn: Transaction): void {
    this.clearTimer(txn, 'functional');
    const ms = getTiming('FUNCTIONAL_AGGREGATION_WINDOW_MS');
    txn.timers.functional = setTimeout(() => {
      txn.timers.functional = null;
      this.clearAllTimers(txn);
      const n = txn.functionalResponses.length;
      if (n === 0) {
        this.transition(
          txn,
          'FAILED_UDS_TIMEOUT',
          `功能寻址聚合窗口 ${ms}ms 内未收到任何响应（网关已 ACK 转发）`,
        );
        this.finalize(txn, false, 'E_TXN_UDS_TIMEOUT');
        return;
      }
      const nrcCount = txn.functionalResponses.filter((r) => r.nrc !== null).length;
      this.transition(
        txn,
        'COMPLETED',
        `功能寻址聚合完成：${n} 条响应（按 SA 分组），其中负响应 ${nrcCount} 条`,
      );
      this.finalize(txn, true, null);
    }, ms);
  }

  /** 抑制正响应后的 NRC 观察窗（B5） */
  private armSuppressedWindow(txn: Transaction): void {
    this.clearTimer(txn, 'suppressed');
    const ms = getTiming('SUPPRESSED_NRC_WINDOW_MS');
    txn.timers.suppressed = setTimeout(() => {
      txn.timers.suppressed = null;
      this.clearAllTimers(txn);
      this.finalize(txn, true, null, txn.note ?? '抑制正响应：网关已 ACK，观察窗内无 NRC');
    }, ms);
  }

  private clearTimer(txn: Transaction, which: keyof Transaction['timers']): void {
    const timer = txn.timers[which];
    if (timer !== null) {
      clearTimeout(timer);
      txn.timers[which] = null;
    }
  }

  private clearAllTimers(txn: Transaction): void {
    this.clearTimer(txn, 'ack');
    this.clearTimer(txn, 'p2');
    this.clearTimer(txn, 'p2star');
    this.clearTimer(txn, 'functional');
    this.clearTimer(txn, 'suppressed');
  }

  /* ─────────────── 状态迁移与终态处理 ─────────────── */

  private transition(txn: Transaction, next: TxnState, note?: string | null): void {
    const from = txn.state;
    if (isTerminalState(from) && next !== from) {
      this.warn('E_TXN_INVALID_STATE', txn.txnId, `非法状态迁移 ${from} → ${next}，已忽略`);
      return;
    }
    txn.state = next;
    txn.stateEnteredAtMs = this.now();
    if (note !== null && note !== undefined) txn.note = note;
    this.emit({ kind: 'state', txn, from, to: next });
  }

  private finalize(
    txn: Transaction,
    ok: boolean,
    errorCode: string | null,
    note?: string | null,
  ): void {
    this.clearAllTimers(txn);
    if (errorCode !== null) txn.errorCode = errorCode;
    if (note !== null && note !== undefined) txn.note = note;
    this.removePending(txn);
    this.completed.push(txn);
    if (this.completed.length > LIMITS.TXN_COMPLETED_RING_SIZE) this.completed.shift();
    const waiter = this.waiters.get(txn.txnId);
    this.waiters.delete(txn.txnId);
    waiter?.resolve(this.toResult(txn, ok));
  }

  private toResult(txn: Transaction, ok: boolean): SendUdsResult {
    const result: SendUdsResult = { ok, txnId: txn.txnId, state: txn.state };
    if (txn.responseHex !== null) result.responseHex = txn.responseHex;
    if (txn.nrc !== null) {
      result.nrc = txn.nrc;
      if (txn.nrcNameZh !== null) result.nrcNameZh = txn.nrcNameZh;
    }
    if (txn.nackCode !== null) {
      result.nackCode = txn.nackCode;
      if (txn.nackNameZh !== null) result.nackNameZh = txn.nackNameZh;
    }
    if (txn.latencyMs !== null) result.latencyMs = txn.latencyMs;
    if (txn.gatewayForwardLatencyMs !== null) result.gatewayForwardLatencyMs = txn.gatewayForwardLatencyMs;
    if (txn.errorCode !== null) result.errorCode = txn.errorCode;
    if (txn.note !== null) result.note = txn.note;
    if (txn.functionalResponses.length > 0) {
      result.functionalResponses = txn.functionalResponses.map((r) => ({
        sa: r.sa,
        hex: r.hex,
        nrc: r.nrc,
      }));
    }
    return result;
  }

  /* ─────────────── pending 队列 ─────────────── */

  private pendingKeyFor(txn: Transaction): string {
    return keyOf(txn.ta, txn.sa);
  }

  private findPending(key: string, predicate: (t: Transaction) => boolean): Transaction | null {
    const queue = this.pending.get(key);
    if (queue === undefined) return null;
    for (const txn of queue) {
      if (predicate(txn)) return txn;
    }
    return null;
  }

  /**
   * ★功能寻址：一条请求会收到多个 ECU（不同 SA）的响应，
   *   精确键（ta->sa）必然匹配不上，需跨队列按"响应收件人 == 本端 SA"查找。
   *
   * ★并发多条功能寻址事务时**不得只按 FIFO**——否则后发事务的响应会被错配到先发的事务上。
   *   先按"报文语义归属"挑（正响应 SID / 负响应 SID 对得上），挑不到才回落到 FIFO。
   */
  private findPendingFunctional(
    payloadTargetAddress: number,
    predicate: (t: Transaction) => boolean,
    userData?: Uint8Array,
  ): Transaction | null {
    let fallback: Transaction | null = null;
    for (const queue of this.pending.values()) {
      for (const txn of queue) {
        if (txn.addressing !== 'functional') continue;
        if (txn.sa !== payloadTargetAddress) continue;
        if (!predicate(txn)) continue;
        if (userData !== undefined && this.messageBelongsTo(txn, userData)) return txn;
        if (fallback === null) fallback = txn;
      }
    }
    return fallback;
  }

  /** 该 userData 在语义上是否属于这个事务（正响应 SID 或负响应 SID 对得上） */
  private messageBelongsTo(txn: Transaction, userData: Uint8Array): boolean {
    if (isPositiveResponseFor(userData, txn.expectedPositiveSid)) return true;
    return isNegativeResponse(userData) && negativeResponseSid(userData) === txn.sid;
  }

  private resolvePending(
    payloadSa: number,
    payloadTa: number,
    predicate: (t: Transaction) => boolean,
    userData?: Uint8Array,
  ): Transaction | null {
    const exact = this.findPending(keyOf(payloadSa, payloadTa), predicate);
    if (exact !== null) return exact;
    return this.findPendingFunctional(payloadTa, predicate, userData);
  }

  private removePending(txn: Transaction): void {
    const key = this.pendingKeyFor(txn);
    const queue = this.pending.get(key);
    if (queue === undefined) return;
    const idx = queue.indexOf(txn);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.pending.delete(key);
  }

  /** send() 后把事务挂到"响应方向"队列上 */
  private enqueuePending(txn: Transaction): void {
    const key = this.pendingKeyFor(txn);
    const queue = this.pending.get(key);
    if (queue === undefined) this.pending.set(key, [txn]);
    else queue.push(txn);
  }

  private elapsedSinceRequest(txn: Transaction): number {
    return this.now() - (txn.requestAtMs ?? txn.createdAtMs);
  }

  private warn(code: string, txnId: string | null, messageZh: string): void {
    if (txnId !== null) {
      const txn = this.byId.get(txnId);
      if (txn !== undefined && !txn.warnCodes.includes(code)) txn.warnCodes.push(code);
    }
    this.log.warn(messageZh, { code, txnId });
    this.emit({ kind: 'warn', code, txnId, messageZh });
  }

  private emit(event: TxnEvent): void {
    this.onEvent?.(event);
  }
}
