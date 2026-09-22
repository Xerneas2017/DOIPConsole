/**
 * 前端类型出口：契约一律以 `@doip/shared` 为唯一来源，此处只做 re-export，
 * 避免前后端各写一份类型（§3 契约一致性）。
 */

export type {
  TraceEntry,
  ExportFormat,
  ExportRequest,
  RecordingStatus,
  RecordingState,
  LogFileInfo,
  RecordingConfigOverrides,
} from '@doip/shared';

export type {
  SessionStatus,
  ConnectionState,
  UdsSessionType,
  DiscoveredEntity,
  SimStatus,
  SimEntityConfig,
  FaultRule,
} from '@doip/shared';

export type {
  ClientCommand,
  ServerEvent,
  StreamEvent,
  WsEnvelope,
  WsError,
  SendUdsRequest,
  SendUdsResult,
  ConnectConfig,
  TxnState,
} from '@doip/shared';

export type { UdsDecodeResult, DecodeNode } from '@doip/shared';
