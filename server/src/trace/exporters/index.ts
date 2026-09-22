/**
 * 导出入口（§3.11 / T06）：按 format 分发，产出 Buffer。
 *
 * 范围（scope）：
 *  - all：全部；
 *  - filtered：按 `filterExpr` 在**后端重放**过滤（与前端所见一致，不信任前端传来的行集合）；
 *  - selected：按 `seqRange` 闭区间。
 */

import type { ExportFormat, ExportRequest, TraceEntry } from '@doip/shared';
import { AppError } from '../../errors/AppError';
import { exportCsv } from './CsvExporter';
import { exportJson, exportJsonl } from './JsonExporter';
import { exportHexDump } from './HexDumpExporter';
import { filterEntries } from '../filterExpression';

export interface ExportResult {
  buffer: Buffer;
  filename: string;
  mime: string;
  count: number;
}

const MIME: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  hexdump: 'text/plain; charset=utf-8',
};

const EXT: Record<ExportFormat, string> = {
  csv: 'csv',
  json: 'json',
  jsonl: 'jsonl',
  hexdump: 'txt',
};

function timestampSlug(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function exportFilename(format: ExportFormat): string {
  return `doip-trace-${timestampSlug()}.${EXT[format]}`;
}

/** 按请求挑选条目（范围 + 过滤 + 标签） */
export function selectEntries(entries: readonly TraceEntry[], req: ExportRequest): TraceEntry[] {
  let selected: TraceEntry[] = entries.slice();
  if (req.seqRange !== undefined) {
    const [from, to] = req.seqRange;
    selected = selected.filter((e) => e.seq >= from && e.seq <= to);
  }
  if (req.scope === 'filtered') {
    selected = filterEntries(selected, req.filterExpr);
  }
  if (req.includeTags?.hidePeriodicTesterPresent === true) {
    selected = selected.filter((e) => !e.tags.includes('周期3E'));
  }
  return selected;
}

/** 执行导出；不支持的格式抛 E_IO_UNSUPPORTED_FORMAT */
export function runExport(entries: readonly TraceEntry[], req: ExportRequest): ExportResult {
  const selected = selectEntries(entries, req);
  let buffer: Buffer;
  switch (req.format) {
    case 'csv':
      buffer = exportCsv(selected);
      break;
    case 'json':
      buffer = exportJson(selected);
      break;
    case 'jsonl':
      buffer = exportJsonl(selected);
      break;
    case 'hexdump':
      buffer = exportHexDump(selected);
      break;
    default:
      throw new AppError('E_IO_EXPORT_FAILED', undefined, {
        detail: { format: req.format },
      });
  }
  return {
    buffer,
    filename: exportFilename(req.format),
    mime: MIME[req.format],
    count: selected.length,
  };
}

export { exportCsv } from './CsvExporter';
export { exportJson, exportJsonl, toJsonlLine } from './JsonExporter';
export { exportHexDump } from './HexDumpExporter';
export { CSV_COLUMNS, UTF8_BOM } from './CsvExporter';
