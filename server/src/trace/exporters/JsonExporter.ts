/**
 * JSON / JSONL 导出器（§3.11）。
 *
 * - `json`：完整数组，可被再次解析出配对关系（transactionId / linkedSeq / latencyMs）；
 * - `jsonl`：一行一条（★变更 1 新增，与落盘分片完全同格式），
 *   长历史导出用 JSONL 可流式处理，避免一次性占用双倍内存。
 */

import type { TraceEntry } from '@doip/shared';

export function toJsonlLine(entry: TraceEntry): string {
  return JSON.stringify(entry);
}

export function exportJsonl(entries: readonly TraceEntry[]): Buffer {
  if (entries.length === 0) return Buffer.alloc(0);
  const parts: string[] = [];
  for (const entry of entries) parts.push(toJsonlLine(entry));
  return Buffer.from(parts.join('\n') + '\n', 'utf8');
}

export interface JsonExportEnvelope {
  format: 'doip-trace-json';
  version: 1;
  exportedAt: string;
  count: number;
  entries: readonly TraceEntry[];
}

/** 导出为 JSON Buffer（带信封，含导出时刻与条数，便于归档） */
export function exportJson(entries: readonly TraceEntry[]): Buffer {
  const envelope: JsonExportEnvelope = {
    format: 'doip-trace-json',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: entries.length,
    entries,
  };
  return Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
}
