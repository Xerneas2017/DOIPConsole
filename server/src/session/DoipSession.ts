/**
 * 单条 DoIP 会话（§3.8）：socket + 分帧器 + 事务管理器 + 3E 调度 + UDS 会话追踪 的组合体。
 *
 * ★难点 3：连仿真与连真实共用本类，差异只在 ConnectConfig 的 host/port/mode。
 * ★Q1：本类不含自动重连 / 自动重发；断线只做状态上报，重激活由上层显式调用。
 * ★无悬挂 timer：`dispose()` 会关掉 client、事务管理器与 3E 调度器。
 */

import {
  DOIP_DEFAULTS,
  formatCode,
  formatLogicalAddress,
  nowEpochMs,
  nowMonoMs,
  parseHex,
  parseLogicalAddress,
} from '@doip/shared';
import type {
  ConnectConfig,
  DiagnosticMessageAckPayload,
  DiagnosticMessageNackPayload,
  DiagnosticMessagePayload,
  DoipFrame,
  SendUdsRequest,
  SendUdsResult,
  SessionStatus,
} from '@doip/shared';
import { DoipClient } from '../doip/DoipClient';
import type { DoipClientOptions } from '../doip/DoipClient';
import { TransactionManager, buildUdsRequestBytes } from '../txn/TransactionManager';
import type { TxnEvent, TxnSeqSource } from '../txn/TransactionManager';
import { AppError, fromNodeError, toAppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getTiming } from '../config/defaults';
import { SessionStateMachine } from './SessionStateMachine';
import { TesterPresentScheduler } from './TesterPresentScheduler';
import { UdsSessionTracker } from './UdsSessionTracker';

export interface DoipSessionFrameContext {
  sessionId: string;
  /** '127.0.0.1:13400' */
  peer: string;
  transport: 'TCP' | 'UDP';
  direction: 'TX' | 'RX';
  /**
   * 本次发送携带的业务标签（如 `周期3E`）。
   * ★只有**发送方主动标注**的才打标签：手动发一条 3E 00 不应被算作"周期 3E"。
   */
  tag?: string | null;
  /**
   * ★D-05：`tsRelMs` 的基准（epoch ms）= **本次连接建立的时刻**。
   *   后端进程启动时刻毫无意义（进程可能挂机一整晚，第一条报文的相对时间就是几万秒），
   *   基准必须是"连上的那一刻"；重连后重新起算。
   */
  sessionStartMs?: number;
  /**
   * ★本结构**不含 seq**：seq 由 `EventBus.publishTrace()` 统一分配（§3.12），
   *   通过 `onFrame()` 的返回值回传给会话层，避免"一条帧分配两个号"导致断号。
   */
}

export interface DoipSessionOptions {
  sessionId?: string;
  /** 全局 seq 兜底分配器（仅在**没有** Trace 出口时使用；正常链路用 EventBus 返回值） */
  seqSource?: TxnSeqSource;
  /**
   * 每帧回调（Trace 摄入入口）。
   * @returns 该帧 Trace 条目的实际 seq（由 EventBus 分配）；没有出口时返回 0
   */
  onFrame?: (frame: DoipFrame, ctx: DoipSessionFrameContext) => number;
  onStatus?: (status: SessionStatus) => void;
  onError?: (error: AppError) => void;
  onTxnEvent?: (event: TxnEvent) => void;
  client?: Partial<DoipClientOptions>;
}

/** 会话计数器（与 §3.7 SessionStatus.counters 一致） */
interface Counters {
  tx: number;
  rx: number;
  errors: number;
  traceCount: number;
}

export class DoipSession {
  readonly sessionId: string;
  readonly state: SessionStateMachine;
  readonly tracker: UdsSessionTracker;
  readonly testerPresent: TesterPresentScheduler;
  readonly txns: TransactionManager;

  private readonly log = getLogger('session');
  private readonly client: DoipClient;
  private readonly seqSource: TxnSeqSource;
  private readonly onFrame?: (frame: DoipFrame, ctx: DoipSessionFrameContext) => void;
  private readonly onStatus?: (status: SessionStatus) => void;
  private readonly onError?: (error: AppError) => void;
  private readonly onTxnEvent?: (event: TxnEvent) => void;

