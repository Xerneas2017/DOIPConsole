import type { TraceEntry } from '@doip/shared';
import { PAIR_BORDER_COLORS, TRACE_COLORS } from '../theme';

/**
 * Trace 行着色规则（T10，PRD §6.2 C 区）。
 *
 * 优先级：超时 > NACK > NRC > 周期3E > ACK > 正响应 > 请求。
 * 配色 token 与 `theme.ts` 同源，图例与表格不会各说一套。
 */

export type RowKind =
  | 'request'
  | 'positive'
  | 'nrc'
  | 'ack'
  | 'nack'
  | 'timeout'
  | 'periodic'
  | 'neutral';

/** 判定一行的语义类别 */
export function rowKindOf(entry: TraceEntry): RowKind {
  if (entry.tags.includes('周期3E')) return 'periodic';
  if (entry.timeout) return 'timeout';
  if (entry.doip.nackCode !== null) return 'nack';
  if (entry.uds.nrc !== null) return 'nrc';
  if (entry.doip.ackCode !== null) return 'ack';
  if (entry.uds.isPositive) return 'positive';
  if (entry.txnRole === 'request') return 'request';
  return 'neutral';
}

/** 行背景色 */
export function rowBackground(kind: RowKind): string {
  switch (kind) {
    case 'request':
      return TRACE_COLORS.request;
    case 'positive':
      return TRACE_COLORS.positive;
    case 'nrc':
      return TRACE_COLORS.nrc;
    case 'ack':
      return TRACE_COLORS.ack;
    case 'nack':
      return TRACE_COLORS.nack;
    case 'timeout':
      return TRACE_COLORS.timeout;
    case 'periodic':
      return TRACE_COLORS.periodic;
    default:
      return 'transparent';
  }
}

/** 行文字色（错误类用高对比度） */
export function rowTextColor(kind: RowKind): string {
  switch (kind) {
    case 'nrc':
    case 'nack':
      return '#ffb4bb';
    case 'timeout':
      return '#9aa4b2';
    case 'positive':
      return '#8ee6b4';
    case 'ack':
      return '#8fd0ff';
    default:
      return '#e6e9ef';
  }
}

/** 是否画虚线（ACK/NACK 用虚线边框区分"传输层确认"与"应用层响应"） */
export function rowBorderStyle(kind: RowKind): 'dashed' | 'solid' | 'none' {
  if (kind === 'ack') return 'dashed';
  if (kind === 'nack' || kind === 'timeout') return 'dashed';
  return 'none';
}

/**
 * 配对左边框颜色：同一 `transactionId` 取同一色（请求↔ACK↔响应成组）。
 * 无 transactionId 的行返回 null（不画左边框）。
 *
 * ★健壮性：入参显式接受 `undefined`。历史上这里只判 `null`，而实际数据里
 *   该字段可能是"键不存在"（老版本落盘回放、手工构造的条目），
 *   `undefined.length` 会抛错并**整块打挂 C 区**（被 ErrorBoundary 兜成"渲染失败"）。
 *   一个渲染辅助函数不该有能力让主界面白屏，所以这里做宽松判定。
 */
export function pairBorderColor(transactionId: string | null | undefined): string | null {
  if (transactionId === null || transactionId === undefined || transactionId === '') return null;
  let hash = 0;
  for (let i = 0; i < transactionId.length; i += 1) {
    hash = (hash * 31 + transactionId.charCodeAt(i)) >>> 0;
  }
  const color = PAIR_BORDER_COLORS[hash % PAIR_BORDER_COLORS.length];
  return color ?? null;
}

/** 图例（工具栏"列设置/图例"里展示，配色与上面同源） */
export const ROW_LEGEND: Array<{ kind: RowKind; label: string }> = [
  { kind: 'request', label: '请求' },
  { kind: 'positive', label: '正响应' },
  { kind: 'nrc', label: 'NRC 否定响应' },
  { kind: 'ack', label: '0x8002 ACK（传输层确认）' },
  { kind: 'nack', label: '0x8003 NACK（网关未转发）' },
  { kind: 'timeout', label: '超时' },
  { kind: 'periodic', label: '周期 3E（可隐藏）' },
];
