import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '@doip/shared';
import { emptyUdsDecodeResult } from '@doip/shared';
import { compileFilter, FILTER_PRESETS, isFilterExprValid } from './filterExpression';

function entry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
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
      payloadLength: 2,
      sourceAddress: 0x0e00,
      targetAddress: 0x1000,
      sourceAddressName: null,
      targetAddressName: null,
      ackCode: null,
      ackNameZh: null,
      nackCode: null,
      nackNameZh: null,
      activationResponseCode: null,
      activationResponseCodeZh: null,
      vin: null,
      eid: null,
      gid: null,
      headerHex: '02FD800100000002',
    },
    uds: { ...emptyUdsDecodeResult(), serviceId: 0x22, did: 0xf190 },
    linkedSeq: null,
    txnRole: 'request',
    latencyMs: null,
    gatewayForwardLatencyMs: null,
    timeout: false,
    errorCode: null,
    errorNameZh: null,
    tags: [],
    rawHex: '02FD8001000000020E00100022F190',
    ...overrides,
  };
}

describe('过滤表达式（T10）', () => {
  it('空表达式 = 不过滤', () => {
    expect(compileFilter('')).toBeNull();
    expect(compileFilter('   ')).toBeNull();
  });

  it('doip.type == 0x8001 && uds.sid == 0x22 命中', () => {
    const fn = compileFilter('doip.type == 0x8001 && uds.sid == 0x22');
    expect(fn).not.toBeNull();
    expect(typeof fn === 'function' && fn(entry())).toBe(true);
    expect(typeof fn === 'function' && fn(entry({ doip: { ...entry().doip, payloadType: 0x8002 } }))).toBe(false);
  });

  it('null 字面量：uds.nrc != null 表示"有 NRC"', () => {
    const fn = compileFilter('uds.nrc != null') as (e: TraceEntry) => boolean;
    expect(fn(entry())).toBe(false);
    expect(fn(entry({ uds: { ...entry().uds, nrc: 0x22 } }))).toBe(true);
  });

  it('中文裸值 + contains：!tag contains 周期3E', () => {
    const fn = compileFilter('!tag contains 周期3E') as (e: TraceEntry) => boolean;
    expect(fn(entry())).toBe(true);
    expect(fn(entry({ tags: ['周期3E'] }))).toBe(false);
  });

  it('括号与 || 组合', () => {
    const fn = compileFilter('(dir == TX || dir == RX) && seq >= 5') as (e: TraceEntry) => boolean;
    expect(fn(entry({ seq: 5 }))).toBe(true);
    expect(fn(entry({ seq: 4 }))).toBe(false);
  });

  it('★非法表达式返回 invalid（不静默丢行）', () => {
    expect(compileFilter('uds.sid ===')).toBe('invalid');
    expect(compileFilter('doip.type ==')).toBe('invalid');
    expect(compileFilter('unknownField == 1')).toBe('invalid');
    expect(isFilterExprValid('doip.type == 0x8001')).toBe(true);
    expect(isFilterExprValid('doip.type ==')).toBe(false);
  });

  it('全部预设 chips 均可解析（否则 UI 一点就变成"静默丢行"）', () => {
    for (const preset of FILTER_PRESETS) {
      expect(isFilterExprValid(preset.expr), `${preset.label}: ${preset.expr}`).toBe(true);
    }
  });
});