  private readonly counters: Counters = { tx: 0, rx: 0, errors: 0, traceCount: 0 };
  private fallbackSeq = 0;
  private peer: { host: string; port: number; mode: 'real' | 'sim' } | null = null;
  private lastRoutingCode: number | null = null;
  private lastRoutingCodeZh: string | null = null;
  private lastRttMs: number | null = null;
  /** 本次发送携带的业务标签（供下一帧 TX 消费） */
  private pendingTag: string | null = null;
  /** 最近一帧 Trace 条目的 seq（由 EventBus 分配后回填，供事务记录引用真实条目） */
  private lastPublishedSeq = 0;
  private lastActivateAtMs = 0;
  private disposed = false;
  /**
   * ★D-05：本次连接的起点（epoch ms）。
   * 构造时先取当下（保证任何帧都有一个基准），真正 `connect()` 时重置为连上那一刻。
   */
  private sessionStartedAtMs = nowEpochMs();

  constructor(options: DoipSessionOptions = {}) {
    this.sessionId = options.sessionId ?? 'default';
    this.seqSource = options.seqSource ?? {
      next: () => {
        this.fallbackSeq += 1;
        return this.fallbackSeq;
      },
    };
    if (options.onFrame !== undefined) this.onFrame = options.onFrame;
    if (options.onStatus !== undefined) this.onStatus = options.onStatus;
    if (options.onError !== undefined) this.onError = options.onError;
    if (options.onTxnEvent !== undefined) this.onTxnEvent = options.onTxnEvent;

    this.state = new SessionStateMachine({
      initial: 'DISCONNECTED',
      onError: (err) => this.reportError(err),
    });
    this.tracker = new UdsSessionTracker();

    const clientOptions: DoipClientOptions = {
      protocolVersion: options.client?.protocolVersion ?? DOIP_DEFAULTS.PROTOCOL_VERSION,
      activationType: options.client?.activationType ?? DOIP_DEFAULTS.ACTIVATION_TYPE_DEFAULT,
      onFrame: (frame, direction) => this.handleFrame(frame, direction),
      onAck: (payload) => this.handleAck(payload),
      onNack: (payload) => this.handleNack(payload),
      onDiagnosticMessage: (payload) => this.handleDiagnosticMessage(payload),
      onGenericHeaderNack: (nackCode) => {
        this.reportError(new AppError('E_DOIP_HEADER_NACK', undefined, { detail: { nackCode } }));
      },
      onClose: (reason) => this.handleClose(reason),
      onError: (err) => this.reportError(err),
    };
    // exactOptionalPropertyTypes：只在显式提供时才写入这两个可选字段
    if (options.client?.factory !== undefined) clientOptions.factory = options.client.factory;
    if (options.client?.frameReader !== undefined) clientOptions.frameReader = options.client.frameReader;
    this.client = new DoipClient(clientOptions);

    this.txns = new TransactionManager({
      sender: {
        sendDiagnosticMessage: (sa, ta, ud) => this.client.sendDiagnosticMessage(sa, ta, ud),
      },
      sa: DOIP_DEFAULTS.TESTER_LOGICAL_ADDRESS,
      ta: DOIP_DEFAULTS.FUNCTIONAL_ADDRESS,
      sessionId: this.sessionId,
      // ★seq 用"最近一帧已发布的 seq"：事务记录指向真实 Trace 条目，不再另起一套计数
      seqSource: { next: () => this.lastPublishedSeq },
      onEvent: (event) => this.handleTxnEvent(event),
    });

    this.testerPresent = new TesterPresentScheduler({
      send: () => this.sendTesterPresent(),
      onTick: () => this.emitStatus(),
    });
  }

  /* ─────────────── 连接生命周期 ─────────────── */

  isConnected(): boolean {
    return this.client.isConnected();
  }

  get status(): SessionStatus {
    return this.buildStatus();
  }

  get clientRef(): DoipClient {
    return this.client;
  }

  /** 会话起点（epoch ms），用于 TraceEntry.tsRelMs 计算 */
  get startedAtMs(): number {
    return this.sessionStartedAtMs;
  }

  /** 建 TCP 连接 → 路由激活；任一步失败都进入 ERROR（★不自动重连） */
  async connect(cfg: ConnectConfig): Promise<SessionStatus> {
    // ★D-05：相对时间基准 = 本次连接建立的时刻（重连重新起算）
    this.sessionStartedAtMs = nowEpochMs();
    this.state.transition('TCP_CONNECTING', `连接 ${cfg.host}:${cfg.port}`);
    this.emitStatus();
    const ta = parseLogicalAddress(cfg.ta);
    this.txns.setAddresses(this.client.sa, ta);
    try {
      await this.client.connect(cfg);
      this.peer = { host: cfg.host, port: cfg.port, mode: cfg.mode };
      this.tracker.reset('new-connection');
      this.state.transition('TCP_CONNECTED', 'TCP 已建立');
      this.emitStatus();
      await this.activateRouting();
    } catch (err) {
      const appErr = err instanceof AppError ? err : fromNodeError(err, 'E_CONN_REFUSED');
      this.state.transition('ERROR', appErr.message);
      this.reportError(appErr);
      throw appErr;
    }
    return this.buildStatus();
  }

