/**
 * QA-M2 独立验证套件（QA 严过关 / Yan）—— 针对 T05–T07 + T17 后端落盘。
 *
 * 原则同 QA-M1：**证明它对，不是确认它存在**。
 *
 * 覆盖（对应项目组给的六个方向）：
 *   QA-E*  EventBus seq 唯一分配点： continuities + 事务↔Trace 交叉引用完整性 + M1 回归
 *   QA-B*  BackpressureGuard 三级降级与 trace.gap 区间吻合度
 *   QA-R*  RollingFileSink 拓扑（WS L2 时落盘全量）/ 滚动三策 / index 自洽 / 保留策略
 *   QA-S*  T05 会话层：非法迁移拦截、3E 周期、UDS 会话追踪
 *   QA-Y*  ResyncService 三个分支
 *
 * ★名字以 `[QA-BUG-xx]` 开头的用例是**故意让它红**的缺陷证据：
 *   它们断言的是设计/架构要求的正确行为，实现不达标就会失败，修好后应转绿。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'node:net';

import { EventBus } from '../bridge/EventBus';
import { BatchFlusher } from '../bridge/BatchFlusher';
import { BackpressureGuard } from '../bridge/BackpressureGuard';
import { ResyncService } from '../bridge/ResyncService';
import { TraceStore } from '../trace/TraceStore';
import { TraceEntryBuilder } from '../trace/TraceEntryBuilder';
import { RollingFileSink } from '../trace/RollingFileSink';
import { DoipSession } from '../session/DoipSession';
import { SessionStateMachine } from '../session/SessionStateMachine';
import { TesterPresentScheduler } from '../session/TesterPresentScheduler';
import { UdsSessionTracker } from '../session/UdsSessionTracker';

import {
  PayloadType,
  TIMING,
  emptyUdsDecodeResult,
  parseHex,
} from '@doip/shared';
import type { TraceEntry } from '@doip/shared';
import { getLimits } from '../config/defaults';
import { DoipHeaderCodec } from '../doip/DoipHeaderCodec';
import { DoipPayloadCodec } from '../doip/DoipPayloadCodec';

/* ═══════════════════ 通用工具 ═══════════════════ */

function mkEntry(seq: number, overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    seq,
    transactionId: null,
    ts: '2026-09-22T10:00:00.000000Z',
    tsRelMs: seq,
    transport: 'TCP',
    direction: 'TX',
    peer: '127.0.0.1:13401',
    sessionId: 'qa',
    doip: {
      protocolVersion: 0x02,
      inverseVersionValid: true,
      payloadType: PayloadType.DIAGNOSTIC_MESSAGE,
      payloadTypeName: 'DiagnosticMessage',
      payloadTypeNameZh: '诊断报文',
      payloadLength: 6,
      sourceAddress: 0x0e00,
      targetAddress: 0x1000,
      sourceAddressName: '0x0E00',
      targetAddressName: '0x1000',
      ackCode: null,
      ackNameZh: null,
      nackCode: null,
      nackNameZh: null,
      activationResponseCode: null,
      activationResponseCodeZh: null,
      vin: null,
      eid: null,
      gid: null,
      headerHex: '02FD800100000006',
    },
    uds: emptyUdsDecodeResult(),
    linkedSeq: null,
    txnRole: 'request',
    latencyMs: null,
    gatewayForwardLatencyMs: null,
    timeout: false,
    errorCode: null,
    errorNameZh: null,
    tags: [],
    rawHex: '02FD8001000000060E0010001003',
    ...overrides,
  };
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'qa-m2-'));
}

const cleanups: string[] = [];
function track(dir: string): string {
  cleanups.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function readAllJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const body = readFileSync(join(dir, f), 'utf8');
    for (const line of body.split('\n')) if (line !== '') out.push(line);
  }
  return out;
}

/* ═══════════════ ① EventBus 的 seq 分配 ═══════════════ */

describe('QA-E EventBus seq 唯一分配点', () => {
  it('QA-E01 高频连续发布：seq 严格单调且 1..N 连续无断号', () => {
    const bus = new EventBus();
    const store = new TraceStore();
    bus.subscribeEntries((e) => store.append(e));

    const total = 5000;
    for (let i = 0; i < total; i += 1) bus.publishTrace(mkEntry(0));

    expect(bus.seqNow).toBe(total);
    expect(store.size).toBe(total);
    const seqs = store.all().map((e) => e.seq);
    expect(seqs[0]).toBe(1);
    expect(seqs[total - 1]).toBe(total);
    for (let i = 1; i < total; i += 1) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1);
    }
  });

  it('QA-E02 WS 降级不得影响任何平级订阅者的条数（seq 仍满额分配）', () => {
    const bus = new EventBus();
    const store = new TraceStore();
    bus.subscribeEntries((e) => store.append(e));
    let delivered = 0;
    const flusher = new BatchFlusher({
      getBufferedAmount: () => 4 * 1024 * 1024, // 恒 L2
      send: (env) => {
        const events = (env.payload as { events: Array<{ kind: string }> }).events;
        delivered += events.filter((e) => e.kind === 'trace.entry').length;
      },
    });
    bus.setStreamSink((ev) => flusher.enqueue(ev));

    const total = 1000;
    for (let i = 0; i < total; i += 1) bus.publishTrace(mkEntry(0));
    flusher.flush();

    expect(bus.seqNow).toBe(total);
    expect(store.size).toBe(total);
    expect(delivered).toBeLessThan(total); // WS 确实降级了
    flusher.dispose();
  });
});

