/**
 * UDS 解码结果类型（§3.5）—— T12 的 UdsDecoder 产出本结构。
 * M1 不实现解码器，但事务层需要其中的字段语义（sid/nrc/pending），
 * 因此类型先落地，保证后续模块契约一致。
 */

export interface DecodeNode {
  /** 相对 userData 起始 */
  offset: number;
  length: number;
  field: string; // 'sid' | 'subFunction' | 'dataIdentifier' | ...
  /** 大写、空格分隔（UI）；导出用 hexCompact */
  valueHex: string;
  nameEn?: string;
  nameZh?: string;
  shortZh?: string;
  /** 人类可读解释 */
  meaning?: string;
  children?: DecodeNode[];
}

export interface UdsDecodeResult {
  /** false = 未能识别，不抛异常 */
  decoded: boolean;
  serviceId: number | null;
  serviceName: string | null;
  shortEn: string | null;
  shortZh: string | null;
  isPositive: boolean;
  messageKind: 'request' | 'positive' | 'negative' | 'unknown';
  subFunction: number | null;
  subFunctionName: string | null;
  subFunctionNameZh: string | null;
  suppressPositiveResponse: boolean;
  did: number | null;
  didName: string | null;
  didNameZh: string | null;
  nrc: number | null;
  nrcName: string | null;
  nrcNameZh: string | null;
  nrcHint: string | null;
  params: Array<{ name: string; value: string; offset: number }>;
  tree: DecodeNode | null;
}

/** 空解码结果（M1 未接入服务库时的占位，保证 Trace 结构稳定） */
export function emptyUdsDecodeResult(): UdsDecodeResult {
  return {
    decoded: false,
    serviceId: null,
    serviceName: null,
    shortEn: null,
    shortZh: null,
    isPositive: false,
    messageKind: 'unknown',
    subFunction: null,
    subFunctionName: null,
    subFunctionNameZh: null,
    suppressPositiveResponse: false,
    did: null,
    didName: null,
    didNameZh: null,
    nrc: null,
    nrcName: null,
    nrcNameZh: null,
    nrcHint: null,
    params: [],
    tree: null,
  };
}

/** Key 算法执行上下文（§3.9） */
export interface KeyContext {
  level: number;
  seed: Uint8Array;
  params?: Record<string, unknown>;
}
