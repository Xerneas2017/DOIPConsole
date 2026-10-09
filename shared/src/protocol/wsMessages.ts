/**
 * WebSocket 消息契约（§3.12）—— 前后端唯一契约源。
 *
 * 运行时校验用 zod（用户可编辑的库 JSON 与 WS 消息都是不可信输入）；
 * schema 同时产出 TS 类型，避免契约与类型两份维护。
 */

import { z } from 'zod';
import type { DiscoveredEntity, SessionStatus, SimEntityConfig, SimStatus, FaultRule } from '../types/session';
import type { TraceEntry, ExportRequest, RecordingStatus, RecordingConfigOverrides, LogFileStatus } from '../types/trace';
import type {
  KeyAlgorithmDescriptor,
  KeyTestVector,
  KeyTrialResult,
  UnlockResult,
  UdsLibrary,
  ValidationIssue,
} from '../types/library';

/* ─────────────── 事务状态（§3.6，server/src/txn/Transaction.ts 会 re-export）─────────────── */

export type TxnState =
  | 'CREATED'
  | 'WAITING_ACK'
  | 'WAITING_UDS_RESPONSE'
  | 'WAITING_PENDING'
  | 'COMPLETED'
  | 'SUPPRESSED'
  | 'FAILED_ACK_TIMEOUT'
  | 'FAILED_UDS_TIMEOUT'
  | 'FAILED_NACK'
  | 'CANCELLED';

/* ─────────────── 错误对象 ─────────────── */

export const WsErrorSchema = z.object({
  code: z.string(),
  messageZh: z.string(),
  hintZh: z.string().optional(),
  severity: z.enum(['info', 'warn', 'error']),
  /** ★P0-14：与 Trace 行互跳 */
  linkedSeq: z.number().optional(),
  retryable: z.boolean().optional(),
  detail: z.unknown().optional(),
});

export type WsError = z.infer<typeof WsErrorSchema>;

export function isWsError(value: unknown): value is WsError {
  return WsErrorSchema.safeParse(value).success;
}

/* ─────────────── 请求 / 结果 ─────────────── */

export const SendUdsRequestSchema = z.object({
  addressing: z.enum(['physical', 'functional']),
  /** 二选一：表单模式给 sid/sub/did；原始模式给 hex */
  sid: z.string().optional(),
  subFunction: z.string().optional(),
  dids: z.array(z.string()).optional(),
  dataHex: z.string().optional(),
  rawHex: z.string().optional(),
  /** 默认 true */
  expectResponse: z.boolean().optional(),
  /**
   * ★Phase 0 #4：危险操作二次确认契约（与前端确认弹窗同口径）。
   * 危险请求 = SID 0x11/0x14/0x2E/0x31 + 0x27 偶数子功能（发送密钥）。
   * 后端 `UdsService.sendUdsRequest()` 强制门禁：未带 confirmed:true 一律拒绝，
   * **原始 hex 模式同样生效，不得绕过**；内部专用流程（0x27 解锁向导等）显式传 confirmed:true。
   */
  confirmed: z.boolean().optional(),
  p2TimeoutMs: z.number().optional(),
  p2StarTimeoutMs: z.number().optional(),
  /** 如 '周期3E' */
  tag: z.string().optional(),
  /** 供上层（未来脚本）做关联 */
  txnHint: z.string().optional(),
});

export type SendUdsRequest = z.infer<typeof SendUdsRequestSchema>;

export interface SendUdsResult {
  ok: boolean;
  txnId: string;
  state: TxnState;
  responseHex?: string;
  nrc?: number;
  nrcNameZh?: string;
  nackCode?: number;
  nackNameZh?: string;
  latencyMs?: number;
  gatewayForwardLatencyMs?: number;
  errorCode?: string;
  note?: string;
  /** 功能寻址：多响应按 SA 分组 */
  functionalResponses?: Array<{ sa: number; hex: string; nrc: number | null }>;
}

