/**
 * TesterPresent（3E）周期任务 + S3 倒计时（§3.7 / §5.4）。
 *
 * 实际周期 = clamp(min(配置周期, S3_server × TESTER_PRESENT_SAFETY_FACTOR),
 *                  TESTER_PRESENT_MIN_PERIOD_MS, TESTER_PRESENT_MAX_PERIOD_MS)
 * ——★这样即使 S3 只有 5 s、用户又填了 30 s，也不会因为周期过长而掉会话。
 *
 * ★Q1：本调度器只负责"按周期发"，失败不自动补发；发送结果交给上层决定是否上报。
 * ★无悬挂 timer：`stop()` / `dispose()` 必须清干净，`dispose()` 后进程可自行退出。
 */

import { nowMonoMs } from '@doip/shared';
import { getLogger } from '../logging/logger';
import { getTiming } from '../config/defaults';

export interface TesterPresentTickInfo {
  /** 本次已发出的条数（从 1 开始） */
  tick: number;
  periodMs: number;
  /** 下一次发送的相对时刻（ms）；null = 已停止 */
  nextDueMs: number | null;
  /** S3 剩余时间估算（ms）；null = 未知 */
  s3RemainingMs: number | null;
}

export interface TesterPresentSchedulerOptions {
  /** 实际发送一帧 3E；返回 false 视为失败（不自动补发，★Q1） */
  send: () => Promise<boolean> | boolean;
  /** 每次发送后回调（用于广播 status 与 S3 倒计时） */
  onTick?: (info: TesterPresentTickInfo) => void;
  /** 服务端 S3 时长（ms）；来自 ECU 能力或配置，默认取 TIMING.S3_SERVER_DEFAULT_MS */
  s3ServerMs?: number;
  now?: () => number;
}

export class TesterPresentScheduler {
  private readonly log = getLogger('session.testerPresent');
  private readonly send: () => Promise<boolean> | boolean;
  private readonly onTick?: (info: TesterPresentTickInfo) => void;
  private readonly now: () => number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private configuredPeriodMs: number;
  private effectivePeriodMs: number;
  private s3ServerMs: number;
  private tickCount = 0;
  private lastActivityMs: number;
  private disposed = false;

  constructor(options: TesterPresentSchedulerOptions) {
    this.send = options.send;
    if (options.onTick !== undefined) this.onTick = options.onTick;
    this.now = options.now ?? nowMonoMs;
    this.configuredPeriodMs = getTiming('TESTER_PRESENT_PERIOD_MS');
    this.s3ServerMs = options.s3ServerMs ?? getTiming('S3_SERVER_DEFAULT_MS');
    this.effectivePeriodMs = this.computeEffectivePeriod();
    this.lastActivityMs = this.now();
  }

  get enabled(): boolean {
    return this.running;
  }

  get periodMs(): number {
    return this.effectivePeriodMs;
  }

  get configuredMs(): number {
    return this.configuredPeriodMs;
  }

  /** 下一次发送的相对时刻（ms）；null = 未启用 */
  get nextDueMs(): number | null {
    if (!this.running) return null;
    const elapsed = this.now() - this.lastActivityMs;
    const remaining = this.effectivePeriodMs - elapsed;
    return remaining > 0 ? remaining : 0;
  }

  /** S3 剩余时间（ms）；未启用时返回 null */
  getS3RemainingMs(): number | null {
    if (!this.running) return null;
    const remaining = this.s3ServerMs - (this.now() - this.lastActivityMs);
    return remaining > 0 ? remaining : 0;
  }

  /** 任何一次诊断活动都会刷新 S3 计时（不只是 3E） */
  notifyActivity(): void {
    this.lastActivityMs = this.now();
  }

  setS3ServerMs(ms: number): void {
    this.s3ServerMs = ms;
    if (this.running) this.restart();
    else this.effectivePeriodMs = this.computeEffectivePeriod();
  }

  /** 启动周期任务；periodMs 省略则沿用上次配置 */
  start(periodMs?: number): void {
    if (this.disposed) return;
    if (periodMs !== undefined && periodMs > 0) this.configuredPeriodMs = periodMs;
    this.effectivePeriodMs = this.computeEffectivePeriod();
    if (this.running) {
      this.clearTimer();
    }
    this.running = true;
    this.lastActivityMs = this.now();
    this.schedule();
    this.log.info('TesterPresent 已启动', {
      configuredMs: this.configuredPeriodMs,
      effectiveMs: this.effectivePeriodMs,
    });
  }

  stop(): void {
    if (!this.running) {
      this.clearTimer();
      return;
    }
    this.running = false;
    this.clearTimer();
    this.log.info('TesterPresent 已停止', { sent: this.tickCount });
  }

  /** 释放资源（进程退出前调用，确保无悬挂 timer） */
  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.clearTimer();
  }

  /* ─────────────── 内部实现 ─────────────── */

  private computeEffectivePeriod(): number {
    const safe = Math.floor(this.s3ServerMs * getTiming('TESTER_PRESENT_SAFETY_FACTOR'));
    const candidate = Math.min(this.configuredPeriodMs, safe > 0 ? safe : this.configuredPeriodMs);
    const min = getTiming('TESTER_PRESENT_MIN_PERIOD_MS');
    const max = getTiming('TESTER_PRESENT_MAX_PERIOD_MS');
    return Math.min(max, Math.max(min, candidate));
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fire();
    }, this.effectivePeriodMs);
  }

  private restart(): void {
    this.effectivePeriodMs = this.computeEffectivePeriod();
    if (this.running) this.schedule();
  }

  private async fire(): Promise<void> {
    if (!this.running || this.disposed) return;
    let ok = false;
    try {
      ok = await this.send();
    } catch (err) {
      // ★Q1：不补发、不重试；仅记录，由上层决定是否上报
      this.log.warn('TesterPresent 发送抛出异常', { message: err instanceof Error ? err.message : String(err) });
    }
    this.tickCount += 1;
    this.lastActivityMs = this.now();
    this.onTick?.({
      tick: this.tickCount,
      periodMs: this.effectivePeriodMs,
      nextDueMs: this.nextDueMs,
      s3RemainingMs: this.getS3RemainingMs(),
    });
    if (!ok) {
      this.log.warn('TesterPresent 发送失败（未自动补发）', { tick: this.tickCount });
    }
    if (this.running) this.schedule();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
