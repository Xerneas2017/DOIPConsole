/**
 * EventBus —— 后端内部事件 → 外部（WS / 落盘）的**唯一出口**（§8.8）。
 *
 * ★唯一 seq 分配点（§3.12）：任何模块都不得自己产号，否则前端 seq 会分叉。
 *
 * ★★变更 1 的关键拓扑（§3.11.1）：
 *
 *        EventBus.publishTrace(entry)  ← 唯一 seq 分配点
 *                    │
 *        ┌───────────┴────────────┐
 *        ▼                        ▼
 *   subscribeEntries 订阅者      streamSink(=BatchFlusher)
 *   （TraceStore / RollingFileSink）
 *   ——平级、全量、不可降级        ——可降级（L1/L2 背压）、50ms 打包
 *
 * `RollingFileSink` **必须**走 `subscribeEntries()`，绝不消费 BatchFlusher 的输出；
 * 否则 WS 一旦触发 L2 降级，落盘会跟着丢报文，兜底就失效了。
 */

import type { SessionStatus, StreamEvent, TraceEntry, WsError } from '@doip/shared';
import { getLogger } from '../logging/logger';

export type EntrySubscriber = (entry: TraceEntry) => void;
export type StreamSink = (event: StreamEvent) => void;

export class EventBus {
  private readonly log = getLogger('bridge.bus');
  private seq = 0;
  private readonly entrySubscribers = new Set<EntrySubscriber>();
  private streamSink: StreamSink | null = null;

  /** 全局单调、永不回退、永不断号的 seq */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  get seqNow(): number {
    return this.seq;
  }

  /**
   * 平级订阅（全量、不可被背压降级）。
   * @returns 取消订阅函数
   */
  subscribeEntries(fn: EntrySubscriber): () => void {
    this.entrySubscribers.add(fn);
    return () => {
      this.entrySubscribers.delete(fn);
    };
  }

  /** 设置 WS 侧的流出口（BatchFlusher.enqueue） */
  setStreamSink(sink: StreamSink | null): void {
    this.streamSink = sink;
  }

  /** 唯一的 Trace 发布入口：分配 seq → 平级订阅者 → WS 流 */
  publishTrace(entry: TraceEntry): TraceEntry {
    entry.seq = this.nextSeq();
    for (const sub of this.entrySubscribers) {
      try {
        sub(entry);
      } catch (err) {
        // ★订阅者异常绝不能影响主链路（落盘失败不得拖垮连接）
        this.log.error('Trace 订阅者抛出异常', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.streamSink?.({ kind: 'trace.entry', entry });
    return entry;
  }

  /**
   * ★D-02：事务字段回填（latencyMs / linkedSeq / txnRole / transactionId）。
   *
   * ★必须走 `streamSink`（与 trace.entry 同一条 BatchFlusher 队列）：
   *   若另开一条直连 WS 的通道，"回填"可能先于"条目"到达前端，
   *   `applyRepatch` 找不到该 seq 就会静默丢弃，耗时列永远是 `-`。
   */
  publishRepatch(entries: TraceEntry[]): void {
    if (entries.length === 0) return;
    this.streamSink?.({ kind: 'trace.repatch', entries });
  }

  publishStatus(status: SessionStatus): void {
    this.streamSink?.({ kind: 'status', status });
  }

  publishError(error: WsError): void {
    this.streamSink?.({ kind: 'error', error });
  }

  publishEvent(event: StreamEvent): void {
    this.streamSink?.(event);
  }
}