export const ConnectConfigSchema = z.object({
  mode: z.enum(['real', 'sim']),
  host: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  /** 逻辑地址字符串形式：'0x0E00'（§8.4） */
  sa: z.string(),
  ta: z.string(),
  activationType: z.string().optional(),
  protocolVersion: z.string().optional(),
});

export type ConnectConfig = z.infer<typeof ConnectConfigSchema>;

/* ─────────────── 后端 → 前端 ─────────────── */

export interface WsEnvelope<T = unknown> {
  v: 1;
  type: string;
  /** 仅"可重放流事件"带 seq；控制类（hello/pong/cmd.ack）不带 */
  seq?: number;
  /** epoch ms */
  ts: number;
  payload: T;
}

/**
 * 可重放流事件。
 *
 * ★D-02：`trace.repatch` 是**事务字段回填**通道（latencyMs / linkedSeq / txnRole / transactionId）。
 *   它必须走与 `trace.entry` 同一条队列（BatchFlusher），否则会出现
 *   "回填先到、条目后到 → applyRepatch 找不到该 seq → 回填被静默丢弃"的竞态。
 *   ★它不是新条目：前端按 seq 就地替换，绝不新增行、绝不改 seq。
 */
export type StreamEvent =
  | { kind: 'trace.entry'; entry: TraceEntry }
  | { kind: 'trace.repatch'; entries: TraceEntry[] }
  | { kind: 'status'; status: SessionStatus }
  | { kind: 'error'; error: WsError };

export type ServerEvent =
  | { type: 'hello'; payload: { serverVersion: string; seqNow: number; traceMinSeq: number; traceMaxSeq: number } }
  | { type: 'pong'; payload: { t: number } }
  | { type: 'trace.batch'; payload: { events: StreamEvent[] } }
  | { type: 'trace.gap'; payload: { fromSeq: number; toSeq: number; count: number; reason: 'backpressure' | 'overflow' } }
  | { type: 'trace.repatch'; payload: { entries: TraceEntry[] } }
  /** ★变更 1：长挂机落盘状态/路径/进度（§3.11.1） */
  | { type: 'trace.logfile'; payload: RecordingStatus }
  | { type: 'status'; payload: SessionStatus }
  | { type: 'scan.result'; payload: { entities: DiscoveredEntity[]; partial: boolean } }
  | { type: 'sim.status'; payload: SimStatus }
  | { type: 'library.snapshot'; payload: UdsLibrary }
  /** 库更新被拒（zod/语义校验失败），带可定位的 issues */
  | { type: 'library.rejected'; payload: { issues: ValidationIssue[] } }
  /** T14：可选算法清单 + 全部测试向量（供试算同屏对照） */
  /**
   * `recommendedId`：默认应选中的算法。
   * ★QA 终验缺陷 3：此前前端默认选 `list[0]`（占位算法），一键解锁开箱必吃 NRC 0x35。
   *   后端才知道"当前目标 ECU 期望哪套算法"（仿真 = 逐字节异或 0x5A；真实 = 已验证的移植算法），
   *   所以这个选择必须由后端给出，前端不得自作主张取第一条。
   */
  | {
      type: 'library.algorithms';
      payload: {
        algorithms: KeyAlgorithmDescriptor[];
        vectors: KeyTestVector[];
        recommendedId: string | null;
      };
    }
  | { type: 'keyAlgo.trial'; payload: KeyTrialResult }
  | { type: 'security.unlocked'; payload: UnlockResult }
  | { type: 'error'; payload: WsError }
  | { type: 'cmd.ack'; payload: { id: string; ok: boolean; error?: WsError } }
  | { type: 'export.ready'; payload: { id: string; downloadUrl: string; filename: string; bytes: number } }
  /** 后端运行日志状态 + 可选尾部内容（自我排查用，见 `log.*` 指令） */
  | { type: 'log.info'; payload: { status: LogFileStatus; lines?: string[]; truncated?: boolean } }
  | { type: 'uds.result'; payload: SendUdsResult };

/* ─────────────── 前端 → 后端 ─────────────── */