  /** ★Q1 唯一允许的"重发"：同一 socket 上重发 0x0005，由用户显式触发 */
  async reactivate(): Promise<SessionStatus> {
    if (!this.client.isConnected()) {
      throw new AppError('E_CONN_NOT_CONNECTED', '尚未建立 TCP 连接，无法重激活路由');
    }
    const minInterval = getTiming('ROUTING_REACTIVATE_MIN_INTERVAL_MS');
    const elapsed = nowMonoMs() - this.lastActivateAtMs;
    if (this.lastActivateAtMs > 0 && elapsed < minInterval) {
      this.log.warn('重激活过于频繁', { elapsedMs: Math.round(elapsed), minIntervalMs: minInterval });
    }
    this.state.transition('ROUTING_ACTIVATING', '手动重激活');
    this.emitStatus();
    await this.activateRouting();
    return this.buildStatus();
  }

  /** ★Q4：切换目标地址不重建连接（DoIP 路由激活是针对 socket 而非 TA 的） */
  setTargetAddress(ta: number): void {
    const { sa } = this.txns.getAddresses();
    this.client.ta = ta;
    this.txns.setAddresses(sa, ta);
    this.log.info('目标地址已切换', { ta: formatLogicalAddress(ta) });
    this.emitStatus();
  }

  setTesterPresent(enabled: boolean, periodMs?: number): void {
    if (enabled) this.testerPresent.start(periodMs);
    else this.testerPresent.stop();
    this.emitStatus();
  }

  /** 唯一的 UDS 发送入口（★Q6） */
  async sendUds(req: SendUdsRequest): Promise<SendUdsResult> {
    if (!this.client.isConnected()) {
      throw new AppError('E_CONN_NOT_CONNECTED', '尚未建立连接，无法发送 UDS 请求');
    }
    const bytes = buildUdsRequestBytes(req);
    const sid = bytes[0] ?? 0;
    const sub = bytes.length > 1 ? (bytes[1] ?? null) : null;
    this.tracker.observeRequest(sid, sub);
    this.counters.tx += 1;
    this.testerPresent.notifyActivity();
    // ★把本次请求的业务标签带给"紧接着发出的那一帧"（单会话串行发送，语义明确）
    this.pendingTag = req.tag ?? null;

    const result = await this.txns.send(req);
    if (result.latencyMs !== undefined) this.lastRttMs = result.latencyMs;
    if (result.errorCode !== null && result.errorCode !== undefined) {
      this.counters.errors += 1;
    }
    if (result.responseHex !== undefined) {
      const resp = parseHex(result.responseHex);
      const responseSid = resp[0] ?? 0;
      if (responseSid !== 0x7f && responseSid > 0x40) {
        this.tracker.observePositiveResponse(responseSid, resp.length > 1 ? (resp[1] ?? null) : null);
      }
    }
    if (result.nrc !== undefined) {
      this.tracker.observeNegativeResponse(sid);
    }
    this.emitStatus();
    return result;
  }

  /** 断开连接（同步关闭 socket，异步部分由 DoipClient 的 close 事件收尾） */
  disconnect(reason = 'user-disconnect'): void {
    this.testerPresent.stop();
    this.state.transition('CLOSING', reason);
    this.client.close(reason);
    this.txns.onSessionClosed(reason);
    this.tracker.reset('disconnected');
    this.state.transition('CLOSED', reason);
    this.state.transition('DISCONNECTED', reason);
    this.peer = null;
    this.emitStatus();
  }

