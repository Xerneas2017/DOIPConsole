/**
 * 50 ms 批量打包（§3.12 难点 4）。
 *
 * 规则：
 *  ① 数量 ≥ WS_MAX_ENTRIES_PER_BATCH 或 字节 ≥ WS_MAX_BYTES_PER_BATCH → 立即 flush（不等 50 ms）；
 *  ② 否则确保有一个 50 ms 后的 flush；
 *  ③ flush 时若背压饱和 → 队列继续攒，并按级别丢弃普通条目（关键事件永不丢）；
 *  ④ 恢复时补发 `trace.gap`（由 BackpressureGuard 触发）。
 *
 * ★seq 由 EventBus 分配，本类只决定"发不发"，永不改号。
 */

import type { StreamEvent, WsEnvelope } from '@doip/shared';
import { getLogger } from '../logging/logger';
import { getLimits, getTiming } from '../config/defaults';
import { BackpressureGuard } from './BackpressureGuard';
import type { BackpressureGuardOptions } from './BackpressureGuard';

export type EnvelopeSender = (envelope: WsEnvelope<unknown>) => void;

export interface BatchFlusherOptions extends BackpressureGuardOptions {
  send: EnvelopeSender;
}

/** 粗估一条事件的字节数（不序列化，避免打包开销） */
export function estimateBytes(event: StreamEvent): number {
  switch (event.kind) {
    case 'trace.entry':
      // rawHex 是大头：2 字符/字节，加上其余字段的粗略常数
      return event.entry.rawHex.length + 256;
    case 'trace.repatch': {
      // ★D-02：回填只带派生字段，但整条条目会被序列化回传，按 rawHex 粗估
      let total = 0;
      for (const entry of event.entries) total += entry.rawHex.length + 256;
      return total;
    }
    case 'status':
      return 512;
    case 'error':
      return 256;
    default:
      return 128;
  }
}

export class BatchFlusher {
  private readonly log = getLogger('bridge.flusher');
  private readonly send: EnvelopeSender;
  readonly guard: BackpressureGuard;

  private queue: StreamEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private approxBytes = 0;

  constructor(options: BatchFlusherOptions) {
    this.send = options.send;
    this.guard = new BackpressureGuard({
      getBufferedAmount: options.getBufferedAmount,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.onGap === undefined ? {} : { onGap: options.onGap }),
      ...(options.onLevelChange === undefined ? {} : { onLevelChange: options.onLevelChange }),
    });
  }

  get pending(): number {
    return this.queue.length;
  }

  enqueue(event: StreamEvent): void {
    this.queue.push(event);
    this.approxBytes += estimateBytes(event);

    // ① 数量 / 字节超阈 → 立即 flush
    if (
      this.queue.length >= getLimits('WS_MAX_ENTRIES_PER_BATCH') ||
      this.approxBytes >= getLimits('WS_MAX_BYTES_PER_BATCH')
    ) {
      this.flush();
      return;
    }
    // ② 否则确保有一个 50 ms（或背压复查周期）后的 flush
    if (this.timer === null) this.schedule();
  }

  flush(): void {
    this.clearTimer();
    if (this.queue.length === 0) return;

    const level = this.guard.update();
    if (this.guard.isSaturated()) {
      this.guard.onSaturated(this.queue.length);
      // 饱和：只保留关键事件 + L2 采样，其余计数丢弃
      const kept: StreamEvent[] = [];
      let droppedInFlush = 0;
      for (const event of this.queue) {
        if (this.guard.shouldKeep(event)) {
          kept.push(event);
        } else {
          droppedInFlush += 1;
          if (event.kind === 'trace.entry') this.guard.noteDropped(event.entry.seq);
        }
      }
      // 关键事件（status/error）即便饱和也要推；trace 条目则继续攒
      const critical = kept.filter((e) => e.kind !== 'trace.entry');
      const traces = kept.filter((e) => e.kind === 'trace.entry');
      this.queue = traces;
      this.approxBytes = traces.reduce((sum, e) => sum + estimateBytes(e), 0);
      if (droppedInFlush > 0) {
        this.log.debug('背压丢弃条目', { level, droppedInFlush });
      }
      if (critical.length > 0) {
        for (const event of critical) this.deliver([event]);
      }
      // 队列仍有内容 → 安排下一次复查
      if (this.queue.length > 0) this.schedule();
      return;
    }

    const events = this.queue;
    this.queue = [];
    this.approxBytes = 0;
    this.deliver(events);
  }

  /** 释放（★进程退出前调用，确保无悬挂 timer） */
  dispose(): void {
    this.clearTimer();
    this.queue = [];
    this.approxBytes = 0;
    this.guard.reset();
  }

  /* ─────────────── 内部实现 ─────────────── */

  private schedule(): void {
    this.clearTimer();
    const delay = this.guard.isSaturated()
      ? getTiming('WS_BACKPRESSURE_RECHECK_MS')
      : getTiming('WS_PUSH_FLUSH_INTERVAL_MS');
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delay);
  }

  private deliver(events: StreamEvent[]): void {
    if (events.length === 0) return;
    const envelope: WsEnvelope<{ events: StreamEvent[] }> = {
      v: 1,
      type: 'trace.batch',
      ts: Date.now(),
      payload: { events },
    };
    try {
      this.send(envelope);
    } catch (err) {
      this.log.warn('WS 推送失败', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
