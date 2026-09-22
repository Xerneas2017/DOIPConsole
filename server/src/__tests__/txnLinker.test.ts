import type { TraceEntry } from '@doip/shared';
import { describe, expect, it } from 'vitest';
import { TxnTraceLinker } from '../txn/TxnTraceLinker';
import { createTransaction } from '../txn/Transaction';
import type { Transaction } from '../txn/Transaction';
import { TraceStore } from '../trace/TraceStore';

/** 最小可用的 TraceEntry 替身（TraceStore 需要 rawHex 来估算字节） */
function fakeEntry(seq: number): TraceEntry {
  return {
    seq,
    rawHex: '02 FD 80 01 00 00 00 06 0E 00 10 00 10 03',
    transactionId: null,
    txnRole: null,
    linkedSeq: null,
    latencyMs: null,
    gatewayForwardLatencyMs: null,
    timeout: false,
  } as unknown as TraceEntry;
}

/**
 * ★D-02 回归：事务结果（耗时 / 配对 / 角色）必须真回填到 Trace 条目。
 *
 * 这是我们的核心卖点（三方配对 + 耗时可审计），之前 TraceEntry 里
 * 只有 transactionId，latencyMs / linkedSeq / txnRole 全是空 ——
 * 耗时列永远显示 `-`、事务高亮永远不触发、CSV 事务列永远空。
 */

function txn(
  overrides: Partial<Transaction> = {},
): Transaction {
  return Object.assign(
    createTransaction({
      txnId: 'tx-0001',
      sessionId: 'default',
      addressing: 'physical',
      sa: 0x0e00,
      ta: 0x1000,
      requestUdsBytes: Uint8Array.from([0x10, 0x03]),
      requestUdsHex: '10 03',
      sid: 0x10,
      expectedPositiveSid: 0x50,
      suppressPositiveResponse: false,
      createdAtMs: 0,
    }),
    overrides,
  );
}

describe('D-02 — 事务字段回填', () => {
  it('完整事务：请求/ACK/响应三条各自拿到正确角色与配对', () => {
    const patches = TxnTraceLinker.patchesOf(
      txn({
        state: 'COMPLETED',
        seqRequest: 10,
        seqAck: 11,
        seqResponses: [12],
        latencyMs: 42.5,
        gatewayForwardLatencyMs: 3.25,
      }),
    );
    const bySeq = new Map(patches.map((p) => [p.seq, p.patch]));
    expect(bySeq.get(10)).toMatchObject({
      transactionId: 'tx-0001',
      txnRole: 'request',
      linkedSeq: 12,
      latencyMs: 42.5,
      gatewayForwardLatencyMs: 3.25,
      timeout: false,
    });
    expect(bySeq.get(11)).toMatchObject({
      txnRole: 'ack',
      linkedSeq: 10,
      gatewayForwardLatencyMs: 3.25,
    });
    expect(bySeq.get(12)).toMatchObject({
      txnRole: 'response',
      linkedSeq: 10,
      latencyMs: 42.5,
    });
  });

  it('网关没收下（FAILED_ACK_TIMEOUT）：请求条目被标记 timeout', () => {
    const patches = TxnTraceLinker.patchesOf(
      txn({ state: 'FAILED_ACK_TIMEOUT', seqRequest: 10 }),
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]?.patch).toMatchObject({ txnRole: 'request', timeout: true });
  });

  it('NACK：nack 条目拿到耗时（网关层结论）', () => {
    const patches = TxnTraceLinker.patchesOf(
      txn({ state: 'FAILED_NACK', seqRequest: 10, seqNack: 11, latencyMs: 7 }),
    );
    const bySeq = new Map(patches.map((p) => [p.seq, p.patch]));
    expect(bySeq.get(11)).toMatchObject({ txnRole: 'nack', latencyMs: 7 });
  });

  it('功能寻址多条响应：每条都挂到同一事务', () => {
    const patches = TxnTraceLinker.patchesOf(
      txn({ state: 'COMPLETED', seqRequest: 10, seqResponses: [12, 13, 14], latencyMs: 5 }),
    );
    expect(patches.filter((p) => p.patch.txnRole === 'response')).toHaveLength(3);
  });

  it('★Store.patch 只改派生字段，seq / rawHex 原样保留', () => {
    const store = new TraceStore();
    store.append(fakeEntry(10));
    const changed = store.patch(10, {
      transactionId: 'tx-0001',
      txnRole: 'request',
      latencyMs: 12.5,
    });
    expect(changed).not.toBeNull();
    const stored = store.bySeq(10);
    expect(stored?.transactionId).toBe('tx-0001');
    expect(stored?.txnRole).toBe('request');
    expect(stored?.latencyMs).toBe(12.5);
    expect(stored?.seq).toBe(10);
    expect((stored as unknown as { rawHex: string }).rawHex).toBe(fakeEntry(10).rawHex);
  });

  it('patch 不存在的 seq 返回 null（已淘汰或尚未发布，绝不幽灵插入）', () => {
    const store = new TraceStore();
    store.append(fakeEntry(1));
    expect(store.patch(999, { transactionId: 'x' })).toBeNull();
    expect(store.size).toBe(1);
  });

  it('★幂等：重复回填同一值不产生第二次推送', () => {
    const store = new TraceStore();
    store.append(fakeEntry(1));
    expect(store.patch(1, { transactionId: 'tx-0001' })).not.toBeNull();
    expect(store.patch(1, { transactionId: 'tx-0001' })).toBeNull();
  });

  it('二分查找：10 万条缓冲下也能命中（不退化成 O(n) 全扫）', () => {
    const store = new TraceStore({ maxEntries: 200_000 });
    for (let i = 1; i <= 100_000; i += 1) store.append(fakeEntry(i));
    expect(store.patch(99_999, { transactionId: 'tx-1' })).not.toBeNull();
    expect(store.patch(1, { transactionId: 'tx-2' })).not.toBeNull();
  });

  it('linker 只对 state 事件回填（created 时帧还没发出，seqRequest 为空）', () => {
    const store = new TraceStore();
    store.append(fakeEntry(10));
    const published: unknown[] = [];
    const linker = new TxnTraceLinker({ store, publish: (e) => published.push(e) });
    linker.handle({ kind: 'created', txn: txn() });
    expect(published).toHaveLength(0);
    linker.handle({ kind: 'state', txn: txn({ seqRequest: 10 }), from: 'CREATED', to: 'WAITING_ACK' });
    expect(published).toHaveLength(1);
    expect(store.bySeq(10)?.transactionId).toBe('tx-0001');
  });
});