export type ClientCommand =
  | { type: 'session.hello'; id: string; payload: { lastSeq: number } }
  | { type: 'scan.request'; id: string; payload: { targetIp?: string; timeoutMs?: number; passive?: boolean } }
  | { type: 'connect.request'; id: string; payload: ConnectConfig }
  | { type: 'disconnect'; id: string; payload: { reason?: string } }
  | { type: 'routing.reactivate'; id: string; payload: Record<string, never> }
  | { type: 'target.set'; id: string; payload: { ta: string } }
  | { type: 'uds.send'; id: string; payload: SendUdsRequest }
  /**
   * ★P0#4：`confirmed` 是危险操作（0x27 解锁等）的人工确认标记。
   * 前端只在用户通过强确认对话框后置 true；后端对未验证算法/危险 SID 缺省视为 false 并拒绝。
   */
  | { type: 'security.unlock'; id: string; payload: { level: number; keyAlgorithmId?: string; customKeyHex?: string; confirmed?: boolean } }
  | { type: 'testerPresent'; id: string; payload: { enable: boolean; periodMs?: number; subFunction?: string } }
  | { type: 'sim.start'; id: string; payload: { entities?: SimEntityConfig[]; port?: number } }
  | { type: 'sim.stop'; id: string; payload: Record<string, never> }
  | { type: 'sim.injectFault'; id: string; payload: { rules: FaultRule[] } }
  | { type: 'library.get'; id: string; payload: Record<string, never> }
  | { type: 'library.update'; id: string; payload: { library: UdsLibrary } }
  /** 恢复内置库：只合并新增内置项，绝不覆盖自定义项 */
  | { type: 'library.reset'; id: string; payload: { scope: 'builtin' } }
  | { type: 'keyAlgo.list'; id: string; payload: { level?: number } }
  | { type: 'keyAlgo.trial'; id: string; payload: { algorithmId: string; level: number; seedHex: string } }
  | { type: 'trace.resync'; id: string; payload: { fromSeq: number } }
  | { type: 'trace.clear'; id: string; payload: Record<string, never> }
  /* ★变更 1：长挂机滚动落盘控制 */
  | { type: 'record.start'; id: string; payload: { sessionDir?: string; overrides?: RecordingConfigOverrides } }
  | { type: 'record.stop'; id: string; payload: Record<string, never> }
  | { type: 'record.status'; id: string; payload: Record<string, never> }
  /** 本机打开文件管理器 */
  | { type: 'record.openDir'; id: string; payload: { dir?: string } }
  /* 后端运行日志（自我排查）：状态 / 尾部内容 / 打开目录 */
  | { type: 'log.status'; id: string; payload: Record<string, never> }
  | { type: 'log.tail'; id: string; payload: { lines?: number } }
  | { type: 'log.openDir'; id: string; payload: { sub?: string } }
  | { type: 'export.request'; id: string; payload: ExportRequest }
  /**
   * ★应用层心跳：后端回 `pong{t}`。
   * 浏览器对 WS 协议层 ping 的自动 pong 在应用层**不可见**，
   * 前端失活检测只能依赖应用层消息 —— 没有这一条，空闲 45 s 就会被误判失联而重连。
   */
  | { type: 'ping'; id: string; payload: { t: number } };

/** record.start 允许前端覆盖的落盘参数（其余取 RECORDING 常量） */
export const RecordingConfigOverridesSchema = z.object({
  maxEntriesPerFile: z.number().int().positive().optional(),
  maxFileBytes: z.number().int().positive().optional(),
  maxFileDurationMs: z.number().int().positive().optional(),
  flushIntervalMs: z.number().int().positive().optional(),
  retainMaxBytesPerSession: z.number().int().positive().optional(),
});

/** 只校验信封（type/id/payload 存在），具体 payload 由各路由自行校验 */
export const ClientCommandEnvelopeSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  payload: z.unknown(),
});

export function parseClientCommand(input: unknown): ClientCommand | null {
  const parsed = ClientCommandEnvelopeSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data as ClientCommand;
}

export function parseSendUdsRequest(input: unknown): SendUdsRequest | null {
  const parsed = SendUdsRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
