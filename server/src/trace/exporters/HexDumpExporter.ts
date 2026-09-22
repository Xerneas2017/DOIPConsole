/**
 * HEX dump 导出器（§3.11）：带偏移与 ASCII 侧栏，便于与 Wireshark / 原始抓包逐字节对照。
 * 每条 TraceEntry 输出一行标题 + 若干 16 字节一行的数据行。
 */

import type { TraceEntry } from '@doip/shared';
import { formatHex16, parseHex } from '@doip/shared';

const BYTES_PER_LINE = 16;

function toPrintable(byte: number): string {
  return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
}

function hexLines(bytes: Uint8Array, baseOffset: number): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += BYTES_PER_LINE) {
    const slice = bytes.subarray(offset, Math.min(offset + BYTES_PER_LINE, bytes.length));
    const hexPart: string[] = [];
    for (let i = 0; i < BYTES_PER_LINE; i += 1) {
      const b = slice[i];
      hexPart.push(b === undefined ? '  ' : b.toString(16).toUpperCase().padStart(2, '0'));
    }
    const asciiPart = Array.from(slice, toPrintable).join('');
    lines.push(
      `${(baseOffset + offset).toString(16).toUpperCase().padStart(8, '0')}  ${hexPart.join(' ')}  |${asciiPart}|`,
    );
  }
  if (bytes.length === 0) {
    lines.push(`${baseOffset.toString(16).toUpperCase().padStart(8, '0')}  (空)`);
  }
  return lines;
}

export function exportHexDump(entries: readonly TraceEntry[]): Buffer {
  const out: string[] = [];
  out.push('# DoIP Trace HEX Dump');
  out.push(`# ${new Date().toISOString()}  entries=${entries.length}`);
  out.push('');
  for (const entry of entries) {
    out.push(
      `# ${entry.seq} ${entry.ts} ${entry.direction} ${entry.transport} ${formatHex16(entry.doip.payloadType)} ${entry.doip.payloadTypeNameZh} ${entry.peer}`,
    );
    out.push(...hexLines(parseHex(entry.rawHex), 0));
    out.push('');
  }
  return Buffer.from(out.join('\n'), 'utf8');
}