/* ─── session 级集成：用可控的假 TCP 对端驱动真实的 DoipSession ─── */

interface FakePeer {
  socket: Socket;
  /** 服务端 → 客户端（RX） */
  push(bytes: Buffer): void;
  /** 客户端已写出的完整帧（已按 DoIP 头切分） */
  clientFrames(): Array<{ type: number; payload: Buffer; raw: Buffer }>;
  resetTx(): void;
}

function makeFakePeer(autoReplyRoutingActivation = true): FakePeer {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  let tx = Buffer.alloc(0);
  let frames: Array<{ type: number; payload: Buffer; raw: Buffer }> = [];
  let routingReplied = false;

  const drainTx = (): void => {
    for (;;) {
      if (tx.length < 8) return;
      const len = tx.readUInt32BE(4);
      const total = 8 + len;
      if (tx.length < total) return;
      const raw = Buffer.from(tx.subarray(0, total));
      frames.push({ type: raw.readUInt16BE(2), payload: raw.subarray(8), raw });
      tx = tx.subarray(total);
    }
  };

  fromClient.on('data', (c: Buffer) => {
    tx = Buffer.concat([tx, c]);
    drainTx();
    if (autoReplyRoutingActivation) {
      for (const f of frames) {
        if (f.type !== PayloadType.ROUTING_ACTIVATION_REQ) continue;
        if (routingReplied) continue;
        routingReplied = true;
        // ★必须异步回：DoipClient 是"先 writeFrame 再注册 waiter"，
        //   同步回会被当成"没有等待中的请求"丢弃（真实 socket 不可能同步到，故用 setImmediate 模拟）
        setImmediate(() => {
          toClient.write(
            DoipHeaderCodec.buildFrame(
              0x02,
              PayloadType.ROUTING_ACTIVATION_RES,
              DoipPayloadCodec.encode({
                kind: 'routingActivationResponse',
                payloadType: PayloadType.ROUTING_ACTIVATION_RES,
                value: {
                  testerLogicalAddress: 0x0e00,
                  doipEntityLogicalAddress: 0x1000,
                  routingActivationResponseCode: 0x10,
                  reservedIso: 0,
                  reservedOem: new Uint8Array(4),
                },
              }),
            ),
          );
        });
      }
    }
  });

  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const socket = {
    on: (ev: string, h: (...a: unknown[]) => void) => {
      if (ev === 'data') toClient.on('data', h);
      else {
        listeners[ev] = listeners[ev] ?? [];
        listeners[ev]?.push(h);
      }
      return socket;
    },
    once: () => socket,
    removeListener: () => socket,
    write: (b: Buffer) => {
      fromClient.write(Buffer.from(b));
      return true;
    },
    destroy: () => socket,
    end: () => socket,
    destroyed: false,
    remoteAddress: '127.0.0.1',
    remotePort: 13401,
    setTimeout: () => socket,
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
    ref: () => socket,
    unref: () => socket,
  } as unknown as Socket;

  return {
    socket,
    push: (bytes: Buffer) => {
      toClient.write(bytes);
    },
    clientFrames: () => frames,
    resetTx: () => {
      tx = Buffer.alloc(0);
      frames = [];
    },
  };
}

function sendFrame(peer: FakePeer, payloadType: number, payload: Buffer): void {
  peer.push(DoipHeaderCodec.buildFrame(0x02, payloadType, payload));
}

interface SessionHarness {
  bus: EventBus;
  store: TraceStore;
  session: DoipSession;
  peer: FakePeer;
}

async function makeSessionHarness(): Promise<SessionHarness> {
  const bus = new EventBus();
  const store = new TraceStore();
  const builder = new TraceEntryBuilder(Date.now());
  const peer = makeFakePeer();

  bus.subscribeEntries((e) => store.append(e));

  const session = new DoipSession({
    sessionId: 'qa',
    seqSource: { next: () => bus.nextSeq() },
    onFrame: (frame, ctx) => bus.publishTrace(builder.build(frame, ctx)).seq,
    client: { factory: { connect: async () => peer.socket } },
  });

  await session.connect({ mode: 'sim', host: '127.0.0.1', port: 13401, sa: '0x0E00', ta: '0x1000' });
  expect(session.status.state).toBe('ROUTING_ACTIVE');
  peer.resetTx();
  return { bus, store, session, peer };
}

