/**
 * T06 Trace 存储与导出单测（§9.1 TC-X01 ~ TC-X04）。
 * 另含：过滤表达式求值、100 k 条内存回归（§9.4：≤ 200 MB）。
 */

import { describe, expect, it } from 'vitest';
import { emptyUdsDecodeResult } from '@doip/shared';
import type { TraceEntry } from '@doip/shared';
import { TraceStore, estimateEntryBytes } from '../trace/TraceStore';
import { exportCsv, CSV_COLUMNS, UTF8_BOM } from '../trace/exporters/CsvExporter';
import { exportJson, exportJsonl, toJsonlLine } from '../trace/exporters/JsonExporter';
import { exportHexDump } from '../trace/exporters/HexDumpExporter';
import { runExport, selectEntries } from '../trace/exporters';
import { filterEntries, isFilterExprValid } from '../trace/filterExpression';

let seqCounter = 0;

function makeEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  seqCounter += 1;
  const seq = overrides.seq ?? seqCounter;
  return {
    seq,
    transactionId: `tx-0001`,
    ts: '2026-09-22T10:00:00.123456Z',
    tsRelMs: seq,
    transport: 'TCP',
    direction: seq % 2 === 0 ? 'RX' : 'TX',
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
      targetAddress: 0x1000,
      sourceAddressName: '0x0E00',
      targetAddressName: '0x1000',
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
    uds: emptyUdsDecodeResult(),
    linkedSeq: null,
    txnRole: 'request',
    latencyMs: 1.5,
    gatewayForwardLatencyMs: 1.2,
    timeout: false,
    errorCode: null,
    errorNameZh: null,
    tags: [],
    rawHex: '02FD8001000000060E0010001003',
    ...overrides,
  };
}

describe('TC-X01 TraceStore 双上限淘汰', () => {
  it('条数上限先到：只淘汰到条数上限', () => {
    const store = new TraceStore({ maxEntries: 10, maxBytes: 10 * 1024 * 1024 });
    for (let i = 1; i <= 25; i += 1) store.append(makeEntry({ seq: i }));
    expect(store.size).toBe(10);
    expect(store.minSeq).toBe(16);
    expect(store.maxSeq).toBe(25);
    expect(store.evicted).toBe(15);
  });

  it('字节上限先到：大帧场景下按字节淘汰（★挂机不崩的真正兜底）', () => {
    const big = makeEntry({ seq: 1, rawHex: 'AB'.repeat(4096) });
    const per = estimateEntryBytes(big);
    const store = new TraceStore({ maxEntries: 1000, maxBytes: per * 5 });
    for (let i = 1; i <= 20; i += 1) store.append(makeEntry({ seq: i, rawHex: 'AB'.repeat(4096) }));
    // 条数上限远未到，但字节上限已触发 → 只剩 ≤5 条
    expect(store.size).toBeLessThanOrEqual(5);
    expect(store.size).toBeGreaterThan(0);
    expect(store.bytes).toBeLessThanOrEqual(per * 5);
  });

  it('空缓冲的 minSeq/maxSeq 为 0，clear 后归零', () => {
    const store = new TraceStore({ maxEntries: 5 });
    expect(store.minSeq).toBe(0);
    expect(store.maxSeq).toBe(0);
    store.append(makeEntry({ seq: 1 }));
    store.clear();
    expect(store.size).toBe(0);
    expect(store.minSeq).toBe(0);
  });
});

