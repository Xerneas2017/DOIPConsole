/**
 * QA-M1 独立验证套件（QA 严过关 / Yan）—— 不是对现有 93 个用例的重复，
 * 而是针对「测试通过但代码可能不正确」的补充攻击面。
 *
 * 覆盖（对应项目组给的六个方向）：
 *   QA-F*  分帧状态机的病态输入与恢复性（现有 TC-F01~F12 未覆盖的分支）
 *   QA-T*  三方事务配对的正确性（延迟打点、并发错配、NACK 文案、悬挂 timer）
 *   QA-S*  仿真 ECU 是否真的是真 socket + 字节级 ISO 13400-2 符合性
 *   QA-P*  协议码表与标准的符合性抽查
 *
 * ★说明：名字以 `[QA-BUG-xx]` 开头的用例是**故意让它红**的缺陷证据，
 *   它们断言的是标准/设计要求的正确行为，实现不达标就会失败。
 *   修好后应当转绿。其余用例必须全绿。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import dgram from 'node:dgram';

import { DoipFrameReader } from '../doip/DoipFrameReader';
import type { FrameReaderError, FrameReaderOptions } from '../doip/DoipFrameReader';
import { DoipHeaderCodec } from '../doip/DoipHeaderCodec';
import { DoipPayloadCodec } from '../doip/DoipPayloadCodec';
import { TransactionManager } from '../txn/TransactionManager';
import type { TxnEvent, TxnSender } from '../txn/TransactionManager';
import { SimEcuRuntime } from '../sim/SimEcuRuntime';

import {
  LIMITS,
  PayloadType,
  TIMING,
  FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES,
  lookupCodeEntry,
  parseHex,
} from '@doip/shared';
import type {
  DiagnosticMessageAckPayload,
  DiagnosticMessageNackPayload,
  DiagnosticMessagePayload,
  DoipFrame,
  SendUdsRequest,
  SendUdsResult,
} from '@doip/shared';

/* ═══════════════════════ 通用工具 ═══════════════════════ */

interface Harness {
  reader: DoipFrameReader;
  frames: DoipFrame[];
  errors: FrameReaderError[];
}

function makeReader(overrides: Partial<FrameReaderOptions> = {}): Harness {
  const frames: DoipFrame[] = [];
  const errors: FrameReaderError[] = [];
  const reader = new DoipFrameReader({
    maxPayloadBytes: LIMITS.MAX_PAYLOAD_BYTES,
    maxBufferBytes: LIMITS.MAX_FRAME_READER_BUFFER_BYTES,
    incompleteFrameTimeoutMs: TIMING.FRAME_ASSEMBLY_TIMEOUT_MS,
    versionPolicy: 'lenient',
    resyncOnDesync: false,
    onFrame: (f) => frames.push(f),
    onError: (e) => errors.push(e),
    ...overrides,
  });
  return { reader, frames, errors };
}

/** 造一帧（可指定 protocolVersion，用于构造 inverse 非法帧） */
function mkFrame(payloadType: number, payload: number[] | Uint8Array, pv = 0x02): Buffer {
  return DoipHeaderCodec.buildFrame(pv, payloadType, Uint8Array.from(payload));
}

/** 手工拼一个「头 8 字节 + 指定 payloadLength」（payload 可以不到齐） */
function rawHeader(
  payloadType: number,
  payloadLength: number,
  pv = 0x02,
  ipv: number | null = null,
): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt8(pv, 0);
  b.writeUInt8(ipv ?? (~pv & 0xff), 1);
  b.writeUInt16BE(payloadType, 2);
  b.writeUInt32BE(payloadLength >>> 0, 4);
  return b;
}

