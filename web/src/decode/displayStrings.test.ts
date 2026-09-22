import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '@doip/shared';
import { emptyUdsDecodeResult } from '@doip/shared';
import { decodeSummary, formatTs, hex2, hex4, addressPair } from './displayStrings';
import { rowKindOf, pairBorderColor, rowBackground } from './colorRules';

function base(overrides: Partial<TraceEntry> = {}): TraceEntry {
  const entry: TraceEntry = {
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
    uds: { ...emptyUdsDecodeResult() },
    linkedSeq: null,
    txnRole: 'request',
    latencyMs: null,
    gatewayForwardLatencyMs: null,
    timeout: false,
    errorCode: null,
    errorNameZh: null,
    tags: [],
    rawHex: '02FD8001000000020E0010001003',
    ...overrides,
  };
  return entry;
}

describe('显示串（T10，Q13）', () => {
  it('hex 格式化', () => {
    expect(hex2(0x10)).toBe('10');
    expect(hex2(null)).toBe('--');
    expect(hex4(0x8001)).toBe('0x8001');
  });

  it('请求：DSC(10) extended(03)', () => {
    const e = base({
      uds: {
        ...emptyUdsDecodeResult(),
        serviceId: 0x10,
        shortEn: 'DSC',
        subFunction: 0x03,
        subFunctionName: 'extendedDiagnosticSession',
      },
    });
    expect(decodeSummary(e)).toBe('DSC extendedDiagnosticSession(03)');
  });

  it('正响应带 ✓，NRC 带 ✗ 与名称', () => {
    const pos = base({
      direction: 'RX',
      uds: { ...emptyUdsDecodeResult(), serviceId: 0x50, shortEn: 'DSC-PR', isPositive: true },
    });
    expect(decodeSummary(pos).startsWith('✓')).toBe(true);

    const nrc = base({
      direction: 'RX',
      uds: { ...emptyUdsDecodeResult(), serviceId: 0x22, nrc: 0x35, nrcName: 'invalidKey' },
    });
    expect(decodeSummary(nrc)).toBe('✗ NRC 35 invalidKey');
  });

  it('ACK / NACK 走 DoIP 层，且文案区分"网关未转发"', () => {
    const ack = base({
      direction: 'RX',
      doip: { ...base().doip, payloadType: 0x8002, ackCode: 0x00, ackNameZh: '确认' },
    });
    expect(decodeSummary(ack).startsWith('✓ ACK')).toBe(true);

    const nack = base({
      direction: 'RX',
      doip: { ...base().doip, payloadType: 0x8003, nackCode: 0x03, nackNameZh: '目标地址未知' },
    });
    expect(decodeSummary(nack)).toBe('✗ NACK 03 目标地址未知');
  });

  it('时间戳 μs 精度与 UTC 切换', () => {
    const iso = '2026-09-22T10:00:00.123456Z';
    expect(formatTs(iso, true)).toBe('10:00:00.123456');
    expect(formatTs(iso, false)).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  it('SA→TA 带别名', () => {
    expect(addressPair(base())).toBe('0E00→1000');
    expect(
      addressPair(base({ doip: { ...base().doip, sourceAddressName: 'Tester' } })),
    ).toBe('Tester→1000');
  });
});

describe('行着色与配对（T10）', () => {
  it('优先级：周期3E > 超时 > NACK > NRC > ACK > 正响应 > 请求', () => {
    expect(rowKindOf(base({ tags: ['周期3E'], timeout: true }))).toBe('periodic');
    expect(rowKindOf(base({ timeout: true }))).toBe('timeout');
    expect(rowKindOf(base({ doip: { ...base().doip, nackCode: 0x03 } }))).toBe('nack');
    expect(rowKindOf(base({ uds: { ...base().uds, nrc: 0x22 } }))).toBe('nrc');
    expect(rowKindOf(base({ doip: { ...base().doip, ackCode: 0x00 } }))).toBe('ack');
    expect(rowKindOf(base({ uds: { ...base().uds, isPositive: true } }))).toBe('positive');
    expect(rowKindOf(base())).toBe('request');
  });

  it('同一 transactionId 取同一左边框色；无事务不画左边框', () => {
    const a = pairBorderColor('tx-0001');
    const b = pairBorderColor('tx-0001');
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(pairBorderColor(null)).toBeNull();
    expect(pairBorderColor('')).toBeNull();
  });

  it('★健壮性：transactionId 键缺失（undefined）不得抛错，否则整块 C 区会被打挂', () => {
    expect(() => pairBorderColor(undefined)).not.toThrow();
    expect(pairBorderColor(undefined)).toBeNull();
  });

  it('配色 token 与图例同源（背景色非空）', () => {
    expect(rowBackground('nrc')).not.toBe('transparent');
    expect(rowBackground('neutral')).toBe('transparent');
  });
});