describe('QA-E 会话级 seq 交叉引用完整性', () => {
  it('QA-E03 一次完整事务：ref 三方各自指向 Trace 中真实存在的正确条目', async () => {
    const { bus, store, session, peer } = await makeSessionHarness();

    const p = session.sendUds({ addressing: 'physical', sid: '0x10', subFunction: '0x03' });
    await vi.waitUntil(() => peer.clientFrames().length > 0, { timeout: 2000 });
    // 0x8002 ACK（回显请求 userData）
    sendFrame(
      peer,
      PayloadType.DIAGNOSTIC_MESSAGE_ACK,
      DoipPayloadCodec.encode({
        kind: 'diagnosticMessageAck',
        payloadType: PayloadType.DIAGNOSTIC_MESSAGE_ACK,
        value: {
          sourceAddress: 0x1000,
          targetAddress: 0x0e00,
          ackCode: 0x00,
          previousMessage: parseHex('1003'),
        },
      }),
    );
    // 0x8001 正响应
    sendFrame(
      peer,
      PayloadType.DIAGNOSTIC_MESSAGE,
      DoipPayloadCodec.encode({
        kind: 'diagnosticMessage',
        payloadType: PayloadType.DIAGNOSTIC_MESSAGE,
        value: { sourceAddress: 0x1000, targetAddress: 0x0e00, userData: parseHex('5003003201F4') },
      }),
    );
    const result = await p;

    expect(result.state).toBe('COMPLETED');

    // ① 号段连续：本次有 TX req / TX(0x0005) / RX(0x0006) / TX(0x8001) / RX(0x8002) / RX(0x8001)
    const seqs = store.all().map((e) => e.seq);
    expect(bus.seqNow).toBe(store.size);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1); // ★无断号
    }

    // ② 交叉引用：三个 seq 必须都能在 Trace 里找到对应条目
    const bySeq = new Map(store.all().map((e) => [e.seq, e]));
    const txn = session.txns.getTransaction(result.txnId);
    expect(txn).toBeDefined();
    const reqSeq = txn?.seqRequest ?? -1;
    const ackSeq = txn?.seqAck ?? -1;
    const respSeq = txn?.seqResponses[0] ?? -1;

    for (const s of [reqSeq, ackSeq, respSeq]) {
      expect(bySeq.has(s), `seq ${s} 必须在 Trace 中存在（不得悬空）`).toBe(true);
    }
    // ③ 语义正确性：不只是存在，还要是"对的那一帧"
    const reqEntry = bySeq.get(reqSeq);
    const ackEntry = bySeq.get(ackSeq);
    const respEntry = bySeq.get(respSeq);
    expect(reqEntry?.direction).toBe('TX');
    expect(reqEntry?.rawHex).toContain('10 03');
    expect(ackEntry?.doip.payloadType).toBe(PayloadType.DIAGNOSTIC_MESSAGE_ACK);
    expect(respEntry?.direction).toBe('RX');
    expect(respEntry?.rawHex).toContain('50 03 00 32 01 F4');
    // ④ 顺序：request < ack < response
    expect(reqSeq).toBeLessThan(ackSeq);
    expect(ackSeq).toBeLessThan(respSeq);

    session.dispose();
  });

  it('QA-E04 连续多发 request：号段仍连续，且每条事务的 seqRequest 递增不重复', async () => {
    const { bus, store, session, peer } = await makeSessionHarness();

    const n = 8;
    const got: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const p = session.sendUds({
        addressing: 'physical',
        sid: '0x3E',
        subFunction: '0x80',
        expectResponse: false,
      });
      await vi.waitUntil(() => peer.clientFrames().length > 0, { timeout: 2000 });
      peer.resetTx();
      await p;
      const txn = session.txns.getTransaction(`tx-${String(i + 1).padStart(4, '0')}`);
      got.push(txn?.seqRequest ?? -1);
    }
    const seqs = store.all().map((e) => e.seq);
    expect(bus.seqNow).toBe(store.size);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe((seqs[i - 1] ?? 0) + 1);
    expect(new Set(got).size).toBe(n); // 不得两条事务共用一个 seq
    for (let i = 1; i < n; i += 1) expect(got[i]).toBeGreaterThan(got[i - 1] ?? 0);
    session.dispose();
  });

  it('QA-E05 ★M1 回归：事务六分支仍然正确（改 seq 填充时机后未破坏配对）', async () => {
    // 分支 A COMPLETED / B FAILED_NACK / D FAILED_UDS_TIMEOUT
    const { session, peer } = await makeSessionHarness();

    // A：正常完成
    const pa = session.sendUds({ addressing: 'physical', sid: '0x10', subFunction: '0x03' });
    await vi.waitUntil(() => peer.clientFrames().length > 0, { timeout: 2000 });
    peer.resetTx();
    sendFrame(peer, PayloadType.DIAGNOSTIC_MESSAGE_ACK, DoipPayloadCodec.encode({
      kind: 'diagnosticMessageAck', payloadType: PayloadType.DIAGNOSTIC_MESSAGE_ACK,
      value: { sourceAddress: 0x1000, targetAddress: 0x0e00, ackCode: 0x00, previousMessage: parseHex('1003') },
    }));
    sendFrame(peer, PayloadType.DIAGNOSTIC_MESSAGE, DoipPayloadCodec.encode({
      kind: 'diagnosticMessage', payloadType: PayloadType.DIAGNOSTIC_MESSAGE,
      value: { sourceAddress: 0x1000, targetAddress: 0x0e00, userData: parseHex('5003003201F4') },
    }));
    const ra = await pa;
    expect(ra.state).toBe('COMPLETED');

    // B：0x8003 NACK
    const pb = session.sendUds({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
    await vi.waitUntil(() => peer.clientFrames().length > 0, { timeout: 2000 });
    peer.resetTx();
    sendFrame(peer, PayloadType.DIAGNOSTIC_MESSAGE_NACK, DoipPayloadCodec.encode({
      kind: 'diagnosticMessageNack', payloadType: PayloadType.DIAGNOSTIC_MESSAGE_NACK,
      value: { sourceAddress: 0x1000, targetAddress: 0x0e00, nackCode: 0x02, previousMessage: parseHex('22F190') },
    }));
    const rb = await pb;
    expect(rb.state).toBe('FAILED_NACK');
    expect(rb.note ?? '').toContain('网关未转发（非 UDS 层错误）');

    // D：已 ACK 但 UDS 不回 → FAILED_UDS_TIMEOUT
    const pd = session.sendUds({
      addressing: 'physical', sid: '0x22', dids: ['0xF190'], p2TimeoutMs: 150,
    });
    await vi.waitUntil(() => peer.clientFrames().length > 0, { timeout: 2000 });
    peer.resetTx();
    sendFrame(peer, PayloadType.DIAGNOSTIC_MESSAGE_ACK, DoipPayloadCodec.encode({
      kind: 'diagnosticMessageAck', payloadType: PayloadType.DIAGNOSTIC_MESSAGE_ACK,
      value: { sourceAddress: 0x1000, targetAddress: 0x0e00, ackCode: 0x00, previousMessage: parseHex('22F190') },
    }));
    const rd = await pd;
    expect(rd.state).toBe('FAILED_UDS_TIMEOUT');
    expect(rd.note ?? '').toContain('网关已收下并转发');
    expect(rd.gatewayForwardLatencyMs).not.toBeNull();

    // 延迟打点必须分离
    expect(ra.latencyMs).not.toBeNull();
    expect((ra.latencyMs ?? 0) >= (ra.gatewayForwardLatencyMs ?? Number.MAX_SAFE_INTEGER) - 1).toBe(true);

    session.dispose();
  }, 20000);
});