function eq(a: Uint8Array, b: Buffer | Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/* ═══════════════════════ ① 分帧状态机 ═══════════════════════ */

describe('QA-F 分帧状态机：边界与病态输入', () => {
  it('QA-F01 payloadLength 恰好等于上界 → 必须正常产出（不能误判超上限）', () => {
    const cap = 64;
    const h = makeReader({ maxPayloadBytes: cap, maxBufferBytes: 1 << 20 });
    const payload = Array.from({ length: cap }, (_, i) => i & 0xff);
    h.reader.push(Buffer.concat([rawHeader(PayloadType.DIAGNOSTIC_MESSAGE, cap), Buffer.from(payload)]));

    expect(h.errors).toHaveLength(0);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]?.header.payloadLength).toBe(cap);
    expect(Array.from(h.frames[0]?.payload ?? [])).toEqual(payload);
  });

  it('QA-F02 payloadLength 恰好越界 1 字节 → E_DOIP_PAYLOAD_TOO_LARGE 且停止', () => {
    const cap = 64;
    const h = makeReader({ maxPayloadBytes: cap, maxBufferBytes: 1 << 20 });
    h.reader.push(rawHeader(PayloadType.DIAGNOSTIC_MESSAGE, cap + 1));

    expect(h.frames).toHaveLength(0);
    expect(h.errors[0]?.code).toBe('E_DOIP_PAYLOAD_TOO_LARGE');
    expect(h.errors[0]?.recoverable).toBe(false);
    expect(h.reader.isHalted()).toBe(true);
  });

  it('QA-F03 头部逐字节喂入（8 次 onData 才凑齐头）后再逐字节喂 payload', () => {
    const h = makeReader();
    const payload = [0x0e, 0x00, 0x10, 0x00, 0x22, 0xf1, 0x90];
    const raw = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, payload);

    for (let i = 0; i < 8; i += 1) {
      h.reader.push(raw.subarray(i, i + 1));
      expect(h.frames).toHaveLength(0); // 头不全，绝不能产出
    }
    for (let i = 8; i < raw.length - 1; i += 1) {
      h.reader.push(raw.subarray(i, i + 1));
      expect(h.frames).toHaveLength(0);
    }
    h.reader.push(raw.subarray(raw.length - 1));
    expect(h.frames).toHaveLength(1);
    expect(eq(h.frames[0]?.raw ?? new Uint8Array(), raw)).toBe(true);
  });

  it('QA-F04 头到齐但 payload 永不到 → 超时报错、资源复位，且 reset() 后可恢复（不得永久卡死）', () => {
    let fakeNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);
    const h = makeReader({ incompleteFrameTimeoutMs: 5000 });

    h.reader.push(rawHeader(PayloadType.DIAGNOSTIC_MESSAGE, 100));
    expect(h.reader.pendingBytes()).toBe(8);

    fakeNow = 4999;
    h.reader.tick();
    expect(h.errors).toHaveLength(0);

    fakeNow = 5001;
    h.reader.tick();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('E_DOIP_INCOMPLETE_FRAME_TIMEOUT');
    expect(h.reader.isHalted()).toBe(true);
    // ★资源必须复位，否则 32 MiB 缓冲一直挂着
    expect(h.reader.pendingBytes()).toBe(0);
    expect(h.reader.isHalted()).toBe(true);

    // ★可恢复性：reset() 后必须能重新解析（连接复用场景）
    h.reader.reset();
    expect(h.reader.isHalted()).toBe(false);
    const ok = mkFrame(PayloadType.ALIVE_CHECK_REQ, []);
    h.reader.push(ok);
    expect(h.frames).toHaveLength(1);
    expect(h.errors).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('QA-F05 缓冲区上界触发后 reset() 必须能恢复（不是一触发就永久卡死）', () => {
    const h = makeReader({ maxBufferBytes: 4096, maxPayloadBytes: LIMITS.MAX_PAYLOAD_BYTES });
    h.reader.push(rawHeader(PayloadType.DIAGNOSTIC_MESSAGE, 100000));
    for (let i = 0; i < 40 && h.errors.length === 0; i += 1) {
      h.reader.push(Buffer.alloc(512, 0xaa));
    }
    expect(h.errors[0]?.code).toBe('E_DOIP_BUFFER_OVERFLOW');
    expect(h.reader.isHalted()).toBe(true);
    expect(h.reader.pendingBytes()).toBe(0);

    h.reader.reset();
    const ok = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, 0x3e, 0x80]);
    h.reader.push(ok);
    expect(h.frames).toHaveLength(1);
    expect(h.errors).toHaveLength(1);
  });

  it('QA-F06 ★raw 深拷贝：同一块 scratch Buffer 反复复用并在两次 push 之间改写内容', () => {
    const h = makeReader();
    const full = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, 0x22, 0xf1, 0x90]);
    // 用一块可复用的 scratch，模拟"调用方复用 Buffer"的高危写法
    const scratch = Buffer.alloc(full.length);
    full.copy(scratch);
    h.reader.push(scratch.subarray(0, 8));
    // ★两次 push 之间把 scratch 全部改写 —— 若 reader 持有引用则必然串数据
    scratch.fill(0xde);
    const tail = Buffer.from(full.subarray(8));
    h.reader.push(tail);

    expect(h.frames).toHaveLength(1);
    expect(eq(h.frames[0]?.raw ?? new Uint8Array(), full)).toBe(true);

    // 再灌大量数据强制压实 + 扩容，先前帧的 raw 仍不得被覆写
    const bulk = Buffer.concat(
      Array.from({ length: 300 }, () =>
        mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, Array.from({ length: 400 }, () => 0x5a)),
      ),
    );
    h.reader.push(bulk);
    expect(eq(h.frames[0]?.raw ?? new Uint8Array(), full)).toBe(true);
    expect(Array.from(h.frames[0]?.payload ?? [])).toEqual([0x0e, 0x00, 0x10, 0x00, 0x22, 0xf1, 0x90]);
  });

  it('QA-F07 lenient：inverse 非法**不得**停止解析，后续合法帧必须继续产出', () => {
    const h = makeReader({ versionPolicy: 'lenient' });
    const bad = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, 0x22], 0x02);
    bad.writeUInt8(0x00, 1); // inverse 非法
    const good = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, 0x3e]);

    h.reader.push(Buffer.concat([bad, good]));
    expect(h.errors).toHaveLength(0);
    expect(h.frames).toHaveLength(2);
    expect(h.frames[0]?.header.inverseVersionValid).toBe(false);
    expect(h.frames[1]?.header.inverseVersionValid).toBe(true);
    expect(h.reader.isHalted()).toBe(false);
  });

  it('QA-F08 strict：inverse 非法立即停，且后续字节不再产出帧', () => {
    const h = makeReader({ versionPolicy: 'strict' });
    const bad = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, 0x22], 0x02);
    bad.writeUInt8(0x00, 1);
    const good = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, 0x3e]);

    h.reader.push(Buffer.concat([bad, good]));
    expect(h.frames).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('E_DOIP_INVERSE_VERSION_INVALID');
    expect(h.reader.isHalted()).toBe(true);
  });

  it('QA-F09 resyncOnDesync=true：能丢弃垃圾字节并重新对齐（该分支现有 93 个用例未覆盖）', () => {
    const h = makeReader({ resyncOnDesync: true, versionPolicy: 'strict' });
    const garbage = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x01]);
    const good = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, 0x22, 0xf1, 0x90]);
    h.reader.push(Buffer.concat([garbage, good]));

    expect(h.frames).toHaveLength(1);
    expect(eq(h.frames[0]?.raw ?? new Uint8Array(), good)).toBe(true);
  });

  it('QA-F10 一 chunk 含 5 帧 + 尾部半帧，再补齐 → 顺序与边界均正确', () => {
    const h = makeReader();
    const parts = Array.from({ length: 5 }, (_, i) =>
      mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, i & 0xff]),
    );
    const tail = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE_ACK, [0x10, 0x00, 0x0e, 0x00, 0x00]);
    const chunk = Buffer.concat([...parts, tail.subarray(0, 3)]);
    h.reader.push(chunk);
    expect(h.frames).toHaveLength(5);
    h.reader.push(tail.subarray(3));
    expect(h.frames).toHaveLength(6);
    for (let i = 0; i < 5; i += 1) {
      expect(eq(h.frames[i]?.raw ?? new Uint8Array(), parts[i] ?? Buffer.alloc(0))).toBe(true);
    }
    expect(eq(h.frames[5]?.raw ?? new Uint8Array(), tail)).toBe(true);
  });

  it('QA-F11 缓冲区上界守卫实际由 ensureCapacity 触发（tryParseOne 内那条判据不可达）', () => {
    // 证据：溢出报错的文案来自 ensureCapacity（"需要 N 字节"），
    // 而不是 tryParseOne（"已 N 字节…仍未凑齐一帧"）。
    const h = makeReader({ maxBufferBytes: 4096, maxPayloadBytes: LIMITS.MAX_PAYLOAD_BYTES });
    h.reader.push(rawHeader(PayloadType.DIAGNOSTIC_MESSAGE, 100000));
    for (let i = 0; i < 40 && h.errors.length === 0; i += 1) {
      h.reader.push(Buffer.alloc(512, 0xaa));
      expect(h.reader.pendingBytes()).toBeLessThanOrEqual(4096);
    }
    expect(h.errors[0]?.code).toBe('E_DOIP_BUFFER_OVERFLOW');
    expect(h.errors[0]?.messageZh).toContain('需要');
    expect(h.errors[0]?.messageZh).not.toContain('仍未凑齐一帧');
  });
});

