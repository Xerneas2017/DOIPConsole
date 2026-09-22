/**
 * ★D-02：事务结果 → Trace 条目回填（§3.6 / §3.11 的接缝）。
 *
 * 为什么需要它：
 *   Trace 条目在**报文发出的那一刻**就生成并发布（seq 由 EventBus 分配），
 *   而"耗时 / 配对关系 / 事务角色"这些字段要到事务推进（收到 ACK / UDS 响应 /
 *   超时 / NACK）之后才存在。所以它们不可能在 `build()` 时填出来，
 *   必须在事务状态推进时**回写已存在的条目**并推 `trace.repatch`。
 *
 * 回填字段：
 *   - 请求条目：transactionId / txnRole='request' / linkedSeq(响应 seq) / latencyMs /
 *     gatewayForwardLatencyMs / timeout
 *   - ACK 条目：transactionId / txnRole='ack' / linkedSeq(请求 seq) / gatewayForwardLatencyMs
 *   - NACK 条目：transactionId / txnRole='nack' / linkedSeq(请求 seq) / latencyMs
 *   - 响应条目：transactionId / txnRole='response' / linkedSeq(请求 seq) / latencyMs
 *
 * ★只改派生字段，绝不改 seq / ts / rawHex（TraceStore.patch 的契约保证）。
 * ★走 EventBus.publishRepatch（与 trace.entry 同一队列），保证"先条目后回填"的顺序。
 */

import type { TraceEntry } from '@doip/shared';
import type { TraceEntryPatch, TraceStore } from '../trace/TraceStore';
import type { Transaction } from './Transaction';
import type { TxnEvent } from './TransactionManager';

export interface TxnTraceLinkerDeps {
  store: TraceStore;
  /** 把被改写的条目推给前端（EventBus.publishRepatch） */
  publish: (entries: TraceEntry[]) => void;
}

interface SeqPatch {
  seq: number;
  patch: TraceEntryPatch;
}

const TIMEOUT_STATES: ReadonlySet<string> = new Set(['FAILED_ACK_TIMEOUT', 'FAILED_UDS_TIMEOUT']);

export class TxnTraceLinker {
  private readonly deps: TxnTraceLinkerDeps;

  constructor(deps: TxnTraceLinkerDeps) {
    this.deps = deps;
  }

  /**
   * 处理一条事务事件。
   * ★只对 `state` 事件做回填：`created` 时帧还没发出（seqRequest 仍为空），
   *   过早回填会漏掉请求条目。
   */
  handle(event: TxnEvent): void {
    if (event.kind !== 'state') return;
    const patches = TxnTraceLinker.patchesOf(event.txn);
    if (patches.length === 0) return;
    const changed = this.deps.store.patchMany(patches);
    if (changed.length === 0) return;
    this.deps.publish(changed);
  }

  /** 由事务快照推导全部回填指令（纯函数，便于单测） */
  static patchesOf(txn: Transaction): SeqPatch[] {
    const patches: SeqPatch[] = [];
    const requestSeq = txn.seqRequest ?? null;
    const ackSeq = txn.seqAck ?? null;
    const nackSeq = txn.seqNack ?? null;
    const responseSeqs = txn.seqResponses.filter((s) => s > 0);
    const firstResponseSeq = responseSeqs[0] ?? null;
    const timeout = TIMEOUT_STATES.has(txn.state);

    /* ① 请求条目：耗时与配对都挂在它身上（C 区"耗时(ms)"列与事务高亮读的就是它） */
    if (requestSeq !== null && requestSeq > 0) {
      patches.push({
        seq: requestSeq,
        patch: {
          transactionId: txn.txnId,
          txnRole: 'request',
          linkedSeq: firstResponseSeq ?? ackSeq ?? nackSeq,
          ...(txn.latencyMs === null ? {} : { latencyMs: txn.latencyMs }),
          ...(txn.gatewayForwardLatencyMs === null
            ? {}
            : { gatewayForwardLatencyMs: txn.gatewayForwardLatencyMs }),
          timeout,
        },
      });
    }

    /* ② 网关 ACK（0x8002）：只体现"网关转发耗时"，不算 UDS 层耗时 */
    if (ackSeq !== null && ackSeq > 0) {
      patches.push({
        seq: ackSeq,
        patch: {
          transactionId: txn.txnId,
          txnRole: 'ack',
          linkedSeq: requestSeq,
          ...(txn.gatewayForwardLatencyMs === null
            ? {}
            : { gatewayForwardLatencyMs: txn.gatewayForwardLatencyMs }),
          timeout,
        },
      });
    }

    /* ③ 网关 NACK（0x8003）：网关层结论，latencyMs = 到 NACK 为止的耗时 */
    if (nackSeq !== null && nackSeq > 0) {
      patches.push({
        seq: nackSeq,
        patch: {
          transactionId: txn.txnId,
          txnRole: 'nack',
          linkedSeq: requestSeq,
          ...(txn.latencyMs === null ? {} : { latencyMs: txn.latencyMs }),
          timeout,
        },
      });
    }

    /* ④ UDS 响应（0x8001 RX）：功能寻址下会有多条，逐条挂到同一事务 */
    for (const seq of responseSeqs) {
      patches.push({
        seq,
        patch: {
          transactionId: txn.txnId,
          txnRole: 'response',
          linkedSeq: requestSeq,
          ...(txn.latencyMs === null ? {} : { latencyMs: txn.latencyMs }),
          timeout,
        },
      });
    }

    return patches;
  }
}