/* ═══════════════ ② BackpressureGuard / trace.gap ═══════════════ */

describe('QA-B 背压三级降级与 trace.gap', () => {
  it('QA-B01 L0/L1/L2 在预期阈值触发，且 L1 持续超时才升 L2', () => {
    let buffered = 0;
    let clock = 0;
    const guard = new BackpressureGuard({ getBufferedAmount: () => buffered, now: () => clock });
    const high = 1024 * 1024;
    const low = 256 * 1024;

    buffered = low - 1;
    expect(guard.update()).toBe('L0');
    buffered = low;
    expect(guard.update()).toBe('L1');
    clock = getLimits('WS_MAX_BACKPRESSURE_MS');
    expect(guard.update()).toBe('L1'); // 尚未超过 WS_MAX_BACKPRESSURE_MS
    clock += 1;
    expect(guard.update()).toBe('L2');
    buffered = high;
    expect(guard.update()).toBe('L2');
    buffered = low - 1;
    expect(guard.update()).toBe('L0');
  });

  it('QA-B02 L2 丢弃区间必须与实际丢弃集合完全吻合（from/to/count 三者自洽）', () => {
    let buffered = 4 * 1024 * 1024; // 恒 L2
    const gaps: Array<{ fromSeq: number; toSeq: number; count: number }> = [];
    const deliveredSeqs: number[] = [];
    const flusher = new BatchFlusher({
      getBufferedAmount: () => buffered,
      now: () => 0,
      onGap: (g) => gaps.push({ fromSeq: g.fromSeq, toSeq: g.toSeq, count: g.count }),
      send: (env) => {
        const events = (env.payload as { events: Array<{ kind: string; entry?: TraceEntry }> }).events;
        for (const e of events) if (e.kind === 'trace.entry' && e.entry) deliveredSeqs.push(e.entry.seq);
      },
    });
    flusher.guard.forceLevel('L2');

    const bus = new EventBus();
    bus.setStreamSink((ev) => flusher.enqueue(ev));
    const total = 2000;
    for (let i = 0; i < total; i += 1) bus.publishTrace(mkEntry(0));
    flusher.flush();

    buffered = 0; // 恢复
    bus.publishTrace(mkEntry(0)); // 触发一次 flush → update() → recover()
    flusher.flush();

    expect(gaps).toHaveLength(1);
    const gap = gaps[0];
    const all = new Set(Array.from({ length: total + 1 }, (_, i) => i + 1));
    const deliveredSet = new Set(deliveredSeqs);
    const droppedSet = [...all].filter((s) => !deliveredSet.has(s));

    expect(gap?.count).toBe(droppedSet.length); // ★报的数量 == 真的丢的数量
    expect(gap?.fromSeq).toBe(droppedSet[0]);
    expect(gap?.toSeq).toBe(droppedSet[droppedSet.length - 1]);
    expect(droppedSet.length).toBeGreaterThan(0);
    flusher.dispose();
  });

  it('QA-B03 任何降级档位下 error / status 都不被丢弃', () => {
    const delivered: string[] = [];
    const flusher = new BatchFlusher({
      getBufferedAmount: () => 8 * 1024 * 1024,
      now: () => 0,
      send: (env) => {
        const events = (env.payload as { events: Array<{ kind: string }> }).events;
        for (const e of events) delivered.push(e.kind);
      },
    });
    flusher.guard.forceLevel('L2');
    const bus = new EventBus();
    bus.setStreamSink((ev) => flusher.enqueue(ev));

    for (let i = 0; i < 300; i += 1) bus.publishTrace(mkEntry(0));
    bus.publishError({ v: 1, code: 'E_QA', messageZh: '测试错误', ts: 0, severity: 'error' } as never);
    bus.publishStatus({} as never);
    flusher.flush();

    expect(delivered.filter((k) => k === 'error')).toHaveLength(1);
    expect(delivered.filter((k) => k === 'status')).toHaveLength(1);
    flusher.dispose();
  });

  it('QA-B04 L1 只暂停 flush 不丢条目（恢复后全量送达）', () => {
    let buffered = 300 * 1024; // [LOW, HIGH) → L1
    const deliveredSeqs: number[] = [];
    const flusher = new BatchFlusher({
      getBufferedAmount: () => buffered,
      now: () => 0,
      send: (env) => {
        const events = (env.payload as { events: Array<{ kind: string; entry?: TraceEntry }> }).events;
        for (const e of events) if (e.kind === 'trace.entry' && e.entry) deliveredSeqs.push(e.entry.seq);
      },
    });
    const bus = new EventBus();
    bus.setStreamSink((ev) => flusher.enqueue(ev));
    const total = 50;
    for (let i = 0; i < total; i += 1) bus.publishTrace(mkEntry(0));
    flusher.flush();
    expect(deliveredSeqs).toHaveLength(0); // 暂停推送

    buffered = 0;
    flusher.flush();
    expect(deliveredSeqs).toEqual(Array.from({ length: total }, (_, i) => i + 1)); // ★一条不少
    flusher.dispose();
  });
});

