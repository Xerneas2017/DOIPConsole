/**
 * 事务对象与状态枚举（§3.6）。
 * `TxnState` 定义在 @doip/shared（SendUdsResult 需要引用），此处 re-export 保证单一来源。
 */

export type { TxnState } from '@doip/shared';
import type { TxnState } from '@doip/shared';

/** 功能寻址下按 SA 聚合的响应 */
export interface FunctionalResponseRef {
  sa: number;
  seq: number;
  nrc: number | null;
  atMs: number;
  hex: string;
}

export interface TxnTimers {
  ack: NodeJS.Timeout | null;
  p2: NodeJS.Timeout | null;
  p2star: NodeJS.Timeout | null;
  functional: NodeJS.Timeout | null;
  /** 抑制正响应后的 NRC 观察窗（B5） */
  suppressed: NodeJS.Timeout | null;
}

export interface Transaction {
  txnId: string;
  sessionId: string;
  createdAtMs: number;
  /** 0x8001 真正写出的时刻（延迟与网关转发耗时的基准） */
  requestAtMs: number | null;
  addressing: 'physical' | 'functional';
  sa: number;
  ta: number;
  /** 展示用：'10 03' */
  requestUdsHex: string;
  requestUdsBytes: Uint8Array;
  sid: number;
  expectedPositiveSid: number;
  suppressPositiveResponse: boolean;

  /* ── 三方配对落点 ── */
  seqRequest: number | null;
  seqAck: number | null;
  seqNack: number | null;
  seqResponses: number[];

  state: TxnState;
  stateEnteredAtMs: number;
  timers: TxnTimers;

  nackCode: number | null;
  nackNameZh: string | null;
  nrc: number | null;
  nrcNameZh: string | null;

  /** 端到端：请求 → 首个 UDS 响应 */
  latencyMs: number | null;
  /** 网关收下耗时：请求 → 0x8002 ACK */
  gatewayForwardLatencyMs: number | null;

  functionalResponses: FunctionalResponseRef[];
  responseHex: string | null;
  /** 单事务超时覆盖（来自 SendUdsRequest，缺省用 TIMING） */
  p2TimeoutMs: number | null;
  p2StarTimeoutMs: number | null;
  errorCode: string | null;
  /** 给 Trace 的人类可读结论 */
  note: string | null;
  warnCodes: string[];
}

export function isTerminalState(state: TxnState): boolean {
  return (
    state === 'COMPLETED' ||
    state === 'SUPPRESSED' ||
    state === 'FAILED_ACK_TIMEOUT' ||
    state === 'FAILED_UDS_TIMEOUT' ||
    state === 'FAILED_NACK' ||
    state === 'CANCELLED'
  );
}

export function isWaitingState(state: TxnState): boolean {
  return (
    state === 'WAITING_ACK' ||
    state === 'WAITING_UDS_RESPONSE' ||
    state === 'WAITING_PENDING' ||
    state === 'SUPPRESSED'
  );
}

export interface CreateTransactionParams {
  txnId: string;
  sessionId: string;
  addressing: 'physical' | 'functional';
  sa: number;
  ta: number;
  requestUdsBytes: Uint8Array;
  requestUdsHex: string;
  sid: number;
  expectedPositiveSid: number;
  suppressPositiveResponse: boolean;
  createdAtMs: number;
  p2TimeoutMs?: number;
  p2StarTimeoutMs?: number;
}

export function createTransaction(params: CreateTransactionParams): Transaction {
  return {
    txnId: params.txnId,
    sessionId: params.sessionId,
    createdAtMs: params.createdAtMs,
    requestAtMs: null,
    addressing: params.addressing,
    sa: params.sa,
    ta: params.ta,
    requestUdsHex: params.requestUdsHex,
    requestUdsBytes: params.requestUdsBytes,
    sid: params.sid,
    expectedPositiveSid: params.expectedPositiveSid,
    suppressPositiveResponse: params.suppressPositiveResponse,
    seqRequest: null,
    seqAck: null,
    seqNack: null,
    seqResponses: [],
    state: 'CREATED',
    stateEnteredAtMs: params.createdAtMs,
    timers: { ack: null, p2: null, p2star: null, functional: null, suppressed: null },
    nackCode: null,
    nackNameZh: null,
    nrc: null,
    nrcNameZh: null,
    latencyMs: null,
    gatewayForwardLatencyMs: null,
    functionalResponses: [],
    responseHex: null,
    p2TimeoutMs: params.p2TimeoutMs ?? null,
    p2StarTimeoutMs: params.p2StarTimeoutMs ?? null,
    errorCode: null,
    note: null,
    warnCodes: [],
  };
}

export function emptyTimers(): TxnTimers {
  return { ack: null, p2: null, p2star: null, functional: null, suppressed: null };
}