/* ═══════════════════════ ② 事务配对 ═══════════════════════ */

const SA = 0x0e00;
const TA = 0x1000;

class FakeSender implements TxnSender {
  readonly sent: Array<{ sa: number; ta: number; userData: Uint8Array }> = [];
  sendDiagnosticMessage(sa: number, ta: number, userData: Uint8Array): void {
    this.sent.push({ sa, ta, userData: Uint8Array.from(userData) });
  }
}

function ack(sa = TA, ta = SA, previous: Uint8Array = parseHex('1003')): DiagnosticMessageAckPayload {
  return { sourceAddress: sa, targetAddress: ta, ackCode: 0x00, previousMessage: previous };
}

function nack(sa = TA, ta = SA, code = 0x02, previous: Uint8Array = parseHex('1003')): DiagnosticMessageNackPayload {
  return { sourceAddress: sa, targetAddress: ta, nackCode: code, previousMessage: previous };
}

function diag(sa: number, ta: number, hex: string): DiagnosticMessagePayload {
  return { sourceAddress: sa, targetAddress: ta, userData: parseHex(hex) };
}

interface Ctx {
  sender: FakeSender;
  txns: TransactionManager;
  events: TxnEvent[];
  clock: { t: number };
}

function setupTxn(): Ctx {
  const sender = new FakeSender();
  const events: TxnEvent[] = [];
  const clock = { t: 1000 };
  const txns = new TransactionManager({
    sender,
    sa: SA,
    ta: TA,
    now: () => clock.t,
    onEvent: (e) => events.push(e),
  });
  return { sender, txns, events, clock };
}