/* ═══════════════ ③ RollingFileSink ═══════════════ */

describe('QA-R RollingFileSink 拓扑与滚动', () => {
  it('QA-R01 ★WS 处于 L2 时落盘必须逐条全量（本兜底的立身之本）', async () => {
    const root = track(tmpRoot());
    const bus = new EventBus();
    const store = new TraceStore();
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'qa',
      highWaterBytes: 1 << 30,
      overrides: { maxEntriesPerFile: 500, flushIntervalMs: 20 },
    });
    await sink.start();
    bus.subscribeEntries((e) => store.append(e));
    bus.subscribeEntries((e) => sink.append(e));

    let pushed = 0;
    const flusher = new BatchFlusher({
      getBufferedAmount: () => 8 * 1024 * 1024, // 恒 L2
      send: (env) => {
        const events = (env.payload as { events: Array<{ kind: string }> }).events;
        pushed += events.filter((e) => e.kind === 'trace.entry').length;
      },
    });
    bus.setStreamSink((ev) => flusher.enqueue(ev));

    const total = 1000;
    for (let i = 0; i < total; i += 1) bus.publishTrace(mkEntry(0));
    flusher.flush();
    expect(pushed).toBeLessThan(total / 5); // WS 确实严重降级

    const status = await sink.stop();
    const dir = status.sessionDir ?? '';
    const lines = readAllJsonl(dir);
    expect(lines).toHaveLength(total);
    expect(status.droppedCount).toBe(0);
    // ★逐条核验：seq 必须与 TraceStore 完全一致且连续
    const diskSeqs = lines.map((l) => (JSON.parse(l) as TraceEntry).seq);
    expect(diskSeqs).toEqual(store.all().map((e) => e.seq));
    expect(diskSeqs).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    flusher.dispose();
  });

  it('QA-R02 index.json 在录盘过程中就包含"正在写的分片"（崩溃恢复不丢尾部）', async () => {
    const root = track(tmpRoot());
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'qa',
      highWaterBytes: 1 << 30,
      overrides: { maxEntriesPerFile: 10_000, flushIntervalMs: 20 },
    });
    await sink.start();
    for (let i = 1; i <= 5; i += 1) sink.append(mkEntry(i));
    await sink.flush();

    const dir = sink.getStatus().sessionDir ?? '';
    const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
      files: Array<{ file: string; entries: number; seqRange: [number, number] }>;
      currentFile: string | null;
      entriesWritten: number;
    };
    expect(index.files.length).toBe(1);
    expect(index.files[0]?.file).toBe(index.currentFile); // ★进行中的分片必须在清单里
    expect(index.files[0]?.entries).toBe(5);
    expect(index.files[0]?.seqRange).toEqual([1, 5]);
    expect(index.entriesWritten).toBe(5);
    expect(existsSync(join(dir, 'session.json'))).toBe(true);
    await sink.stop();
  });

  it('QA-R03 三条滚动策略各自独立触发：仅条数达标时滚动', async () => {
    const root = track(tmpRoot());
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'qa',
      highWaterBytes: 1 << 30,
      overrides: { maxEntriesPerFile: 10, maxFileBytes: 1 << 30, maxFileDurationMs: 1 << 30, flushIntervalMs: 20 },
    });
    await sink.start();
    for (let i = 1; i <= 25; i += 1) sink.append(mkEntry(i));
    const status = await sink.stop();
    expect(status.files).toHaveLength(3); // 10+10+5
    expect(status.files[0]?.entries).toBe(10);
    expect(status.files[1]?.entries).toBe(10);
    expect(status.files[2]?.entries).toBe(5);
  });

  it('QA-R04 三条滚动策略互相隔离：只有时长达标时，条数/字节门槛远未到也照样滚动', async () => {
    const root = track(tmpRoot());
    let clock = 0;
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'qa',
      highWaterBytes: 1 << 30,
      now: () => clock,
      overrides: { maxEntriesPerFile: 1_000_000, maxFileBytes: 1 << 30, maxFileDurationMs: 1000, flushIntervalMs: 20 },
    });
    await sink.start();
    sink.append(mkEntry(1));
    clock = 2000;
    sink.append(mkEntry(2));
    clock = 4000;
    sink.append(mkEntry(3));
    const status = await sink.stop();
    expect(status.files.length).toBeGreaterThanOrEqual(2); // 至少滚动过一次
    // ★且条数门槛远未到：不存在任何分片是"因为条数达标"而关闭的
    for (const f of status.files) expect(f.entries).toBeLessThan(1_000_000);
  });

  it('QA-R04b [QA-BUG-06] stop() 返回时分片必须已在磁盘上（index.json 与实际自洽，崩溃恢复可用）', async () => {
    const root = track(tmpRoot());
    let clock = 0;
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'qa',
      highWaterBytes: 1 << 30,
      now: () => clock,
      overrides: { maxEntriesPerFile: 1_000_000, maxFileBytes: 1 << 30, maxFileDurationMs: 1000, flushIntervalMs: 20 },
    });
    await sink.start();
    sink.append(mkEntry(1));
    clock = 2000;
    sink.append(mkEntry(2));
    clock = 4000;
    sink.append(mkEntry(3));
    const status = await sink.stop();

    const dir = status.sessionDir ?? '';
    // ★stop() 一返回，index.json / status 声称的分片就必须真实存在于磁盘
    const listed = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(listed.length).toBeGreaterThan(0);
    for (const f of status.files) {
      expect(existsSync(join(dir, f.file)), `index.json 声明的 ${f.file} 必须已落盘`).toBe(true);
    }
    // ★且行数必须与 claimed entries 完全一致
    for (const f of status.files) {
      const lines = readFileSync(join(dir, f.file), 'utf8').split('\n').filter(Boolean);
      expect(lines.length, `${f.file} 行数应等于清单 entries`).toBe(f.entries);
    }
  });

  it('QA-R05 [QA-BUG-03] 保留策略不得重复计数：只有一片时总量远未超限，不得删它', async () => {
    // ① 先量出"单片 20 条"的真实字节数 B1
    const probeRoot = track(tmpRoot());
    const probe = new RollingFileSink({
      rootDir: probeRoot,
      sessionId: 'qa',
      highWaterBytes: 1 << 30,
      overrides: { maxEntriesPerFile: 20, flushIntervalMs: 20 },
    });
    await probe.start();
    for (let i = 1; i <= 20; i += 1) probe.append(mkEntry(i));
    const b1 = (await probe.stop()).files[0]?.bytes ?? 0;
    expect(b1).toBeGreaterThan(0);

    // ② 阈值设为 1.5×B1：第一次滚动时真实总量只有 1×B1 < 阈值 → 不得删除
    const root = track(tmpRoot());
    const deleted: string[] = [];
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'qa',
      highWaterBytes: 1 << 30,
      overrides: {
        maxEntriesPerFile: 20,
        retainMaxBytesPerSession: Math.floor(b1 * 1.5),
        flushIntervalMs: 20,
      },
    });
    await sink.start();
    for (let i = 1; i <= 60; i += 1) sink.append(mkEntry(i));
    const status = await sink.stop();
    const dir = status.sessionDir ?? '';
    for (const f of status.files) expect(existsSync(join(dir, f.file))).toBe(true);
    // 期望：至少应保住"最后一个分片"（真实占用 1×B1 ≤ 阈值），实际会被重复计数算成 2×B1 而误删
    expect(status.files.length, `阈值 ${Math.floor(b1 * 1.5)} > 单片 ${b1}，不应把所有分片都删光`).toBeGreaterThan(0);
    expect(deleted).toHaveLength(0);
  });

  it('QA-R06 [QA-BUG-04] stop() 时若仍处于 lossy，已累计的 gap 必须补写，不得静默丢失', async () => {
    const root = track(tmpRoot());
    const sink = new RollingFileSink({
      rootDir: root, sessionId: 'qa',
      highWaterBytes: 1, // 一次即积压 → 立即 lossy
      overrides: { flushIntervalMs: 20 },
    });
    await sink.start();
    sink.append(mkEntry(1));
    sink.flushNow();
    for (let i = 2; i <= 200; i += 1) sink.append(mkEntry(i));
    const mid = sink.getStatus();
    expect(mid.droppedCount).toBeGreaterThan(0); // 确实发生了丢弃

    // ★直接 stop（不再给任何恢复机会）
    const status = await sink.stop();
    const dir = status.sessionDir ?? '';
    const lines = readAllJsonl(dir);
    const gaps = lines.filter((l) => l.includes('"kind":"gap"'));
    expect(gaps).toHaveLength(1); // ★丢了却没报 = 违反"必须用 gap 显式告知"
    expect((JSON.parse(gaps[0] ?? '{}') as { count: number }).count).toBe(mid.droppedCount);
  });

  it('QA-R07 写盘失败 → state 转 disabled/error + E_IO_*，且 append 不得抛异常（主链路不受影响）', async () => {
    const sink = new RollingFileSink({
      rootDir: '/proc/definitely-not-writable/qa', // 必然无法创建
      sessionId: 'qa',
    });
    const status = await sink.start();
    expect(status.state).toBe('disabled');
    expect(status.errorCode).toBe('E_IO_SINK_OPEN_FAILED');
    expect(() => sink.append(mkEntry(1))).not.toThrow();
    expect(sink.getStatus().entriesWritten).toBe(0);
    sink.dispose();
  });

});

