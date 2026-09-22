/**
 * shared 层工具单测：hex / 时间 / 地址表示法（§8.4 / §8.5）。
 * 这些是"历史 bug 高发区"，必须锁死口径。
 */

import { describe, expect, it } from 'vitest';
import {
  asciiToHex,
  compactHex,
  concatBytes,
  formatHex,
  formatHexCompact,
  hexToAscii,
  isHexString,
  normalizeHex,
  parseHex,
  tryParseHex,
} from '@doip/shared';
import {
  describeAddress,
  didToBytes,
  formatCode,
  formatDid,
  formatLogicalAddress,
  parseCode,
  parseDid,
  parseLogicalAddress,
  resolveAlias,
} from '@doip/shared';
import { formatDuration, formatIsoMicro, isoMicroNow, nowMonoMs } from '@doip/shared';
import { ERROR_CODES, getErrorDef, makeWsError, mapSocketErrorCode } from '@doip/shared';
import { FALLBACK_NRC_TABLE, describeCode } from '@doip/shared';

describe('hex 工具（§8.4 口径）', () => {
  it('用户输入归一化：小写/无空格/0x 前缀 → 大写单空格', () => {
    expect(normalizeHex('1003')).toBe('10 03');
    expect(normalizeHex('10 03')).toBe('10 03');
    expect(normalizeHex('0x10 0x03')).toBe('10 03');
    expect(normalizeHex('10:03')).toBe('10 03');
    expect(normalizeHex('deadBEEF')).toBe('DE AD BE EF');
  });

  it('奇数长度自动左补零', () => {
    expect(normalizeHex('10030')).toBe('01 00 30');
  });

  it('非法输入抛错 / tryParse 返回 null', () => {
    expect(() => normalizeHex('zz')).toThrow();
    expect(tryParseHex('zz')).toBeNull();
    expect(tryParseHex('abc')).toBeNull();
    expect(Array.from(tryParseHex('') ?? [])).toEqual([]);
  });

  it('parseHex → 字节；formatHex → 展示格式；formatHexCompact → 紧凑格式', () => {
    const bytes = parseHex('02FD8001');
    expect(Array.from(bytes)).toEqual([0x02, 0xfd, 0x80, 0x01]);
    expect(formatHex(bytes)).toBe('02 FD 80 01');
    expect(formatHexCompact(bytes)).toBe('02FD8001');
    expect(compactHex('02 fd 80 01')).toBe('02FD8001');
  });

  it('isHexString / concatBytes / ascii 互转', () => {
    expect(isHexString('DEADBEEF')).toBe(true);
    expect(isHexString('DEADBEEG')).toBe(false);
    expect(Array.from(concatBytes(parseHex('1003'), [0x22]))).toEqual([0x10, 0x03, 0x22]);
    expect(asciiToHex('VIN123')).toBe('56494E313233');
    expect(hexToAscii('56494E313233')).toBe('VIN123');
  });
});

describe('地址表示法（§8.4）', () => {
  it('逻辑地址 number ↔ 4 位大写补零字符串', () => {
    expect(formatLogicalAddress(0x0e00)).toBe('0x0E00');
    expect(formatLogicalAddress(0x1000)).toBe('0x1000');
    expect(parseLogicalAddress('0x0E00')).toBe(0x0e00);
    expect(parseLogicalAddress('E00')).toBe(0x0e00);
    expect(parseLogicalAddress(0x1000)).toBe(0x1000);
  });

  it('DID / 单字节码', () => {
    expect(formatDid(0xf190)).toBe('0xF190');
    expect(parseDid('0xF190')).toBe(0xf190);
    expect(didToBytes(0xf190)).toEqual([0xf1, 0x90]);
    expect(formatCode(0x78)).toBe('0x78');
    expect(parseCode('0x78')).toBe(0x78);
    expect(parseCode('78')).toBe(0x78);
  });

  it('别名解析', () => {
    const aliases = [{ address: '0x1000', alias: 'GW' }];
    expect(resolveAlias(0x1000, aliases)).toBe('GW');
    expect(resolveAlias(0x1010, aliases)).toBeNull();
    expect(describeAddress(0x1000, aliases)).toBe('0x1000(GW)');
    expect(describeAddress(0x1010, aliases)).toBe('0x1010');
  });
});

describe('时间工具（§8.5）', () => {
  it('isoMicroNow 为 6 位小数 UTC', () => {
    const s = isoMicroNow();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  });

  it('formatIsoMicro 补 μs', () => {
    expect(formatIsoMicro(Date.parse('2026-09-21T10:00:00.123Z'), 456)).toBe('2026-09-21T10:00:00.123456Z');
  });

  it('nowMonoMs 单调递增', () => {
    const a = nowMonoMs();
    const b = nowMonoMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it('formatDuration', () => {
    expect(formatDuration(200)).toBe('200 ms');
    expect(formatDuration(1500)).toBe('1.500 s');
  });
});

describe('错误码注册表（§8.2）', () => {
  it('条目数 ≥ 30 且字段完整', () => {
    const codes = Object.keys(ERROR_CODES);
    expect(codes.length).toBeGreaterThanOrEqual(30);
    for (const code of codes) {
      const def = ERROR_CODES[code];
      expect(def).toBeDefined();
      if (def === undefined) continue;
      expect(def.code).toBe(code);
      expect(def.messageZh.length).toBeGreaterThan(0);
      expect(['info', 'warn', 'error']).toContain(def.severity);
    }
  });

  it('未登记的码回落到 E_IMPL_UNEXPECTED', () => {
    const def = getErrorDef('E_NOT_EXIST');
    expect(def.code).toBe('E_IMPL_UNEXPECTED');
  });

  it('makeWsError 生成前端可消费结构', () => {
    const e = makeWsError('E_TXN_NACK', { linkedSeq: 42 });
    expect(e.code).toBe('E_TXN_NACK');
    expect(e.messageZh.length).toBeGreaterThan(0);
    expect(e.linkedSeq).toBe(42);
    expect(e.retryable).toBe(true);
  });

  it('socket 错误码必须映射为中文错误码（禁止裸 ECONNREFUSED）', () => {
    expect(mapSocketErrorCode('ECONNREFUSED')).toBe('E_CONN_REFUSED');
    expect(mapSocketErrorCode('ETIMEDOUT')).toBe('E_CONN_TIMEOUT');
    expect(mapSocketErrorCode('ECONNRESET')).toBe('E_CONN_RESET');
    expect(mapSocketErrorCode('EHOSTUNREACH')).toBe('E_CONN_HOST_UNREACH');
    expect(mapSocketErrorCode('EPIPE')).toBe('E_CONN_EPIPE');
  });
});

describe('NRC 码表 fallback', () => {
  it('NRC 0x78 是 pending（info 级，不是错误）', () => {
    const d = describeCode(FALLBACK_NRC_TABLE, 0x78);
    expect(d.known).toBe(true);
    expect(d.severity).toBe('info');
    expect(d.name).toContain('Pending');
    expect(d.nameZh).toContain('待续');
  });

  it('未知码显示 Unknown 而非抛异常', () => {
    const d = describeCode(FALLBACK_NRC_TABLE, 0xab);
    expect(d.known).toBe(false);
    expect(d.name).toBe('Unknown(0xAB)');
  });
});
