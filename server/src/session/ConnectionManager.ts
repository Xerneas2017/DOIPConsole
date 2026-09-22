/**
 * 连接管理器（§3.8，Q4 落点）。
 *
 * - P0 只实例化一个 `DoipSession`（sessionId='default'），但 API 全部以 sessionId 为参数，
 *   P1 多标签页只需加 UI 与 activeId 切换。
 * - ★Q1：不自动重连。`connect()` 失败后停在 ERROR，重连只能由用户再次点击触发。
 * - `setTargetAddress()` 只改 TA，不重建 socket（DoIP 路由激活针对 socket 而非 TA）。
 */

import type { ConnectConfig, SendUdsRequest, SendUdsResult, SessionStatus } from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { DoipSession } from './DoipSession';
import type { DoipSessionOptions } from './DoipSession';

export interface ConnectionManagerOptions extends DoipSessionOptions {
  /** P0 固定单会话；保留字段以便 P1 多标签页扩展 */
  defaultSessionId?: string;
}

export class ConnectionManager {
  private readonly log = getLogger('session.manager');
  private readonly sessions = new Map<string, DoipSession>();
  private activeId: string | null = null;
  private readonly defaultSessionId: string;
  private readonly sessionOptions: DoipSessionOptions;

  constructor(options: ConnectionManagerOptions = {}) {
    const { defaultSessionId, ...rest } = options;
    this.defaultSessionId = defaultSessionId ?? 'default';
    this.sessionOptions = rest;
  }

  get activeSessionId(): string | null {
    return this.activeId;
  }

  get(sessionId?: string): DoipSession | undefined {
    return this.sessions.get(this.resolveId(sessionId));
  }

  list(): SessionStatus[] {
    const out: SessionStatus[] = [];
    for (const session of this.sessions.values()) out.push(session.status);
    return out;
  }

  /** 连接（复用或新建会话）→ 建 socket → 路由激活 */
  async connect(cfg: ConnectConfig, sessionId?: string): Promise<SessionStatus> {
    const id = this.resolveId(sessionId);
    const session = this.ensureSession(id);
    this.activeId = id;
    return session.connect(cfg);
  }

  /** ★手动重激活（Q1 唯一允许的"重发"） */
  async reactivate(sessionId?: string): Promise<SessionStatus> {
    const session = this.mustGet(sessionId);
    return session.reactivate();
  }

  async disconnect(reason = 'user-disconnect', sessionId?: string): Promise<void> {
    const id = this.resolveId(sessionId);
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.disconnect(reason);
    if (this.activeId === id) this.activeId = null;
  }

  /** ★Q4：切换 TA 不重建连接 */
  setTargetAddress(ta: number, sessionId?: string): void {
    this.mustGet(sessionId).setTargetAddress(ta);
  }

  async sendUds(req: SendUdsRequest, sessionId?: string): Promise<SendUdsResult> {
    return this.mustGet(sessionId).sendUds(req);
  }

  setTesterPresent(enabled: boolean, periodMs?: number, sessionId?: string): void {
    this.mustGet(sessionId).setTesterPresent(enabled, periodMs);
  }

  statusOf(sessionId?: string): SessionStatus | null {
    return this.sessions.get(this.resolveId(sessionId))?.status ?? null;
  }

  /** 释放所有会话（★保证无悬挂 timer，进程可自行退出） */
  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.activeId = null;
  }

  /* ─────────────── 内部实现 ─────────────── */

  private resolveId(sessionId?: string): string {
    return sessionId ?? this.activeId ?? this.defaultSessionId;
  }

  private ensureSession(id: string): DoipSession {
    const existing = this.sessions.get(id);
    if (existing !== undefined) return existing;
    const session = new DoipSession({
      ...this.sessionOptions,
      sessionId: id,
    });
    this.sessions.set(id, session);
    this.log.info('会话已创建', { sessionId: id });
    return session;
  }

  private mustGet(sessionId?: string): DoipSession {
    const id = this.resolveId(sessionId);
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new AppError('E_CONN_NOT_CONNECTED', `会话 ${id} 尚未创建，请先连接`);
    }
    return session;
  }
}
