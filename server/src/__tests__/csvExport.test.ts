/**
 * ★QA 终验缺陷 2 的回归闸门：CSV 导出的 16 位字段不得被掩成 1 字节。
 *
 * 背景：`formatCode()` 只应用于**本来就只有 1 字节**的字段（SID / 子功能 / NRC / 激活类型）。
 * 旧代码把它用在 PayloadType 与逻辑地址上：
 *   0x8001 → "0x01"、0x0E00 → "0x00"、0x1000 → "0x00"
 * 于是 0x8001/0x8002/0x8003 与 0x0001/0x0002/0x0003 在 CSV 里撞车，
 * Excel 按报文类型/地址的筛选排序直接失效（P0-04 客户点名项）。
 * 界面表格用的是另一套格式化，所以只有导出错 —— 更隐蔽，必须有单测钉住。
 */

import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '@doip/shared';
import { emptyUdsDecodeResult, formatHex16 } from '@doip/shared';
import { CSV_COLUMNS, UTF8_BOM, csvRow, exportCsv } from '../trace/exporters/CsvExporter';
import { exportHexDump } from '../trace/exporters/HexDumpExporter';

function entry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  const base: TraceEntry = {
    seq: 1,
    transactionId: null,
    ts: '2026-09-22T10:00:00.123456Z',
    tsRelMs: 0,
    transport: 'TCP',
    direction: 'TX',
    peer: '127.0.0.1:13401',
    sessionId: 'default',
    doip: {
      protocolVersion: 0x02,
      inverseVersionValid: true,
      payloadType: 0x8001,
      payloadTypeName: 'DiagnosticMessage',
      payloadTypeNameZh: '诊断报文',
      payloadLength: 6,
      sourceAddress: 0x0e00,
      sourceAddressName: 'Tester',
      targetAddress: 0x1000,
      targetAddressName: 'Gateway',
      ackCode: null,
      ackNameZh: null,
      nackCode: null,
      nackNameZh: null,
      activationResponseCode: null,
      activationResponseCodeZh: null,
      vin: null,
      eid: null,
      gid: null,
      headerHex: '02FD800100000006',
    },
    uds: { ...emptyUdsDecodeResult(), serviceId: 0x10, subFunction: 0x03, did: 0xf190, nrc: 0x31 },
    rawHex: '02 FD 80 01 00 00 00 06 0E 00 10 00 10 03',
    linkedSeq: null,
    txnRole: null,
    latencyMs: null,
    gatewayForwardLatencyMs: null,
    timeout: false,
    errorCode: null,
    errorNameZh: null,
    tags: [],
  };
  return { ...base, ...overrides };
}

function fieldOf(row: string, column: string): string {
  const idx = CSV_COLUMNS.indexOf(column);
  return row.split(',')[idx] ?? '';
}

describe('T15 — CSV 导出的 16 位字段完整性', () => {
  it('★PayloadType 0x8001 不得被写成 0x01', () => {
    expect(fieldOf(csvRow(entry()), 'PayloadType')).toBe('0x8001');
  });

  it('★SA 0x0E00 / TA 0x1000 不得被写成 0x00', () => {
    const row = csvRow(entry());
    expect(fieldOf(row, 'SA')).toBe('0x0E00');
    expect(fieldOf(row, 'TA')).toBe('0x1000');
  });

  it('★0x8001 与 0x0001 在 CSV 里必须可区分（否则 Excel 筛选失效）', () => {
    const a = fieldOf(csvRow(entry()), 'PayloadType');
    const b = fieldOf(
      csvRow(entry({ doip: { ...entry().doip, payloadType: 0x0001 } })),
      'PayloadType',
    );
    expect(a).toBe('0x8001');
    expect(b).toBe('0x0001');
    expect(a).not.toBe(b);
  });

  it('1 字节字段仍用 2 位 hex（SID / 子功能 / NRC），DID 用 4 位', () => {
    const row = csvRow(entry());
    expect(fieldOf(row, '子功能')).toBe('0x03');
    expect(fieldOf(row, 'NRC')).toBe('0x31');
    expect(fieldOf(row, 'DID')).toBe('0xF190');
  });

  it('HEX dump 标题行的 PayloadType 同样不得截断', () => {
    const text = exportHexDump([entry()]).toString('utf8');
    expect(text).toContain('0x8001');
    expect(text).not.toContain('0x01 诊断报文');
  });

  it('整体导出仍带 UTF-8 BOM 与 CRLF，且列数一致', () => {
    const buf = exportCsv([entry(), entry({ seq: 2 })]);
    expect(Array.from(buf.subarray(0, 3))).toEqual(UTF8_BOM);
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const lines = text.split('\r\n').filter((l) => l !== '');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.split(',')).toHaveLength(CSV_COLUMNS.length);
    }
  });

  it('formatHex16 是本仓库格式化 16 位码的唯一口径', () => {
    expect(formatHex16(0x8001)).toBe('0x8001');
    expect(formatHex16(0x1fff)).toBe('0x1FFF');
    expect(formatHex16(0x00)).toBe('0x0000');
  });
});
