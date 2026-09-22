/**
 * T07 WS 桥接与背压单测（§9.1 TC-B01 ~ TC-B04）。
 * 另含：EventBus 单一 seq 分配点、ResyncService 三条补齐分支。
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { emptyUdsDecodeResult } from '@doip/shared';
import type { SessionStatus, StreamEvent, TraceEntry } from '@doip/shared';
import { EventBus } from '../bridge/EventBus';
import { BatchFlusher, estimateBytes } from '../bridge/BatchFlusher';
import { BackpressureGuard } from '../bridge/BackpressureGuard';
import { ResyncService } from '../bridge/ResyncService';
import { TraceStore } from '../trace/TraceStore';

function makeEntry(seq: number): TraceEntry {
  return {
    seq,
    transactionId: null,
    ts: '2026-09-22T10:00:00.000000Z',
    tsRelMs: seq,
    transport: 'TCP',
    direction: 'TX',
    peer: '127.0.0.1:13401',
    sessionId: 'default',
    doip: {
      protocolVersion: 0x02,
      inverseVersionValid: true,
      payloadType: 0x8001,
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
  };
}

/** 收集 BatchFlusher 实际发出的批次 */
interface SentBatch {
  type: string;
  events: StreamEvent[];
}

function makeFlusher(bufferedRef: { value: number }) {
  const sent: SentBatch[] = [];
  const gaps: Array<{ fromSeq: number; toSeq: number; count: number; reason: 'backpressure' }> = [];
  const flusher = new BatchFlusher({
    getBufferedAmount: () => bufferedRef.value,
    send: (envelope) => {
      sent.push({
        type: envelope.type,
        events: (envelope.payload as { events: StreamEvent[] }).events,
      });
    },
    onGap: (gap) => gaps.push(gap),
  });
  return { flusher, sent, gaps };
}

describe('EventBus —— 唯一 seq 分配点', () => {
  it('seq 全局单调、永不断号；平级订阅者收到全量', () => {
    const bus = new EventBus();
    const sinkA: TraceEntry[] = [];
    const sinkB: TraceEntry[] = [];
    bus.subscribeEntries((e) => sinkA.push(e));
    bus.subscribeEntries((e) => sinkB.push(e));
    const streamed: TraceEntry[] = [];
    bus.setStreamSink((ev) => {
      if (ev.kind === 'trace.entry') streamed.push(ev.entry);
    });
    for (let i = 0; i < 5; i += 1) bus.publishTrace(makeEntry(0));
    expect(sinkA.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(sinkB.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(streamed.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(bus.seqNow).toBe(5);
  });

  it('订阅者抛异常不影响主链路（落盘失败不得拖垮连接）', () => {
    const bus = new EventBus();
    const ok: TraceEntry[] = [];
    bus.subscribeEntries(() => {
      throw new Error('落盘炸了');
    });
    bus.subscribeEntries((e) => ok.push(e));
    expect(() => bus.publishTrace(makeEntry(0))).not.toThrow();
    expect(ok).toHaveLength(1);
  });
});

describe('TC-B01 50 ms 打包', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('未满阈值时按 50 ms 打包成一批', () => {
    const buffered = { value: 0 };
    const { flusher, sent } = makeFlusher(buffered);
    flusher.enqueue({ kind: 'trace.entry', entry: makeEntry(1) });
    flusher.enqueue({ kind: 'trace.entry', entry: makeEntry(2) });
    flusher.enqueue({ kind: 'trace.entry', entry: makeEntry(3) });
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe('trace.batch');
    expect(sent[0]?.events).toHaveLength(3);
    flusher.dispose();
  });

  it('★dispose 后无悬挂 timer', () => {
    const buffered = { value: 0 };
    const { flusher } = makeFlusher(buffered);
    flusher.enqueue({ kind: 'trace.entry', entry: makeEntry(1) });
    expect(vi.getTimerCount()).toBe(1);
    flusher.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TC-B02 数量/字节阈值立即 flush', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('达到 WS_MAX_ENTRIES_PER_BATCH(500) 立即 flush，不等 50ms', () => {
    const buffered = { value: 0 };
    const { flusher, sent } = makeFlusher(buffered);
    for (let i = 1; i <= 500; i += 1) flusher.enqueue({ kind: 'trace.entry', entry: makeEntry(i) });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.events).toHaveLength(500);
    flusher.dispose();
  });

  it('estimateBytes 对大帧敏感（rawHex 是大头）', () => {
    const small = estimateBytes({ kind: 'trace.entry', entry: makeEntry(1) });
    const big = estimateBytes({
      kind: 'trace.entry',
      entry: { ...makeEntry(2), rawHex: 'AB'.repeat(4096) },
    });
    expect(big).toBeGreaterThan(small * 10);
  });
});

describe('TC-B03 / B04 三级背压与 trace.gap', () => {
  it('L2 降级丢弃普通条目但保留 error/status；恢复后补发 trace.gap 且 seq 不断号', () => {
    const buffered = { value: 2 * 1024 * 1024 }; // ≥ WS_HIGH_WATER_BYTES → L2
    const { flusher, sent, gaps } = makeFlusher(buffered);
    const bus = new EventBus();
    const store = new TraceStore();
    bus.subscribeEntries((e) => store.append(e));
    bus.setStreamSink((ev) => flusher.enqueue(ev));

    for (let i = 1; i <= 300; i += 1) bus.publishTrace(makeEntry(0));
    // 关键事件永不丢弃
    bus.publishError({
      code: 'E_TXN_UDS_TIMEOUT',
      messageZh: '超时',
      severity: 'error',
    });
    flusher.flush();

    const streamedSeqs: number[] = [];
    for (const batch of sent) {
      for (const ev of batch.events) {
        if (ev.kind === 'trace.entry') streamedSeqs.push(ev.entry.seq);
      }
    }
    // L2：每 100 条采样保留 1 条 → 300 条只推了 3 条
    expect(streamedSeqs.length).toBeLessThan(10);
    // error 事件被保留
    const errorEvents = sent.flatMap((b) => b.events.filter((e) => e.kind === 'error'));
    expect(errorEvents).toHaveLength(1);
    // ★seq 在缓冲中不断号
    expect(store.size).toBe(300);
    expect(store.minSeq).toBe(1);
    expect(store.maxSeq).toBe(300);

    // 恢复 → 补发 gap
    expect(gaps).toHaveLength(0);
    buffered.value = 0;
    flusher.flush();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.reason).toBe('backpressure');
    expect(gaps[0]?.count).toBeGreaterThan(0);
    expect(gaps[0]?.fromSeq).toBeLessThanOrEqual(gaps[0]?.toSeq ?? 0);
    flusher.dispose();
  });

  it('BackpressureGuard：L0 → L1 → L2 → 恢复 的级别判定', () => {
    let buffered = 0;
    const guard = new BackpressureGuard({ getBufferedAmount: () => buffered });
    expect(guard.update()).toBe('L0');

    buffered = 300 * 1024; // [LOW, HIGH)
    expect(guard.update()).toBe('L1');
    expect(guard.isSaturated()).toBe(true);

    buffered = 2 * 1024 * 1024; // ≥ HIGH
    expect(guard.update()).toBe('L2');

    buffered = 0;
    expect(guard.update()).toBe('L0');
    expect(guard.isSaturated()).toBe(false);
  });
});

