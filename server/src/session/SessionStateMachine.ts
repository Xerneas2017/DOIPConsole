/**
 * 会话连接状态机（§3.7）。
 *
 * 迁移表来自 `shared/src/types/session.ts` 的 `ALLOWED_TRANSITIONS`：
 *  - 合法迁移 → 落库 + 记 info
 *  - 非法迁移 → **拒绝** 并记 warn + 上报 `E_SESSION_INVALID_TRANSITION`（绝不静默放行）
 *
 * ★Q1：本类不做任何自动重试 / 自动重连；`ERROR → TCP_CONNECTING` 只允许上层显式触发。
 */

import { ALLOWED_TRANSITIONS } from '@doip/shared';
import type { ConnectionState, WsError } from '@doip/shared';
import { nowMonoMs } from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';

export interface StateChangeRecord {
  from: ConnectionState;
  to: ConnectionState;
  atMs: number;
  reason: string | null;
}

export interface SessionStateMachineOptions {
  initial?: ConnectionState;
  /** 状态变化（含被拒绝的非法迁移）回调 */
  onChange?: (record: StateChangeRecord & { accepted: boolean }) => void;
  /** 非法迁移时的错误上报（供 EventBus → 前端） */
  onError?: (error: AppError) => void;
}

export class SessionStateMachine {
  private readonly log = getLogger('session.state');
  private current: ConnectionState;
  private sinceMs: number;
  private readonly history: StateChangeRecord[] = [];
  private readonly onChange?: (record: StateChangeRecord & { accepted: boolean }) => void;
  private readonly onError?: (error: AppError) => void;

  constructor(options: SessionStateMachineOptions = {}) {
    this.current = options.initial ?? 'DISCONNECTED';
    this.sinceMs = nowMonoMs();
    if (options.onChange !== undefined) this.onChange = options.onChange;
    if (options.onError !== undefined) this.onError = options.onError;
  }

  get state(): ConnectionState {
    return this.current;
  }

  /** 当前状态已持续时长（ms） */
  get stateSinceMs(): number {
    return nowMonoMs() - this.sinceMs;
  }

  /** 状态迁移历史（最多保留最近 100 条，供排查） */
  getHistory(): readonly StateChangeRecord[] {
    return this.history;
  }

  canTransition(to: ConnectionState): boolean {
    return (ALLOWED_TRANSITIONS[this.current] ?? []).includes(to);
  }

  /**
   * 执行状态迁移。
   * @returns true = 已迁移；false = 非法迁移被拦截（已记 warn 并上报）
   */
  transition(to: ConnectionState, reason: string | null = null): boolean {
    if (this.current === to) {
      // 停留在原态（如 0x11「需确认」场景）是合法的，但不重复记录
      return true;
    }
    const atMs = nowMonoMs();
    if (!this.canTransition(to)) {
      const messageZh = `非法状态迁移 ${this.current} → ${to}，已忽略`;
      this.log.warn(messageZh, { from: this.current, to });
      this.onChange?.({ from: this.current, to, atMs, reason, accepted: false });
      this.onError?.(new AppError('E_SESSION_INVALID_TRANSITION', messageZh, { detail: { from: this.current, to } }));
      return false;
    }
    const from = this.current;
    this.current = to;
    this.sinceMs = atMs;
    this.history.push({ from, to, atMs, reason });
    if (this.history.length > 100) this.history.shift();
    this.log.info('会话状态迁移', { from, to, reason });
    this.onChange?.({ from, to, atMs, reason, accepted: true });
    return true;
  }

  /** 强制置位（仅用于 dispose / 测试重置，绕过迁移表） */
  force(state: ConnectionState, reason: string | null = null): void {
    const from = this.current;
    const atMs = nowMonoMs();
    this.current = state;
    this.sinceMs = atMs;
    this.history.push({ from, to: state, atMs, reason });
    if (this.history.length > 100) this.history.shift();
  }
}

/** 把会话状态机的非法迁移转成前端可消费的 WsError（错误文案由错误码表统一给出） */
export function invalidTransitionError(from: ConnectionState, to: ConnectionState): WsError {
  return new AppError('E_SESSION_INVALID_TRANSITION', `非法状态迁移 ${from} → ${to}，已忽略`, {
    detail: { from, to },
  }).toWsError();
}
