import { memo } from 'react';
import type { TraceEntry } from '@doip/shared';
import { TRACE_COLUMNS, type TraceColumnId } from '../../store/useUiStore';
import { pairBorderColor, rowBackground, rowBorderStyle, rowKindOf, rowTextColor } from '../../decode/colorRules';
import { addressPair, decodeSummary, formatRel, formatTs, hex4, rawHexDisplay, tagText } from '../../decode/displayStrings';
import { ROW_HEIGHT } from './useVirtualRows';

/**
 * 单行渲染（T10）：着色 + 配对左边框 + 组 hover 高亮。
 * 用 `memo` + 固定行高，保证 10 000 行滚动时只重渲视口内行。
 */

export interface TraceRowProps {
  entry: TraceEntry;
  columns: TraceColumnId[];
  selected: boolean;
  /** 与 hover 行同 transactionId → 整组高亮 */
  groupHighlight: boolean;
  useUtc: boolean;
  onSelect: (seq: number) => void;
  onHoverTxn: (txnId: string | null) => void;
}

function cellText(entry: TraceEntry, column: TraceColumnId, useUtc: boolean): string {
  switch (column) {
    case 'seq':
      return String(entry.seq);
    case 'ts':
      return formatTs(entry.ts, useUtc);
    case 'rel':
      return formatRel(entry.tsRelMs);
    case 'transport':
      return entry.transport;
    case 'dir':
      return entry.direction;
    case 'pt':
      return `${hex4(entry.doip.payloadType)} ${entry.doip.payloadTypeNameZh ?? entry.doip.payloadTypeName}`;
    case 'addr':
      return addressPair(entry);
    case 'len':
      return String(entry.doip.payloadLength);
    case 'decode':
      return decodeSummary(entry);
    case 'raw':
      return rawHexDisplay(entry);
    case 'latency':
      return entry.latencyMs === null ? '-' : entry.latencyMs.toFixed(1);
    case 'tags':
      return tagText(entry);
    default:
      return '';
  }
}

function TraceRowImpl({
  entry,
  columns,
  selected,
  groupHighlight,
  useUtc,
  onSelect,
  onHoverTxn,
}: TraceRowProps): JSX.Element {
  const kind = rowKindOf(entry);
  const bg = rowBackground(kind);
  const border = pairBorderColor(entry.transactionId);
  const borderStyle = rowBorderStyle(kind);

  return (
    <div
      className="flex items-center"
      style={{
        height: ROW_HEIGHT,
        background: selected ? '#264066' : groupHighlight ? '#1b2534' : bg,
        color: rowTextColor(kind),
        borderLeft: border === null ? undefined : `3px solid ${border}`,
        borderTop: borderStyle === 'none' ? undefined : `1px ${borderStyle} #3a4358`,
        cursor: 'pointer',
        fontSize: 12,
      }}
      onClick={() => onSelect(entry.seq)}
      onMouseEnter={() => onHoverTxn(entry.transactionId)}
      onMouseLeave={() => onHoverTxn(null)}
      title={`seq ${entry.seq}｜${entry.txnRole ?? '-'}｜${entry.transactionId ?? '无事务'}`}
    >
      {TRACE_COLUMNS.filter((c) => columns.includes(c.id)).map((c) => (
        <div
          key={c.id}
          className="trace-cell mono px-1"
          style={{ width: c.width, minWidth: c.width, flex: `0 0 ${c.width}px` }}
        >
          {cellText(entry, c.id, useUtc)}
        </div>
      ))}
    </div>
  );
}

export const TraceRow = memo(TraceRowImpl);