function req(overrides: Partial<SendUdsRequest> = {}): SendUdsRequest {
  return { addressing: 'physical', sid: '0x10', subFunction: '0x03', ...overrides };
}

describe('QA-T 三方事务配对的正确性', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('QA-T01 ★latencyMs 与 gatewayForwardLatencyMs 必须在正确时刻分别打点（且前者 > 后者）', async () => {
    const { txns, clock } = setupTxn();
    void txns.send(req());
    await Promise.resolve();
    const t0 = clock.t;

    clock.t = t0 + 40; // ACK 到达：网关收下耗时 40ms
    txns.onDiagnosticMessageAck(ack(), 2);
    clock.t = t0 + 250; // UDS 响应到达：端到端 250ms
    txns.onDiagnosticMessage(diag(TA, SA, '5003003201F4'), 3);

    const txn = txns.getTransaction('tx-0001');
    expect(txn?.gatewayForwardLatencyMs).toBe(40);
    expect(txn?.latencyMs).toBe(250);
    // ★关键：两个数不得恒等，也不得反了
    expect((txn?.latencyMs ?? 0) > (txn?.gatewayForwardLatencyMs ?? 0)).toBe(true);
  });

  it('QA-T02 0x8003 全部 NACK 码（0x00..0x06）一律标注"网关未转发（非 UDS 层错误）"，且不查 NRC 表', () => {
    for (const code of [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]) {
      const { txns } = setupTxn();
      void txns.send(req());
      txns.onDiagnosticMessageNack(nack(TA, SA, code), 2);
      const txn = txns.getTransaction(`tx-0001`);
      expect(txn?.state).toBe('FAILED_NACK');
      expect(txn?.note ?? '').toContain('网关未转发（非 UDS 层错误）');
      expect(txn?.nrc).toBeNull(); // ★NACK 不得去查 NRC 表
      expect(txn?.nackCode).toBe(code);
      vi.clearAllTimers();
    }
  });

  it('QA-T03 [QA-BUG-02] 并发两条功能寻址事务时，响应不得被错配到先发的事务上', async () => {
    const { txns } = setupTxn();
    const p1 = txns.send({ addressing: 'functional', sid: '0x22', dids: ['0xF190'] });
    await Promise.resolve();
    const p2 = txns.send({ addressing: 'functional', sid: '0x19', subFunction: '0x02' });
    await Promise.resolve();

    txns.onDiagnosticMessageAck(ack(0x1fff, SA, parseHex('22F190')), 2);
    txns.onDiagnosticMessageAck(ack(0x1fff, SA, parseHex('1902')), 3);

    // 事务1 的响应（62 F190 ...）来自 0x1000 / 0x1010
    txns.onDiagnosticMessage(diag(0x1000, SA, '62F1904C53'), 4);
    txns.onDiagnosticMessage(diag(0x1010, SA, '62F1904D54'), 5);
    // 事务2 的响应（59 02 ...）来自 0x1020
    txns.onDiagnosticMessage(diag(0x1020, SA, '5902FF'), 6);

    await vi.advanceTimersByTimeAsync(TIMING.FUNCTIONAL_AGGREGATION_WINDOW_MS + 10);
    const r1: SendUdsResult = await p1;
    const r2: SendUdsResult = await p2;

    // 期望：tx-0001 拿到 2 条 62 F190；tx-0002 拿到 1 条 59 02
    expect(r1.functionalResponses?.map((x) => x.sa)).toEqual([0x1000, 0x1010]);
    expect(r2.functionalResponses?.map((x) => x.sa)).toEqual([0x1020]);
  });

  it('QA-T04 六种终态路径结束后均不得残留 timer（vi.getTimerCount()===0）', async () => {
    const cases: Array<() => Promise<void>> = [
      // COMPLETED
      async () => {
        const { txns } = setupTxn();
        void txns.send(req());
        await Promise.resolve();
        txns.onDiagnosticMessageAck(ack(), 2);
        txns.onDiagnosticMessage(diag(TA, SA, '5003'), 3);
      },
      // FAILED_NACK
      async () => {
        const { txns } = setupTxn();
        void txns.send(req());
        await Promise.resolve();
        txns.onDiagnosticMessageNack(nack(), 2);
      },
      // FAILED_ACK_TIMEOUT
      async () => {
        const { txns } = setupTxn();
        void txns.send(req());
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(TIMING.ACK_WAIT_TIMEOUT_MS + 10);
      },
      // FAILED_UDS_TIMEOUT
      async () => {
        const { txns } = setupTxn();
        void txns.send(req());
        await Promise.resolve();
        txns.onDiagnosticMessageAck(ack(), 2);
        await vi.advanceTimersByTimeAsync(TIMING.P2_CLIENT_MS + 10);
      },
      // P2* 超时
      async () => {
        const { txns } = setupTxn();
        void txns.send(req());
        await Promise.resolve();
        txns.onDiagnosticMessageAck(ack(), 2);
        txns.onDiagnosticMessage(diag(TA, SA, '7F1078'), 3);
        await vi.advanceTimersByTimeAsync(TIMING.P2_STAR_CLIENT_MS + 10);
      },
      // 抑制正响应 SUPPRESSED
      async () => {
        const { txns } = setupTxn();
        void txns.send({ addressing: 'physical', rawHex: '3E80' });
        await Promise.resolve();
        txns.onDiagnosticMessageAck(ack(TA, SA, parseHex('3E80')), 2);
        await vi.advanceTimersByTimeAsync(TIMING.SUPPRESSED_NRC_WINDOW_MS + 10);
      },
    ];
    for (const run of cases) {
      await run();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('QA-T05 抑制正响应窗口内收到 NRC 必须记录，且不得误报超时', async () => {
    const { txns } = setupTxn();
    const p = txns.send({ addressing: 'physical', rawHex: '3E80' });
    await Promise.resolve();
    txns.onDiagnosticMessageAck(ack(TA, SA, parseHex('3E80')), 2);
    txns.onDiagnosticMessage(diag(TA, SA, '7F3E13'), 3);
    const r = await p;
    expect(r.nrc).toBe(0x13);
    expect(r.errorCode).toBeUndefined();
    expect(r.state).toBe('SUPPRESSED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('QA-T06 ACK 超时与 UDS 超时的 note 必须互斥（不得出现同文案）', async () => {
    const { txns } = setupTxn();
    const p1 = txns.send(req());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(TIMING.ACK_WAIT_TIMEOUT_MS + 10);
    const r1 = await p1;

    const { txns: t2 } = setupTxn();
    const p2 = t2.send(req());
    await Promise.resolve();
    t2.onDiagnosticMessageAck(ack(), 2);
    await vi.advanceTimersByTimeAsync(TIMING.P2_CLIENT_MS + 10);
    const r2 = await p2;

    expect(r1.note).toContain('请求可能未进入网关');
    expect(r1.note).not.toContain('网关已收下并转发');
    expect(r2.note).toContain('网关已收下并转发');
    expect(r2.note).not.toContain('请求可能未进入网关');
  });
});

/* ═══════════════════════ ③ 仿真 ECU 真 socket ═══════════════════════ */

const SIM_PORT_A = 13481;

/** 极简独立 DoIP 客户端：直接用 node:net，不复用项目内 DoipClient */
class RawDoipClient {
  private sock: net.Socket;
  private buf = Buffer.alloc(0);
  readonly frames: Array<{ type: number; payload: Buffer; raw: Buffer }> = [];

  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.on('data', (c: Buffer) => {
      this.buf = Buffer.concat([this.buf, c]);
      this.drain();
    });
  }

  static connect(port: number, host = '127.0.0.1'): Promise<RawDoipClient> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port }, () => resolve(new RawDoipClient(sock)));
      sock.once('error', reject);
    });
  }

  private drain(): void {
    for (;;) {
      if (this.buf.length < 8) return;
      const len = this.buf.readUInt32BE(4);
      const total = 8 + len;
      if (this.buf.length < total) return;
      const raw = Buffer.from(this.buf.subarray(0, total));
      this.frames.push({ type: raw.readUInt16BE(2), payload: raw.subarray(8), raw });
      this.buf = this.buf.subarray(total);
    }
  }

  send(payloadType: number, payload: Buffer): void {
    this.sock.write(DoipHeaderCodec.buildFrame(0x02, payloadType, payload));
  }

  /** 等到第 n 帧（0-based）到达 */
  waitFrame(index: number, timeoutMs = 4000): Promise<{ type: number; payload: Buffer; raw: Buffer }> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = (): void => {
        const f = this.frames[index];
        if (f !== undefined) return resolve(f);
        if (Date.now() - started > timeoutMs) return reject(new Error(`等待第 ${index} 帧超时`));
        setTimeout(poll, 10);
      };
      poll();
    });
  }

  close(): void {
    this.sock.destroy();
  }
}

