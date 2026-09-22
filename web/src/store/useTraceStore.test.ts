import { beforeEach, describe, expect, it } from 'vitest';
import type { TraceEntry } from '@doip/shared';
import { emptyUdsDecodeResult } from '@doip/shared';
import { useTraceStore } from './useTraceStore';
import { resyncBaseSeq } from '../ws/useResync';

function entry(seq: number, overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    seq,
    transactionId: null,
    ts: '2026-09-22T10:00:00.123456Z',
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
      payloadLength: 2,
      sourceAddress: 0x0e00,
      targetAddress: 0x1000,
      sourceAddressName: null,
      targetAddressName: null,
      ackCode: null,
      ackNameZh: null,
      nackCode: null,
      nackNameZh: null,
      activationResponseCode: null,
      activationResponseCodeZh: null,
      vin: null,
      eid: null,
      gid: null,
      headerHex: '02FD800100000002',
    },
    uds: { ...emptyUdsDecodeResult(), serviceId: 0x22 },
    linkedSeq: null,
    txnRole: 'request',
    latencyMs: null,
    gatewayForwardLatencyMs: null,
    timeout: false,
    errorCode: null,
    errorNameZh: null,
    tags: [],
    rawHex: '02FD8001000000020E00100022F190',
    ...overrides,
  };
}

describe('Trace store（T09）', () => {
  beforeEach(() => {
    useTraceStore.getState().clear();
    useTraceStore.setState({ paused: false, gaps: [], droppedWhilePaused: 0 });
  });

  it('增量摄入：按 seq 升序追加并推进 lastSeq', () => {
    const store = useTraceStore.getState();
    store.ingest([entry(1), entry(2), entry(3)]);
    store.ingest([entry(4)]);
    const s = useTraceStore.getState();
    expect(s.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(s.lastSeq).toBe(4);
    expect(s.firstSeq).toBe(1);
  });

  it('★断号即登记缺口（灰条），seq 链条仍可审计', () => {
    useTraceStore.getState().ingest([entry(1), entry(5)]);
    const s = useTraceStore.getState();
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]).toMatchObject({ fromSeq: 2, toSeq: 4, count: 3, reason: 'local' });
    expect(s.lastSeq).toBe(5);
  });

  it('重复/重叠补齐不产生重复行、不误报缺口', () => {
    const store = useTraceStore.getState();
    store.ingest([entry(1), entry(2), entry(3)]);
    store.ingest([entry(2), entry(3), entry(4)]); // 重连补齐重叠
    const s = useTraceStore.getState();
    expect(s.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(s.gaps).toHaveLength(0);
  });

  it('暂停摄入：新条目只计数不入表', () => {
    const store = useTraceStore.getState();
    store.setPaused(true);
    store.ingest([entry(1), entry(2)]);
    let s = useTraceStore.getState();
    expect(s.entries).toHaveLength(0);
    expect(s.droppedWhilePaused).toBe(2);
    store.setPaused(false);
    s.ingest([entry(3)]);
    expect(useTraceStore.getState().entries.map((e) => e.seq)).toEqual([3]);
  });

  it('后端显式 trace.gap 与本地缺口合并显示', () => {
    useTraceStore.getState().addGap({ fromSeq: 10, toSeq: 12, count: 3, reason: 'backpressure' });
    useTraceStore.getState().addGap({ fromSeq: 20, toSeq: 21, count: 2, reason: 'overflow' });
    const gaps = useTraceStore.getState().gaps;
    expect(gaps.map((g) => g.reason)).toEqual(['backpressure', 'overflow']);
  });

  it('环形上限：超出 TRACE_RING_MAX_ENTRIES 去头部并推进 firstSeq', () => {
    const store = useTraceStore.getState();
    // 上限 100 000，这里只验证"超出即淘汰"的逻辑：连续灌 3 批后 firstSeq 单调推进
    for (let i = 1; i <= 3000; i += 1) store.ingest([entry(i)]);
    const s = useTraceStore.getState();
    expect(s.entries).toHaveLength(3000);
    expect(s.firstSeq).toBe(1);
    expect(s.lastSeq).toBe(3000);
  });

  /* ───────── ★QA 终验缺陷 4：缺口自愈 ───────── */

  it('★补齐起点是最靠前的缺口起点-1，而不是 lastSeq', () => {
    useTraceStore.getState().ingest([entry(1), entry(2)]);
    // 3–5 缺失，6–8 已到：lastSeq=8，但补齐必须从 2 之后开始
    useTraceStore.getState().ingest([entry(6), entry(7), entry(8)]);
    const s = useTraceStore.getState();
    expect(s.lastSeq).toBe(8);
    expect(resyncBaseSeq(s)).toBe(2);
  });

  it('★没有缺口时补齐起点就是 lastSeq（不倒退重放）', () => {
    useTraceStore.getState().ingest([entry(1), entry(2), entry(3)]);
    expect(resyncBaseSeq(useTraceStore.getState())).toBe(3);
  });

  it('★补齐回填的条目必须被真正插入（旧实现按 seq<=lastSeq 丢弃，缺口永远补不齐）', () => {
    const store = useTraceStore.getState();
    store.ingest([entry(1), entry(2)]);
    store.ingest([entry(6), entry(7), entry(8)]);
    expect(useTraceStore.getState().entries.map((e) => e.seq)).toEqual([1, 2, 6, 7, 8]);

    // 后端按 hello{lastSeq:2} 回放 3..8
    useTraceStore.getState().ingest([entry(3), entry(4), entry(5), entry(6), entry(7), entry(8)]);
    const s = useTraceStore.getState();
    expect(s.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(s.gaps).toHaveLength(0); // ★补齐后缺口必须消失
    expect(s.lastSeq).toBe(8);
  });

  it('★补齐后仍缺的那段保留（后端缓冲已回绕，不可恢复）', () => {
    const store = useTraceStore.getState();
    store.ingest([entry(1)]);
    store.ingest([entry(10)]);
    // 后端只能补回 5..10
    store.ingest([entry(5), entry(6), entry(7), entry(8), entry(9), entry(10)]);
    const s = useTraceStore.getState();
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]).toMatchObject({ fromSeq: 2, toSeq: 4 });
    expect(resyncBaseSeq(s)).toBe(1);
  });

  it('★后端声明的缺口原因不因重算被降级成 local', () => {
    const store = useTraceStore.getState();
    store.ingest([entry(1), entry(2)]);
    store.addGap({ fromSeq: 3, toSeq: 5, count: 3, reason: 'backpressure' });
    // 触发一次重算（新条目到达）
    store.ingest([entry(6)]);
    const s = useTraceStore.getState();
    expect(s.gaps).toHaveLength(1);
    expect(s.gaps[0]).toMatchObject({ fromSeq: 3, toSeq: 5, reason: 'backpressure' });
  });

  it('★乱序到达（先 6 后 3）仍能正确归并并保持升序', () => {
    const store = useTraceStore.getState();
    store.ingest([entry(1), entry(2)]);
    store.ingest([entry(6), entry(3), entry(5), entry(4)]);
    const s = useTraceStore.getState();
    expect(s.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.gaps).toHaveLength(0);
  });
});
