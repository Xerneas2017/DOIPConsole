/**
 * 地址表示法 —— §8.4：
 *  - TS 内部：number（0x0000–0xFFFF）
 *  - JSON / UI / WS：字符串 '0xXXXX'，4 位大写补零
 *  - DID：'0xXXXX'；NRC / 响应码：'0xNN'
 */

import { HexParseError } from './hex';

/** 逻辑地址 number → '0x0E00' */
export function formatLogicalAddress(addr: number): string {
  return `0x${(addr & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** DID number → '0xF190' */
export function formatDid(did: number): string {
  return `0x${(did & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 单字节码（NRC / 响应码 / SID）→ '0x78' */
export function formatCode(code: number): string {
  return `0x${(code & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * 16 位码（DoIP PayloadType 等）→ '0x8001'。
 *
 * ★QA 终验缺陷 2：此前导出 CSV 用的是 `formatCode()`（掩到低 8 位），
 *   于是 0x8001/0x8002/0x8003 被写成 0x01/0x02/0x03，
 *   与真正的 0x0001/0x0002/0x0003 撞车 —— Excel 里没法按报文类型筛选排序。
 *   `formatCode()` 只应用于**本来就只有 1 字节**的字段（SID / 子功能 / NRC / 激活类型）。
 */
export function formatHex16(code: number): string {
  return `0x${(code & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 判断字符串是否为合法逻辑地址形式（'0x0E00' / 'E00'） */
export function isLogicalAddressString(input: string): boolean {
  return /^(0x)?[0-9a-fA-F]{1,4}$/.test(input.trim());
}

/**
 * 逻辑地址字符串 → number。
 * 支持 '0x0E00' / 'E00' / number 直传；越界或非法抛 HexParseError。
 */
export function parseLogicalAddress(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0xffff) {
      throw new HexParseError(`逻辑地址越界：${input}`, String(input));
    }
    return input;
  }
  const s = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,4}$/.test(s)) {
    throw new HexParseError(`非法逻辑地址："${input}"`, input);
  }
  return Number.parseInt(s, 16);
}

/** DID 字符串 → number */
export function parseDid(input: string | number): number {
  return parseLogicalAddress(input);
}

/** DID → 大端 2 字节 */
export function didToBytes(did: number): [number, number] {
  return [(did >> 8) & 0xff, did & 0xff];
}

/** 大端 2 字节 → 数值（用于从报文中取 DID / 逻辑地址） */
export function bytesToUint16(hi: number, lo: number): number {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

/**
 * 单字节码（SID / 子功能 / NRC / 激活类型）字符串 → number。
 * 支持 '0x10' / '10'。
 */
export function parseCode(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0xff) {
      throw new HexParseError(`单字节码越界：${input}`, String(input));
    }
    return input;
  }
  const s = input.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,2}$/.test(s)) {
    throw new HexParseError(`非法单字节码："${input}"`, input);
  }
  return Number.parseInt(s, 16);
}

/** 地址别名解析：命中返回别名，否则返回 null */
export function resolveAlias(
  addr: number,
  aliases: ReadonlyArray<{ address: string; alias: string }> | undefined,
): string | null {
  if (!aliases) return null;
  const target = formatLogicalAddress(addr);
  for (const entry of aliases) {
    try {
      if (formatLogicalAddress(parseLogicalAddress(entry.address)) === target) {
        return entry.alias;
      }
    } catch {
      continue; // 别名表是用户可编辑数据，个别非法条目不得带崩渲染
    }
  }
  return null;
}

/** 展示用地址：'0x0E00' 或 '0x0E00(Tester)' */
export function describeAddress(
  addr: number,
  aliases?: ReadonlyArray<{ address: string; alias: string }>,
): string {
  const base = formatLogicalAddress(addr);
  const alias = resolveAlias(addr, aliases);
  return alias ? `${base}(${alias})` : base;
}