describe('QA-S 仿真 ECU：真 socket + 字节级 ISO 13400-2', () => {
  let runtime: SimEcuRuntime;
  let port = 0;

  beforeEach(async () => {
    runtime = new SimEcuRuntime();
    const r = await runtime.start({ port: SIM_PORT_A, announce: false });
    port = r.port;
  });

  afterEach(async () => {
    await runtime.stop();
  });

  it('QA-S01 独立 net/dgram 客户端（不用 DoipClient）能连上并收到合规 0x0006', async () => {
    expect(port).toBeGreaterThan(0);
    const c = await RawDoipClient.connect(port);

    const reqPayload = DoipPayloadCodec.encode({
      kind: 'routingActivationRequest',
      payloadType: PayloadType.ROUTING_ACTIVATION_REQ,
      value: { sourceAddress: 0x0e00, activationType: 0x00, reservedIso: 0, reservedOem: new Uint8Array(4) },
    });
    expect(reqPayload.length).toBe(11); // ★ISO：0x0005 恒 11 字节
    c.send(PayloadType.ROUTING_ACTIVATION_REQ, reqPayload);

    const res = await c.waitFrame(0);
    expect(res.type).toBe(PayloadType.ROUTING_ACTIVATION_RES);
    // ★逐字节核对
    expect(res.raw.length).toBe(8 + 13); // 0x0006 恒 13 字节 payload
    expect(res.raw[0]).toBe(0x02);
    expect(res.raw[1]).toBe(0xfd);
    expect(res.raw.readUInt32BE(4)).toBe(13);
    expect(res.payload.readUInt16BE(0)).toBe(0x0e00); // tester LA 回显
    expect(res.payload.readUInt16BE(2)).toBe(0x1000); // entity LA
    expect(res.payload[4]).toBe(0x10); // 路由激活成功
    expect(res.payload.readUInt32BE(5)).toBe(0); // reserved ISO
    c.close();
  });

  it('QA-S02 0x8001 → 0x8002 → 0x8001 的字节布局与 previousMessage 回显', async () => {
    const c = await RawDoipClient.connect(port);
    c.send(
      PayloadType.ROUTING_ACTIVATION_REQ,
      DoipPayloadCodec.encode({
        kind: 'routingActivationRequest',
        payloadType: PayloadType.ROUTING_ACTIVATION_REQ,
        value: { sourceAddress: 0x0e00, activationType: 0x00, reservedIso: 0, reservedOem: new Uint8Array(4) },
      }),
    );
    await c.waitFrame(0);

    const userData = parseHex('22F190');
    const dmPayload = DoipPayloadCodec.encode({
      kind: 'diagnosticMessage',
      payloadType: PayloadType.DIAGNOSTIC_MESSAGE,
      value: { sourceAddress: 0x0e00, targetAddress: 0x1000, userData },
    });
    expect(dmPayload.length).toBe(4 + 3);
    c.send(PayloadType.DIAGNOSTIC_MESSAGE, dmPayload);

    const a = await c.waitFrame(1);
    expect(a.type).toBe(PayloadType.DIAGNOSTIC_MESSAGE_ACK);
    expect(a.payload.readUInt16BE(0)).toBe(0x1000); // ACK 的 SA = 实体侧
    expect(a.payload.readUInt16BE(2)).toBe(0x0e00); // ACK 的 TA = tester
    expect(a.payload[4]).toBe(0x00); // ackCode
    expect(Buffer.compare(a.payload.subarray(5), Buffer.from(userData))).toBe(0); // ★回显请求

    const r = await c.waitFrame(2);
    expect(r.type).toBe(PayloadType.DIAGNOSTIC_MESSAGE);
    expect(r.payload.readUInt16BE(0)).toBe(0x1000);
    expect(r.payload.readUInt16BE(2)).toBe(0x0e00);
    expect(r.payload[4]).toBe(0x62); // 22 | 0x40
    expect(r.payload.subarray(7).toString('ascii')).toBe('LSVAM1234N2000001');
    c.close();
  });

  it('QA-S03 [QA-BUG-01] 未路由激活即发 0x8001 → NACK 码必须按 ISO 13400-2 为 0x02（源地址无效）', async () => {
    const c = await RawDoipClient.connect(port);
    c.send(
      PayloadType.DIAGNOSTIC_MESSAGE,
      DoipPayloadCodec.encode({
        kind: 'diagnosticMessage',
        payloadType: PayloadType.DIAGNOSTIC_MESSAGE,
        value: { sourceAddress: 0x0e00, targetAddress: 0x1000, userData: parseHex('22F190') },
      }),
    );
    const n = await c.waitFrame(0);
    expect(n.type).toBe(PayloadType.DIAGNOSTIC_MESSAGE_NACK);
    expect(n.payload.readUInt16BE(0)).toBe(0x1000);
    expect(n.payload.readUInt16BE(2)).toBe(0x0e00);
    // ★ISO 13400-2 Table 26：0x02 = Invalid source address（DESIGN §3.10 亦写 0x02）
    expect(n.payload[4]).toBe(0x02);
    c.close();
  });

  it('QA-S04 UDP 0x0001 → 0x0004 车辆公告：VIN/EID/GID/LA 偏移逐字节核对', async () => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', () => resolve()));
    const reply = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('UDP 公告超时')), 4000);
      sock.once('message', (m: Buffer) => {
        clearTimeout(timer);
        resolve(Buffer.from(m));
      });
    });
    const req = DoipHeaderCodec.buildFrame(0x02, PayloadType.VEHICLE_IDENTIFICATION_REQ, new Uint8Array(0));
    sock.send(req, 0, req.length, port, '127.0.0.1');
    const msg = await reply;

    expect(msg.length).toBe(8 + 33); // ★ISO：0x0004 恒 33 字节 payload
    expect(msg[0]).toBe(0x02);
    expect(msg[1]).toBe(0xfd);
    expect(msg.readUInt16BE(2)).toBe(PayloadType.VEHICLE_ANNOUNCEMENT);
    expect(msg.readUInt32BE(4)).toBe(33);
    expect(msg.subarray(8, 25).toString('ascii')).toBe('LSVAM1234N2000001'); // VIN @8
    expect(msg.readUInt16BE(25)).toBe(0x1000); // LA @25
    expect(Array.from(msg.subarray(27, 33))).toEqual([1, 2, 3, 4, 5, 6]); // EID @27
    expect(Array.from(msg.subarray(33, 39))).toEqual([0x11, 0x12, 0x13, 0x14, 0x15, 0x16]); // GID @33
    expect(msg[39]).toBe(0); // furtherActionRequired @39
    expect(msg[40]).toBe(0); // vinGidSyncStatus @40
    await new Promise<void>((resolve) => sock.close(() => resolve()));
  });
});

