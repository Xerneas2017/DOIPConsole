/**
 * Trace 条目与导出请求（§3.11）。
 * 字段名与 JSON 导出逐字一致（§8.1），避免映射层。
 */

import type { UdsDecodeResult } from './uds';

export interface TraceEntry {
  /** 全局单调（后端 EventBus 分配） */
  seq: number;
  /** 三方配对键 */
  transactionId: string | null;
  /** ISO8601 UTC，μs：'2026-09-21T10:00:00.123456Z' */
  ts: string;
  /** 相对会话起点 */
  tsRelMs: number;
  transport: 'TCP' | 'UDP';
  direction: 'TX' | 'RX';
  /** '192.168.1.10:13400' */
  peer: string;
  sessionId: string;

  doip: {
    protocolVersion: number;
    inverseVersionValid: boolean;
    payloadType: number;
    payloadTypeName: string;
    payloadTypeNameZh: string;
    payloadLength: number;
    sourceAddress: number | null;
    targetAddress: number | null;
    sourceAddressName: string | null;
    targetAddressName: string | null;
    ackCode: number | null;
    ackNameZh: string | null;
    nackCode: number | null;
    nackNameZh: string | null;
    activationResponseCode: number | null;
    activationResponseCodeZh: string | null;
    vin: string | null;
    eid: string | null;
    gid: string | null;
    /** 8 字节头，大写无空格 */
    headerHex: string;
  };

  uds: UdsDecodeResult;

  /** 配对的上一条（请求→ACK→响应 成链） */
  linkedSeq: number | null;
  txnRole: 'request' | 'ack' | 'nack' | 'response' | 'unsolicited' | null;
  latencyMs: number | null;
  gatewayForwardLatencyMs: number | null;
  timeout: boolean;
  errorCode: string | null;
  errorNameZh: string | null;
  /** ['周期3E'] ['unsolicited'] */
  tags: string[];
  /** 完整帧（含头），大写无空格 */
  rawHex: string;
}

/** ★变更 1：新增 jsonl（与落盘分片同格式） */
export type ExportFormat = 'csv' | 'json' | 'jsonl' | 'hexdump';

export interface ExportRequest {
  format: ExportFormat;
  sessionId?: string;
  scope: 'all' | 'filtered' | 'selected';
  /** scope=filtered 时由前端回传表达式，后端重放过滤 */
  filterExpr?: string;
  seqRange?: [number, number];
  includeTags?: { hidePeriodicTesterPresent: boolean };
}

/* ─────────────── ★变更 1：长挂机滚动落盘（§3.11.1）─────────────── */

/** 单个分片的信息（写进 index.json） */
export interface LogFileInfo {
  /** 'trace-000001.jsonl' */
  file: string;
  absolutePath: string;
  seqRange: [number, number];
  entries: number;
  bytes: number;
  startedAtMs: number;
  endedAtMs: number | null;
}

export type RecordingState = 'recording' | 'stopped' | 'disabled' | 'error';

export interface RecordingStatus {
  state: RecordingState;
  /** '~/.doip-console/trace-logs/20260922-103012-default' */
  sessionDir: string | null;
  currentFile: string | null;
  /** 已滚动完成的 + 当前分片 */
  files: LogFileInfo[];
  /** 本次会话累计写入条数 */
  entriesWritten: number;
  bytesWritten: number;
  /** 落盘侧丢弃计数（背压/写失败） */
  droppedCount: number;
  startedAtMs: number | null;
  /** state==='error'|'disabled' 时的原因 */
  errorCode?: string;
  errorNameZh?: string;
}

/** record.start 允许前端覆盖的落盘参数（其余取 RECORDING 常量） */
export interface RecordingConfigOverrides {
  maxEntriesPerFile?: number;
  maxFileBytes?: number;
  maxFileDurationMs?: number;
  flushIntervalMs?: number;
  retainMaxBytesPerSession?: number;
}

/**
 * 后端运行日志状态（自我排查用）。
 *
 * ★这是"日志落文件"能力的对外契约：终端关掉也能留痕，界面里可直接看尾部。
 * `dropped > 0` 表示日志本身有丢行，读日志时要意识到这一点。
 */
export interface LogFileStatus {
  /** 日志目录绝对路径，如 `~/.doip-console/logs` */
  dir: string;
  /** 当前正在写的文件绝对路径 */
  file: string;
  /** 当前文件已写字节 */
  bytes: number;
  /** 本进程累计写入行数 */
  lines: number;
  /** 因 IO 失败被丢弃的行数（>0 说明日志不完整） */
  dropped: number;
  /** 写入流出现背压的次数（观测用，不代表丢数据） */
  backpressureHits: number;
  /** 目录下保留的日志文件清单（新的在前） */
  files: string[];
}
