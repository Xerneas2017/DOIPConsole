/**
 * 背压三级降级（§3.12 难点 4）。
 *
 * | 级别 | 触发 | 行为 |
 * | L0 | bufferedAmount < LOW | 正常推送 |
 * | L1 | [LOW, HIGH) | 暂停 flush（队列继续攒）；超 `WS_MAX_ENTRIES_PER_BATCH` 时只保留关键事件 |
 * | L2 | ≥ HIGH 或 L1 持续 > WS_MAX_BACKPRESSURE_MS | 只推 status/error；trace 每 100 条采样保留 1 条 |
 * | 恢复 | < LOW | 补发 `trace.gap{reason:'backpressure'}` + status 快照 |
 *
 * ★seq 永不回退、永不断号：被丢弃的区间必须显式用 `trace.gap` 告知，
 *   前端据此显示灰条而不是"看起来没丢"。
 * ★关键事件（error / status）永不丢弃。
 */

import type { StreamEvent } from '@doip/shared';
import { nowMonoMs } from '@doip/shared';
import { getLogger } from '../logging/logger';
import { getLimits } from '../config/defaults';

export type PressureLevel = 'L0' | 'L1' | 'L2';

export interface GapNotice {
  fromSeq: number;
  toSeq: number;
  count: number;
  reason: 'backpressure';
}

export interface BackpressureGuardOptions {
  /** 返回当前 WS 未发送字节数（ws.bufferedAmount） */
  getBufferedAmount: () => number;
  now?: () => number;
  /** 降级/恢复时回调（用于推送 trace.gap 与 status 快照） */
  onGap?: (gap: GapNotice) => void;
  onLevelChange?: (from: PressureLevel, to: PressureLevel) => void;
}

export class BackpressureGuard {
  private readonly log = getLogger('bridge.backpressure');
  private readonly getBufferedAmount: () => number;
  private readonly now: () => number;
  private readonly onGap?: (gap: GapNotice) => void;
  private readonly onLevelChange?: (from: PressureLevel, to: PressureLevel) => void;

  private current: PressureLevel = 'L0';
  private saturatedSinceMs: number | null = null;
  private seenInL2 = 0;

  private gapFromSeq: number | null = null;
  private gapToSeq: number | null = null;
  private gapCount = 0;

  constructor(options: BackpressureGuardOptions) {
    this.getBufferedAmount = options.getBufferedAmount;
    this.now = options.now ?? nowMonoMs;
    if (options.onGap !== undefined) this.onGap = options.onGap;
    if (options.onLevelChange !== undefined) this.onLevelChange = options.onLevelChange;
  }

  get level(): PressureLevel {
    return this.current;
  }

  /** L1/L2 均视为饱和（暂停 flush） */
  isSaturated(): boolean {
    return this.current !== 'L0';
  }

  get droppedCount(): number {
    return this.gapCount;
  }

  /** 每次 flush 前调用：依据 bufferedAmount 重新判定级别 */
  update(): PressureLevel {
    const buffered = this.getBufferedAmount();
    const low = getLimits('WS_LOW_WATER_BYTES');
    const high = getLimits('WS_HIGH_WATER_BYTES');
    const nowMs = this.now();

    let next: PressureLevel = 'L0';
    if (buffered >= high) {
      next = 'L2';
    } else if (buffered >= low) {
      const since = this.saturatedSinceMs ?? nowMs;
      const sustained = nowMs - since;
      next = sustained > getLimits('WS_MAX_BACKPRESSURE_MS') ? 'L2' : 'L1';
    }

    if (next === 'L0') {
      this.saturatedSinceMs = null;
      if (this.current !== 'L0') this.recover();
    } else {
      if (this.saturatedSinceMs === null) this.saturatedSinceMs = nowMs;
      if (next !== this.current) this.moveTo(next);
    }
    this.current = next;
    return next;
  }

  /**
   * 判定一条事件在饱和期是否保留。
   * ★error / status 永不丢弃；trace 在 L2 下按 `WS_L2_SAMPLE_EVERY` 采样。
   */
  shouldKeep(event: StreamEvent): boolean {
    if (this.current === 'L0') return true;
    if (event.kind !== 'trace.entry') return true; // 关键事件
    if (this.current === 'L1') return true; // L1 只暂停 flush，不丢
    this.seenInL2 += 1;
    return this.seenInL2 % getLimits('WS_L2_SAMPLE_EVERY') === 0;
  }

  /** 记录一条被丢弃的条目（用于拼 gap 区间） */
  noteDropped(seq: number): void {
    if (this.gapFromSeq === null) this.gapFromSeq = seq;
    this.gapToSeq = seq;
    this.gapCount += 1;
  }

  /** flush 发现饱和时的钩子（§3.12 示例中的 `guard.onSaturated(queue.length)`） */
  onSaturated(queued: number): void {
    this.log.warn('WS 背压饱和，暂停推送', { level: this.current, queued });
  }

  /** 测试与重连用：强制进入 L2 */
  forceLevel(level: PressureLevel): void {
    if (level === this.current) return;
    this.moveTo(level);
    this.current = level;
    if (level !== 'L0') this.saturatedSinceMs = this.now();
  }

  reset(): void {
    this.current = 'L0';
    this.saturatedSinceMs = null;
    this.seenInL2 = 0;
    this.gapFromSeq = null;
    this.gapToSeq = null;
    this.gapCount = 0;
  }

  /* ─────────────── 内部实现 ─────────────── */

  private moveTo(next: PressureLevel): void {
    const from = this.current;
    this.onLevelChange?.(from, next);
    this.log.info('WS 背压级别变化', { from, to: next });
  }

  /** 恢复：把累计丢弃区间一次性用 trace.gap 告知前端 */
  private recover(): void {
    const from = this.current;
    this.onLevelChange?.(from, 'L0');
    if (this.gapCount > 0 && this.gapFromSeq !== null && this.gapToSeq !== null) {
      this.onGap?.({
        fromSeq: this.gapFromSeq,
        toSeq: this.gapToSeq,
        count: this.gapCount,
        reason: 'backpressure',
      });
      this.log.warn('背压恢复，已补发缺口告知', {
        fromSeq: this.gapFromSeq,
        toSeq: this.gapToSeq,
        count: this.gapCount,
      });
    }
    this.gapFromSeq = null;
    this.gapToSeq = null;
    this.gapCount = 0;
    this.seenInL2 = 0;
  }
}
