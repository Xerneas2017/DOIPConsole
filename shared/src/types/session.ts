/**
 * 会话 / 连接 / 发现 / 仿真 的共享类型（§3.7、§3.10）。
 */

import type { DidEntry } from './library';

/* ─────────────── 连接状态机（§3.7）─────────────── */

export type ConnectionState =
  | 'DISCONNECTED'
  | 'SCANNING'
  | 'TCP_CONNECTING'
  | 'TCP_CONNECTED'
  | 'ROUTING_ACTIVATING'
  | 'ROUTING_ACTIVE'
  | 'ALIVE_CHECKING'
  | 'CLOSING'
  | 'CLOSED'
  | 'ERROR';

/** 合法迁移表（非法迁移记 warn 并拒绝） */
export const ALLOWED_TRANSITIONS: Record<ConnectionState, readonly ConnectionState[]> = {
  DISCONNECTED: ['SCANNING', 'TCP_CONNECTING', 'ERROR'],
  SCANNING: ['DISCONNECTED', 'ERROR'],
  TCP_CONNECTING: ['TCP_CONNECTED', 'ERROR', 'CLOSED'],
  TCP_CONNECTED: ['ROUTING_ACTIVATING', 'CLOSING', 'CLOSED', 'ERROR'],
  // 0x11 需确认 → 停在原态
  ROUTING_ACTIVATING: ['ROUTING_ACTIVE', 'ROUTING_ACTIVATING', 'ERROR', 'CLOSING'],
  /**
   * ★`ROUTING_ACTIVATING` 这条边是为 `ConnectionManager.reactivate()`（§3.8）补的：
   * 设计表按"首次连接"建模，未列出 `ROUTING_ACTIVE → ROUTING_ACTIVATING`，
   * 但"同一 socket 上手动重发 0x0005"必须可表达，否则重激活会被判为非法迁移而被拦。
   */
  ROUTING_ACTIVE: ['ROUTING_ACTIVATING', 'ALIVE_CHECKING', 'ROUTING_ACTIVE', 'CLOSING', 'CLOSED', 'ERROR'],
  ALIVE_CHECKING: ['ROUTING_ACTIVE', 'ERROR', 'CLOSING'],
  CLOSING: ['CLOSED', 'ERROR'],
  CLOSED: ['DISCONNECTED'],
  // 用户 dismiss 或手动重连（非自动）
  /**
   * ★`ROUTING_ACTIVATING` 这条边是 Phase 0 #1（拒绝码 → ERROR）补的：
   * 路由激活被拒绝（0x00–0x04）时 socket 仍存活、状态进入 ERROR，
   * 但"用户点「重激活」在同一 socket 重发 0x0005"必须仍可表达（Q1 允许的人工重试），
   * 否则 reactivate 会被状态机拦成非法迁移告警，且激活成功后状态无法离开 ERROR（与真实链路分叉）。
   */
  ERROR: ['DISCONNECTED', 'TCP_CONNECTING', 'ROUTING_ACTIVATING'],
};

export type UdsSessionType = 'DEFAULT' | 'PROGRAMMING' | 'EXTENDED' | 'UNKNOWN';

export interface SessionStatus {
  sessionId: string;
  state: ConnectionState;
  stateSinceMs: number;
  peer: { host: string; port: number; mode: 'real' | 'sim' } | null;
  sa: number;
  ta: number;
  activationType: number;
  protocolVersion: number;
  lastRoutingCode: number | null;
  lastRoutingCodeZh: string | null;
  udsSession: UdsSessionType;
  /** 已解锁的等级（如 [1]） */
  securityLevels: number[];
  s3RemainingMs: number | null;
  testerPresent: { enabled: boolean; periodMs: number; nextDueMs: number | null };
  counters: { tx: number; rx: number; errors: number; traceCount: number };
  lastRttMs: number | null;
}

export interface DiscoveredEntity {
  vin: string;
  eid: string;
  gid: string;
  /** '0x1000' */
  logicalAddress: string;
  ip: string;
  port: number;
  nodeType: 'gateway' | 'node' | 'unknown';
  furtherActionRequired: number;
  vinGidSyncStatus: number;
  /** true = 被动监听到的 0x0004 */
  viaAnnouncement: boolean;
  discoveredAtMs: number;
  /** 仿真实体标记，UI 打「仿真」标签 */
  isSimulated: boolean;
}

/* ─────────────── 仿真 ECU（§3.10）─────────────── */

export interface SimEntityConfig {
  /** '0x1000' */
  logicalAddress: string;
  vin: string;
  eid: string;
  gid: string;
  nodeType: 'gateway' | 'node';
  furtherActionRequired: 0 | 1;
  vinGidSyncStatus: number;
  dids: Record<string, { codec: DidEntry['codec']; valueHex: string }>;
  dtcs: Array<{ code: string; nameZh: string; status: number; snapshotHex?: string }>;
  timing: { s3ServerMs: number; p2ServerMs: number; responseDelayMs: number };
  security: {
    levels: Record<
      number,
      {
        /** 固定 seed，便于复现 */
        seedHex: string;
        /** 期望的 Key 算法（用于自动校验，T14 接入后生效） */
        keyAlgorithmId?: string;
        /** 或直接给定期望 Key */
        expectedKeyHex?: string;
        delayMs?: number;
        maxAttempts?: number;
        lockoutMs?: number;
      }
    >;
  };
  /** 未列出 → 回 NRC 0x11 */
  supportedSids: string[];
  routingActivation: { accept: boolean; forcedCode?: string; reservedOemHex?: string };
}

export interface FaultRule {
  id: string;
  enabled: boolean;
  match: {
    logicalAddress?: string;
    sid?: string;
    subFunction?: string;
    did?: string;
    occurrence?: 'once' | 'always' | 'count';
  };
  action:
    | { kind: 'nrc'; code: string } // 回 7F <sid> <nrc>
    | { kind: 'nack'; code: string } // 回 0x8003（不进 UDS）
    | { kind: 'noResponse' } // ★网关已 ACK、ECU 不回（让客户端 P2 超时）
    | { kind: 'delayMs'; ms: number } // 先 7F <sid> 78，延迟后给最终响应
    | { kind: 'dropConnection' } // 直接 RST
    | { kind: 'customHex'; hex: string } // 原样回自定义 userData
    | { kind: 'routingCode'; code: string }; // 路由激活时强制返回该码
  /** null = 无限 */
  remaining: number | null;
}

export interface SimStatus {
  running: boolean;
  port: number | null;
  entities: SimEntityConfig[];
  uptimeMs: number;
  /** B11：是否运行在独立子进程中 */
  isolatedProcess: boolean;
}