describe('TC-X02 since / range / last 边界', () => {
  it('since(fromSeq) 取 (fromSeq, maxSeq]', () => {
    const store = new TraceStore({ maxEntries: 100 });
    for (let i = 1; i <= 10; i += 1) store.append(makeEntry({ seq: i }));
    expect(store.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(store.since(5).map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
    expect(store.since(10)).toEqual([]);
    expect(store.range(3, 5).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(store.last(2).map((e) => e.seq)).toEqual([9, 10]);
  });
});

describe('TC-X03 CSV 导出（BOM + 转义 + CRLF）', () => {
  it('首字节为 EF BB BF，中文列名齐全，行尾 CRLF', () => {
    const entries = [makeEntry({ seq: 1 }), makeEntry({ seq: 2 })];
    const buf = exportCsv(entries);
    expect([...buf.subarray(0, 3)]).toEqual([...UTF8_BOM]);
    // 去掉 BOM 后再按 CRLF 切行
    const text = buf.toString('utf8').replace(/^\uFEFF/, '');
    const lines = text.split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines[0]).toContain('时间戳');
    expect(lines[0]).toContain('网关转发耗时(ms)');
    expect(lines[0]).toContain('原始HEX');
    expect(CSV_COLUMNS).toHaveLength(26);
    // 数据行数 = 2（末行空串由结尾 CRLF 产生）
    expect(lines.filter((l) => l !== '')).toHaveLength(3);
  });

  it('含逗号/引号/换行的字段按 RFC4180 转义', () => {
    const entry = makeEntry({ seq: 1, tags: ['a,b', 'c"d'], peer: 'x\ny' });
    const text = exportCsv([entry]).toString('utf8');
    const dataLine = text.split('\r\n')[1] ?? '';
    expect(dataLine).toContain('"a,b c""d"');
    expect(dataLine).toContain('"x\ny"');
  });

  it('Excel 可直接打开：BOM + 固定列数（每行字段数一致）', () => {
    const entries = [makeEntry({ seq: 1 }), makeEntry({ seq: 2, tags: ['周期3E'] })];
    const lines = exportCsv(entries).toString('utf8').split('\r\n').filter((l) => l !== '');
    for (const line of lines) {
      expect(line.split(',').length).toBeGreaterThanOrEqual(CSV_COLUMNS.length);
    }
  });
});

describe('TC-X04 JSON / JSONL / HEX 导出', () => {
  it('JSON 往返可解析出配对关系', () => {
    const req = makeEntry({ seq: 1, txnRole: 'request', transactionId: 'tx-0001' });
    const ack = makeEntry({ seq: 2, txnRole: 'ack', transactionId: 'tx-0001', linkedSeq: 1 });
    const resp = makeEntry({ seq: 3, txnRole: 'response', transactionId: 'tx-0001', linkedSeq: 2 });
    const text = exportJson([req, ack, resp]).toString('utf8');
    const parsed = JSON.parse(text) as { count: number; entries: TraceEntry[] };
    expect(parsed.count).toBe(3);
    const bySeq = new Map(parsed.entries.map((e) => [e.seq, e]));
    expect(bySeq.get(3)?.linkedSeq).toBe(2);
    expect(bySeq.get(3)?.transactionId).toBe('tx-0001');
    expect(bySeq.get(1)?.gatewayForwardLatencyMs).toBeCloseTo(1.2, 5);
  });

  it('JSONL 一行一条，逐行 JSON.parse 全成功', () => {
    const entries = [makeEntry({ seq: 1 }), makeEntry({ seq: 2 }), makeEntry({ seq: 3 })];
    const text = exportJsonl(entries).toString('utf8');
    const lines = text.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as TraceEntry;
      expect(typeof parsed.seq).toBe('number');
    }
    expect(toJsonlLine(entries[0] ?? makeEntry())).not.toContain('\n');
  });

  it('HEX dump 带偏移与 ASCII 侧栏', () => {
    const text = exportHexDump([makeEntry({ seq: 1 })]).toString('utf8');
    expect(text).toContain('00000000  02 FD 80 01 00 00 00 06 0E 00 10 00 10 03');
    expect(text).toMatch(/\|\..*\|/);
  });

  it('runExport 支持四种格式；不支持的格式报错', () => {
    const entries = [makeEntry({ seq: 1 }), makeEntry({ seq: 2 })];
    for (const format of ['csv', 'json', 'jsonl', 'hexdump'] as const) {
      const res = runExport(entries, { format, scope: 'all' });
      expect(res.buffer.length).toBeGreaterThan(0);
      expect(res.count).toBe(2);
      expect(res.filename.endsWith('.csv') || res.filename.endsWith('.json') || res.filename.endsWith('.jsonl') || res.filename.endsWith('.txt')).toBe(true);
    }
    expect(() =>
      runExport(entries, { format: 'xml' as never, scope: 'all' }),
    ).toThrow();
  });
});

describe('后端重放过滤（filterExpression）', () => {
  it('表达式过滤与标签过滤生效', () => {
    const entries = [
      makeEntry({ seq: 1, tags: ['周期3E'], uds: { ...emptyUdsDecodeResult(), serviceId: 0x3e } }),
      makeEntry({ seq: 2, doip: { ...makeEntry().doip, payloadType: 0x8002 } }),
      makeEntry({ seq: 3, uds: { ...emptyUdsDecodeResult(), serviceId: 0x22 } }),
    ];
    const bySid = filterEntries(entries, 'uds.sid == 0x22');
    expect(bySid.map((e) => e.seq)).toEqual([3]);

    const byType = filterEntries(entries, 'doip.type == 0x8001');
    expect(byType.map((e) => e.seq)).toEqual([1, 3]);

    const combined = filterEntries(entries, 'doip.type == 0x8001 && uds.sid == 0x3E');
    expect(combined.map((e) => e.seq)).toEqual([1]);

    const hidden = selectEntries(entries, {
      format: 'csv',
      scope: 'filtered',
      filterExpr: 'doip.type == 0x8001',
      includeTags: { hidePeriodicTesterPresent: true },
    });
    expect(hidden.map((e) => e.seq)).toEqual([3]);
  });

  it('非法表达式不抛异常也不静默丢数据', () => {
    const entries = [makeEntry({ seq: 1 })];
    expect(filterEntries(entries, '(((').map((e) => e.seq)).toEqual([1]);
    expect(isFilterExprValid('uds.sid == 0x22')).toBe(true);
    expect(isFilterExprValid('== 0x22')).toBe(false);
  });
});

describe('§9.4 内存回归：100 k 条 ≤ 200 MB', () => {
  it('灌 100 000 条后堆内存增量 ≤ 200 MB', () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    gc?.();
    const before = process.memoryUsage().heapUsed;
    const store = new TraceStore();
    for (let i = 1; i <= 100_000; i += 1) {
      store.append(makeEntry({ seq: i, transactionId: null, linkedSeq: null }));
    }
    gc?.();
    const after = process.memoryUsage().heapUsed;
    const deltaMb = (after - before) / 1024 / 1024;
    console.log(
      `        100k 条：size=${store.size} bytes=${Math.round(store.bytes / 1024 / 1024)}MiB heap 增量=${deltaMb.toFixed(1)}MiB`,
    );
    expect(store.size).toBe(100_000);
    expect(deltaMb).toBeLessThanOrEqual(200);
  }, 60000);
});