  /** 释放全部资源（★保证进程可自行退出） */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.testerPresent.dispose();
    if (this.client.isConnected()) this.client.close('dispose');
    this.txns.dispose();
  }

  /* ─────────────── 内部实现 ─────────────── */

  private async activateRouting(): Promise<void> {
    this.state.transition('ROUTING_ACTIVATING', '发送 0x0005');
    this.emitStatus();
    try {
      const res = await this.client.sendRoutingActivation();
      this.lastActivateAtMs = nowMonoMs();
      this.lastRoutingCode = res.code;
      this.lastRoutingCodeZh = res.codeNameZh;
      this.lastRttMs = res.latencyMs;
      // 0x11（需确认）停在 ROUTING_ACTIVATING；其余一律视为已激活（成功与否由 code 表达）
      if (res.code === 0x11) {
        this.state.transition('ROUTING_ACTIVATING', '路由激活需确认（0x11），保持原态');
        this.reportError(new AppError('E_ROUTING_CONFIRM_REQUIRED'));
      } else {
        this.state.transition('ROUTING_ACTIVE', `路由激活响应 ${formatCode(res.code)}`);
      }
    } catch (err) {
      const appErr = err instanceof AppError ? err : toAppError(err, 'E_ROUTING_TIMEOUT');
      this.state.transition('ERROR', appErr.message);
      throw appErr;
    }
    this.emitStatus();
  }

  private async sendTesterPresent(): Promise<boolean> {
    try {
      const result = await this.sendUds({
        addressing: 'physical',
        sid: '0x3E',
        subFunction: '0x80',
        expectResponse: false,
        tag: '周期3E',
      });
      return result.ok;
    } catch (err) {
      this.log.warn('周期 3E 发送失败', { message: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private handleFrame(frame: DoipFrame, direction: 'TX' | 'RX'): void {
    if (direction === 'RX') this.counters.rx += 1;
    this.counters.traceCount += 1;
    const peer = this.peerString();
    // ★seq 由 EventBus 在 publishTrace 时统一分配：此处只接收返回值，绝不另行分配（否则断号）
    const tag = direction === 'TX' ? this.pendingTag : null;
    if (direction === 'TX') this.pendingTag = null;
    const published =
      this.onFrame?.(frame, {
        sessionId: this.sessionId,
        peer,
        transport: 'TCP',
        direction,
        ...(tag === null ? {} : { tag }),
        sessionStartMs: this.sessionStartedAtMs,
      }) ?? 0;
    this.lastPublishedSeq = published > 0 ? published : this.seqSource.next();
  }

  private handleAck(payload: DiagnosticMessageAckPayload): void {
    this.txns.onDiagnosticMessageAck(payload, this.lastPublishedSeq);
  }

  private handleNack(payload: DiagnosticMessageNackPayload): void {
    this.txns.onDiagnosticMessageNack(payload, this.lastPublishedSeq);
  }

  private handleDiagnosticMessage(payload: DiagnosticMessagePayload): void {
    this.txns.onDiagnosticMessage(payload, this.lastPublishedSeq);
  }

  private handleClose(reason: string): void {
    this.testerPresent.stop();
    this.txns.onSessionClosed(reason);
    this.tracker.reset('closed');
    this.state.force('DISCONNECTED', reason);
    this.peer = null;
    this.emitStatus();
    this.log.info('会话已断开', { reason });
  }

  private handleTxnEvent(event: TxnEvent): void {
    if (event.kind === 'warn') {
      this.reportError(new AppError(event.code, event.messageZh, { severity: 'warn' }));
    }
    this.onTxnEvent?.(event);
  }

  private reportError(error: AppError): void {
    this.counters.errors += 1;
    this.log.warn(error.message, { code: error.code });
    this.onError?.(error);
    this.emitStatus();
  }

  private peerString(): string {
    if (this.peer !== null) return `${this.peer.host}:${this.peer.port}`;
    const p = this.client.peer;
    return p === null ? '' : `${p.host}:${p.port}`;
  }

  private emitStatus(): void {
    this.onStatus?.(this.buildStatus());
  }

  private buildStatus(): SessionStatus {
    const { sa, ta } = this.txns.getAddresses();
    return {
      sessionId: this.sessionId,
      state: this.state.state,
      stateSinceMs: Math.round(this.state.stateSinceMs),
      peer: this.peer,
      sa,
      ta,
      activationType: this.client.activationType,
      protocolVersion: this.client.protocolVersion,
      lastRoutingCode: this.lastRoutingCode,
      lastRoutingCodeZh: this.lastRoutingCodeZh,
      udsSession: this.tracker.session,
      securityLevels: this.tracker.securityLevels,
      s3RemainingMs: this.testerPresent.getS3RemainingMs(),
      testerPresent: {
        enabled: this.testerPresent.enabled,
        periodMs: this.testerPresent.periodMs,
        nextDueMs: this.testerPresent.nextDueMs,
      },
      counters: { ...this.counters },
      lastRttMs: this.lastRttMs,
    };
  }
}
