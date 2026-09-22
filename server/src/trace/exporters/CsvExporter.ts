/**
 * CSV 导出器（§3.11 / P0-04）。
 *
 * 三条硬要求：
 *  1. 首字节写 **UTF-8 BOM**（EF BB BF）——否则 Excel 打开中文列名乱码；
 *  2. `\r\n` 换行（Excel 与 RFC4180 兼容最好）；
 *  3. 字段按 RFC4180 转义：含 `"` / `,` / `\r` / `\n` 的字段用双引号包裹，内部 `"` 写成 `""`。
 */

import type { TraceEntry } from '@doip/shared';
import { formatCode, formatDid, formatHex16, formatLogicalAddress } from '@doip/shared';

/** Excel 正确识别 UTF-8 所需 */
export const UTF8_BOM: readonly number[] = [0xef, 0xbb, 0xbf];

/** 固定列顺序（§3.11，P0-04 验收逐列核对） */
export const CSV_COLUMNS: readonly string[] = [
  'seq',
  '时间戳',
  '相对时间(ms)',
  '传输层',
  '方向',
  '对端',
  'PayloadType',
  'PT名称(中)',
  'SA',
  'SA名称',
  'TA',
  'TA名称',
  '长度',
  '服务(短中英)',
  '子功能',
  'DID',
  'DID名称',
  'NRC',
  'NRC名称(中)',
  '事务ID',
  '配对seq',
  '延迟(ms)',
  '网关转发耗时(ms)',
  '标签',
  '错误码',
  '原始HEX',
];

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function num(value: number | null): string {
  return value === null ? '' : String(value);
}

function shortService(entry: TraceEntry): string {
  const { uds } = entry;
  if (uds.shortZh === null && uds.shortEn === null) {
    return uds.serviceId === null ? '' : formatCode(uds.serviceId);
  }
  const en = uds.shortEn ?? '';
  const zh = uds.shortZh ?? '';
  return zh === '' ? en : `${zh}(${en})`;
}

export function csvRow(entry: TraceEntry): string {
  const fields: string[] = [
    String(entry.seq),
    entry.ts,
    num(entry.tsRelMs),
    entry.transport,
    entry.direction,
    entry.peer,
    /**
     * ★以下三列是 16 位值，必须用不去掩码的 4 位 hex：
     *   PayloadType 0x8001 若被 `formatCode()` 掩成 0x01，会和 0x0001 撞车；
     *   SA/TA 同理（0x0E00 → 0x00）。Excel 按列筛选排序因此失效。
     */
    formatHex16(entry.doip.payloadType),
    entry.doip.payloadTypeNameZh,
    entry.doip.sourceAddress === null ? '' : formatLogicalAddress(entry.doip.sourceAddress),
    entry.doip.sourceAddressName ?? '',
    entry.doip.targetAddress === null ? '' : formatLogicalAddress(entry.doip.targetAddress),
    entry.doip.targetAddressName ?? '',
    String(entry.doip.payloadLength),
    shortService(entry),
    entry.uds.subFunction === null ? '' : formatCode(entry.uds.subFunction),
    entry.uds.did === null ? '' : formatDid(entry.uds.did),
    entry.uds.didNameZh ?? entry.uds.didName ?? '',
    entry.uds.nrc === null ? '' : formatCode(entry.uds.nrc),
    entry.uds.nrcNameZh ?? entry.uds.nrcName ?? '',
    entry.transactionId ?? '',
    num(entry.linkedSeq),
    num(entry.latencyMs),
    num(entry.gatewayForwardLatencyMs),
    entry.tags.join(' '),
    entry.errorCode ?? '',
    entry.rawHex,
  ];
  return fields.map(escapeField).join(',');
}

/** 导出为 CSV Buffer（含 BOM，CRLF 换行） */
export function exportCsv(entries: readonly TraceEntry[]): Buffer {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.map(escapeField).join(','));
  for (const entry of entries) lines.push(csvRow(entry));
  const body = Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
  return Buffer.concat([Buffer.from(UTF8_BOM), body]);
}