describe('ResyncService 断线补齐三条分支', () => {
  function setup() {
    const store = new TraceStore({ maxEntries: 5000 });
    const sent: Array<{ type: string; payload: unknown }> = [];
    const status: SessionStatus = {
      sessionId: 'default',
      state: 'ROUTING_ACTIVE',
      stateSinceMs: 0,
      peer: null,
      sa: 0x0e00,
      ta: 0x1000,
      activationType: 0,
      protocolVersion: 0x02,
      lastRoutingCode: 0x10,
      lastRoutingCodeZh: '路由激活成功',
      udsSession: 'DEFAULT',
      securityLevels: [],
      s3RemainingMs: null,
      testerPresent: { enabled: false, periodMs: 2000, nextDueMs: null },
      counters: { tx: 0, rx: 0, errors: 0, traceCount: 0 },
      lastRttMs: null,
    };
    const resync = new ResyncService({
      store,
      send: (type, payload) => sent.push({ type, payload }),
      getStatus: () => status,
    });
    return { store, sent, resync };
  }

  it('lastSeq=0 → 快照（最近 TRACE_RESYNC_SNAPSHOT_ENTRIES 条）+ status', () => {
    const { store, sent, resync } = setup();
    for (let i = 1; i <= 2500; i += 1) store.append(makeEntry(i));
    const report = resync.handleHello(0);
    expect(report.mode).toBe('first');
    expect(report.replayed).toBe(2000);
    const batches = sent.filter((s) => s.type === 'trace.batch');
    // 每包 500 条 → 4 包
    expect(batches).toHaveLength(4);
    expect(sent.some((s) => s.type === 'status')).toBe(true);
  });

  it('lastSeq 在缓冲内 → 只补齐 (lastSeq, maxSeq]', () => {
    const { store, sent, resync } = setup();
    for (let i = 1; i <= 100; i += 1) store.append(makeEntry(i));
    const report = resync.handleHello(90);
    expect(report.mode).toBe('replay');
    expect(report.replayed).toBe(10);
    const firstBatch = sent.find((s) => s.type === 'trace.batch');
    const events = (firstBatch?.payload as { events: StreamEvent[] }).events;
    expect(events).toHaveLength(10);
    expect((events[0] as { entry: TraceEntry }).entry.seq).toBe(91);
  });

  it('lastSeq < minSeq（缓冲已回绕）→ trace.gap{reason:overflow} + 现有全部条目', () => {
    const { store, sent, resync } = setup();
    for (let i = 101; i <= 200; i += 1) store.append(makeEntry(i));
    const report = resync.handleHello(50);
    expect(report.mode).toBe('overflow');
    expect(report.gap?.fromSeq).toBe(51);
    const gapEvent = sent.find((s) => s.type === 'trace.gap');
    expect(gapEvent).toBeDefined();
    expect((gapEvent?.payload as { reason: string }).reason).toBe('overflow');
    expect((gapEvent?.payload as { fromSeq: number }).fromSeq).toBe(51);
    expect(report.replayed).toBe(100);
  });

  it('补齐结束后强制补发 status 快照', () => {
    const { store, sent, resync } = setup();
    store.append(makeEntry(1));
    resync.handleHello(1);
    expect(sent.at(-1)?.type).toBe('status');
  });
});