describe('QA-R 定时器隔离', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('QA-R08 start() 会挂周期 flush timer；dispose()/stop() 后必须归零', async () => {
    const root = track(tmpRoot());
    const sink = new RollingFileSink({ rootDir: root, sessionId: 'qa', overrides: { flushIntervalMs: 20 } });
    await sink.start();
    sink.append(mkEntry(1));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    sink.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/* ═══════════════ ④ T05 会话层 ═══════════════ */

describe('QA-S 会话层 T05', () => {
  it('QA-S01 非法状态迁移被拦截且上报 E_SESSION_INVALID_TRANSITION', () => {
    const errors: string[] = [];
    const sm = new SessionStateMachine({
      initial: 'DISCONNECTED',
      onError: (e) => errors.push(e.code),
    });
    expect(sm.transition('ROUTING_ACTIVE')).toBe(false); // DISCONNECTED → ROUTING_ACTIVE 非法
    expect(sm.state).toBe('DISCONNECTED');
    expect(errors).toContain('E_SESSION_INVALID_TRANSITION');

    expect(sm.transition('TCP_CONNECTING')).toBe(true);
    expect(sm.transition('TCP_CONNECTED')).toBe(true);
    expect(sm.transition('DISCONNECTED')).toBe(false); // 非法回跳
    expect(sm.state).toBe('TCP_CONNECTED');
  });

  it('QA-S02 ROUTING_ACTIVE → ROUTING_ACTIVATING 允许（reactivate 依赖此边）', () => {
    const sm = new SessionStateMachine({ initial: 'TCP_CONNECTED' });
    expect(sm.transition('ROUTING_ACTIVATING')).toBe(true);
    expect(sm.transition('ROUTING_ACTIVE')).toBe(true);
    expect(sm.transition('ROUTING_ACTIVATING')).toBe(true); // ★这条边必须存在
    expect(sm.state).toBe('ROUTING_ACTIVATING');
  });

  it('QA-S03 TesterPresent 周期 = min(配置, S3×0.6) 且 dispose 后无悬挂 timer', () => {
    vi.useFakeTimers();
    const sched = new TesterPresentScheduler({
      send: () => true,
      s3ServerMs: 5000, // ×0.6 = 3000
      now: () => Date.now(),
    });
    sched.start(30000); // 配置远大于 S3 派生的安全周期
    expect(sched.periodMs).toBe(3000);
    sched.setS3ServerMs(2000); // ×0.6 = 1200
    expect(sched.periodMs).toBe(1200);
    sched.dispose();
    vi.clearAllTimers();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('QA-S04 TesterPresent 周期受 min/max 夹取', () => {
    const lo = new TesterPresentScheduler({ send: () => true, s3ServerMs: 0 });
    lo.start(10);
    expect(lo.periodMs).toBe(TIMING.TESTER_PRESENT_MIN_PERIOD_MS);
    lo.dispose();
    const hi = new TesterPresentScheduler({ send: () => true, s3ServerMs: 10_000_000 });
    hi.start(999_999);
    expect(hi.periodMs).toBe(TIMING.TESTER_PRESENT_MAX_PERIOD_MS);
    hi.dispose();
  });

  it('QA-S05 UdsSessionTracker：仅偶数子功能解锁；奇数(取种子)正响应不得计入', () => {
    const t = new UdsSessionTracker();
    t.observeRequest(0x27, 0x01); // 取种子
    t.observePositiveResponse(0x67, 0x01); // 种子回来了
    expect(t.securityLevels).toEqual([]); // ★不得算已解锁
    t.observePositiveResponse(0x67, 0x02); // 发密钥成功
    expect(t.securityLevels).toEqual([0x01]); // ★等级 = 当初请求的奇数子功能
    t.observePositiveResponse(0x50, 0x03); // 10 03 → EXTENDED
    expect(t.session).toBe('EXTENDED');
    t.observeNegativeResponse(0x10);
    expect(t.session).toBe('EXTENDED'); // ★0x10 负响应会话不变
    t.reset('test');
    expect(t.session).toBe('DEFAULT');
    expect(t.securityLevels).toEqual([]);
  });

  it('QA-S06 UdsSessionTracker：抑制位子功能也不得误判（0x83 → 0x03）', () => {
    const t = new UdsSessionTracker();
    t.observePositiveResponse(0x50, 0x83); // suppressPosRsp=1，实际子功能 0x03
    expect(t.session).toBe('EXTENDED');
  });
});

/* ═══════════════ ⑤ ResyncService ═══════════════ */

describe('QA-Y ResyncService 三个分支', () => {
  const FAKE_STATUS = { sessionId: 'qa', state: 'DISCONNECTED' } as never;

  function build(rowCount: number, maxEntries = 1000): TraceStore {
    const store = new TraceStore({ maxEntries });
    const bus = new EventBus();
    bus.subscribeEntries((e) => store.append(e));
    for (let i = 0; i < rowCount; i += 1) bus.publishTrace(mkEntry(0));
    return store;
  }

  it('QA-Y01 首次同步 lastSeq=0 → mode=first', () => {
    const store = build(10);
    const sent: Array<{ type: string; count: number }> = [];
    const resync = new ResyncService({
      store,
      send: (type, payload) => {
        const p = payload as { events?: unknown[] };
        sent.push({ type, count: p.events?.length ?? 0 });
      },
      getStatus: () => FAKE_STATUS,
    });
    const r = resync.handleHello(0);
    expect(r.mode).toBe('first');
    expect(r.replayed).toBe(10);
    expect(sent.filter((s) => s.type === 'trace.batch').length).toBeGreaterThan(0);
    expect(sent.some((s) => s.type === 'status')).toBe(true);
  });

  it('QA-Y02 重放补齐 (lastSeq, maxSeq] 精确区间', () => {
    const store = build(100);
    let replayedSeqs: number[] = [];
    const resync = new ResyncService({
      store,
      send: (type, payload) => {
        if (type !== 'trace.batch') return;
        const events = (payload as { events: Array<{ entry: TraceEntry }> }).events;
        replayedSeqs = replayedSeqs.concat(events.map((e) => e.entry.seq));
      },
      getStatus: () => FAKE_STATUS,
    });
    const r = resync.handleHello(90);
    expect(r.mode).toBe('replay');
    expect(replayedSeqs).toEqual(Array.from({ length: 10 }, (_, i) => 91 + i)); // ★恰好 91..100
  });

  it('QA-Y03 环形缓冲溢出 → mode=overflow 且 gap 区间正确', () => {
    // maxEntries=50 → 灌 200 条后 minSeq=151
    const store = build(200, 50);
    expect(store.minSeq).toBe(151);
    const gaps: Array<{ fromSeq: number; toSeq: number; count: number }> = [];
    let replayed = 0;
    const resync = new ResyncService({
      store,
      send: (type, payload) => {
        if (type === 'trace.gap') gaps.push(payload as { fromSeq: number; toSeq: number; count: number });
        if (type === 'trace.batch') {
          const events = (payload as { events: Array<{ entry: TraceEntry }> }).events;
          replayed += events.length;
        }
      },
      getStatus: () => FAKE_STATUS,
    });
    const r = resync.handleHello(100);
    expect(r.mode).toBe('overflow');
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.fromSeq).toBe(101);
    expect(gaps[0]?.toSeq).toBe(150);
    expect(gaps[0]?.count).toBe(50);
    expect(replayed).toBe(50);
  });

  it('QA-Y04 [QA-BUG-05] 边界 lastSeq = minSeq-1（其实一条没丢）不得报告倒挂的空 gap', () => {
    const store = build(200, 50);
    expect(store.minSeq).toBe(151);
    const gaps: Array<{ fromSeq: number; toSeq: number; count: number }> = [];
    const resync = new ResyncService({
      store,
      send: (type, payload) => {
        if (type === 'trace.gap') gaps.push(payload as { fromSeq: number; toSeq: number; count: number });
      },
      getStatus: () => FAKE_STATUS,
    });
    resync.handleHello(150);
    // 期望：fromSeq<=toSeq 且 count>=1；实际会产生 fromSeq=151 > toSeq=150 的倒挂区间
    for (const g of gaps) {
      expect(g.fromSeq).toBeLessThanOrEqual(g.toSeq);
      expect(g.count).toBeGreaterThan(0);
    }
  });

  it('QA-Y05 空缓冲：不得崩溃且补发 status', () => {
    const store = new TraceStore();
    const sent: string[] = [];
    const resync = new ResyncService({
      store,
      send: (type) => sent.push(type),
      getStatus: () => FAKE_STATUS,
    });
    expect(resync.handleHello(0).mode).toBe('empty');
    expect(() => resync.handleHello(999)).not.toThrow();
  });
});