/* ═══════════════════════ ④ 协议码表符合性 ═══════════════════════ */

describe('QA-P 协议码表与 ISO 符合性抽查', () => {
  it('QA-P01 [QA-BUG-01] 0x8003 NACK 码表必须按 ISO 13400-2 Table 26 对齐', () => {
    const expectMap: Array<[number, string]> = [
      [0x02, 'InvalidSourceAddress'],
      [0x03, 'UnknownTargetAddress'],
      [0x04, 'DiagnosticMessageTooLarge'],
      [0x05, 'OutOfMemory'],
      [0x06, 'TargetUnreachable'],
      [0x07, 'UnknownNetwork'],
      [0x08, 'TransportProtocolError'],
    ];
    for (const [code, name] of expectMap) {
      const entry = lookupCodeEntry(FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES, code);
      expect(entry?.name, `NACK 0x${code.toString(16)} 应为 ${name}`).toBe(name);
    }
    // 0x00 / 0x01 在标准中是 Reserved，不得被占用
    expect(lookupCodeEntry(FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES, 0x00)).toBeNull();
    expect(lookupCodeEntry(FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES, 0x01)).toBeNull();
  });

  it('QA-P02 payload 长度符合 ISO：0x0005=11、0x0006=13、0x0004=33、0x4002=7、0x0008=2', () => {
    expect(
      DoipPayloadCodec.encode({
        kind: 'routingActivationRequest',
        payloadType: 0x0005,
        value: { sourceAddress: 0x0e00, activationType: 0, reservedIso: 0, reservedOem: new Uint8Array(4) },
      }).length,
    ).toBe(11);
    expect(
      DoipPayloadCodec.encode({
        kind: 'routingActivationResponse',
        payloadType: 0x0006,
        value: {
          testerLogicalAddress: 0x0e00,
          doipEntityLogicalAddress: 0x1000,
          routingActivationResponseCode: 0x10,
          reservedIso: 0,
          reservedOem: new Uint8Array(4),
        },
      }).length,
    ).toBe(13);
    expect(
      DoipPayloadCodec.encode({
        kind: 'vehicleAnnouncement',
        payloadType: 0x0004,
        value: {
          vin: 'LSVAM1234N2000001',
          logicalAddress: 0x1000,
          eid: parseHex('010203040506'),
          gid: parseHex('111213141516'),
          furtherActionRequired: 0,
          vinGidSyncStatus: 0,
        },
      }).length,
    ).toBe(33);
    expect(
      DoipPayloadCodec.encode({
        kind: 'entityStatusResponse',
        payloadType: 0x4002,
        value: { nodeType: 1, maxConcurrentSockets: 2, currentlyOpenSockets: 1, maxDataSize: 4096 },
      }).length,
    ).toBe(7);
    expect(
      DoipPayloadCodec.encode({
        kind: 'aliveCheckResponse',
        payloadType: 0x0008,
        value: { sourceAddress: 0x0e00 },
      }).length,
    ).toBe(2);
  });

  it('QA-P03 编解码往返全等（0x0004 / 0x0005 / 0x0006 / 0x8001 / 0x8002 / 0x8003）', () => {
    const cases = [
      {
        kind: 'vehicleAnnouncement' as const,
        payloadType: 0x0004,
        value: {
          vin: 'LSVAM1234N2000001',
          logicalAddress: 0x1000,
          eid: parseHex('010203040506'),
          gid: parseHex('111213141516'),
          furtherActionRequired: 0,
          vinGidSyncStatus: 1,
        },
      },
      {
        kind: 'routingActivationRequest' as const,
        payloadType: 0x0005,
        value: { sourceAddress: 0x0e00, activationType: 0x01, reservedIso: 0, reservedOem: parseHex('AABBCCDD') },
      },
      {
        kind: 'routingActivationResponse' as const,
        payloadType: 0x0006,
        value: {
          testerLogicalAddress: 0x0e00,
          doipEntityLogicalAddress: 0x1000,
          routingActivationResponseCode: 0x10,
          reservedIso: 0,
          reservedOem: parseHex('01020304'),
        },
      },
      {
        kind: 'diagnosticMessage' as const,
        payloadType: 0x8001,
        value: { sourceAddress: 0x0e00, targetAddress: 0x1000, userData: parseHex('22F190') },
      },
      {
        kind: 'diagnosticMessageAck' as const,
        payloadType: 0x8002,
        value: { sourceAddress: 0x1000, targetAddress: 0x0e00, ackCode: 0x00, previousMessage: parseHex('22F190') },
      },
      {
        kind: 'diagnosticMessageNack' as const,
        payloadType: 0x8003,
        value: { sourceAddress: 0x1000, targetAddress: 0x0e00, nackCode: 0x03, previousMessage: parseHex('22F190') },
      },
    ];
    for (const c of cases) {
      const bytes = DoipPayloadCodec.encode(c as never);
      const back = DoipPayloadCodec.decode(c.payloadType, bytes);
      expect(back.kind).toBe(c.kind);
      if (back.kind === 'unknown') throw new Error('往返后变成了 unknown');
      const v = back.value as Record<string, unknown>;
      for (const [k, want] of Object.entries(c.value as Record<string, unknown>)) {
        if (want instanceof Uint8Array) {
          expect(Buffer.from(v[k] as Uint8Array).toString('hex'), `${c.kind}.${k}`).toBe(
            Buffer.from(want).toString('hex'),
          );
        } else {
          expect(v[k], `${c.kind}.${k}`).toBe(want);
        }
      }
    }
  });

  it('QA-P04 未知 payloadType 与长度不足均不得抛异常，退化为 unknown', () => {
    expect(DoipPayloadCodec.decode(0x7777, parseHex('00112233')).kind).toBe('unknown');
    expect(DoipPayloadCodec.decode(PayloadType.ROUTING_ACTIVATION_RES, parseHex('0000')).kind).toBe('unknown');
    expect(DoipPayloadCodec.decode(PayloadType.DIAGNOSTIC_MESSAGE, parseHex('0E')).kind).toBe('unknown');
  });
});
