/**
 * hex 字符串处理 —— ★§8.4：只有本文件可以做 hex 字符串解析/格式化，
 * 其他文件禁止手写正则解析（历史 bug 高发区）。
 *
 * 口径：
 *  - 存储 / 传输 / 导出 / rawHex：大写、无空格    `02FD800100000006`
 *  - UI 展示 / Trace 数据列 / 详情卡片：大写、单空格分隔 `02 FD 80 01`
 *  - 用户输入：允许小写、允许无空格、允许 0x 前缀，统一经 normalizeHex()
 */

/** hex 解析失败（用户输入非法）。 */
export class HexParseError extends Error {
  readonly input: string;

  constructor(message: string, input: string) {
    super(message);
    this.name = 'HexParseError';
    this.input = input;
  }
}

const HEX_RE = /^[0-9a-fA-F]+$/;

function byteToHex2(b: number): string {
  return (b & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** 单字节 → 'FD'（不带 0x 前缀） */
export function byteHex(b: number): string {
  return byteToHex2(b);
}

/** 判断字符串是否为纯 hex（忽略已包含的空格，不忽略 0x 前缀） */
export function isHexString(input: string): boolean {
  return HEX_RE.test(input.replace(/\s+/g, ''));
}

/**
 * 归一化用户输入：允许 '1003' / '10 03' / '10:03' / '0x10 0x03'，
 * 输出大写、单空格分隔的展示格式。
 */
export function normalizeHex(input: string): string {
  const cleaned = stripHexNoise(input);
  if (cleaned.length === 0) return '';
  if (!HEX_RE.test(cleaned)) {
    throw new HexParseError(`非法 hex 输入："${input}"`, input);
  }
  const padded = cleaned.length % 2 === 0 ? cleaned : `0${cleaned}`;
  const out: string[] = [];
  for (let i = 0; i < padded.length; i += 2) {
    out.push(padded.slice(i, i + 2).toUpperCase());
  }
  return out.join(' ');
}

/** 去掉 0x 前缀、空格、冒号、连字符等噪声字符 */
function stripHexNoise(input: string): string {
  return input.replace(/0x/gi, '').replace(/[\s:_\-,]/g, '');
}

/** 转紧凑大写格式（导出 / 存储） */
export function compactHex(input: string): string {
  return normalizeHex(input).replace(/ /g, '');
}

/** hex → 字节序列；非法输入抛 HexParseError */
export function parseHex(input: string): Uint8Array {
  const bytes = tryParseHex(input);
  if (bytes === null) {
    throw new HexParseError(`非法 hex 输入："${input}"`, input);
  }
  return bytes;
}

/** hex → 字节序列；非法输入返回 null（不抛异常，供 UI 实时校验） */
export function tryParseHex(input: string): Uint8Array | null {
  let cleaned: string;
  try {
    cleaned = stripHexNoise(input);
  } catch {
    return null;
  }
  if (cleaned.length === 0) return new Uint8Array(0);
  if (cleaned.length % 2 !== 0) return null;
  if (!HEX_RE.test(cleaned)) return null;
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 字节序列 → 展示格式（大写、单空格分隔） */
export function formatHex(bytes: Uint8Array | readonly number[]): string {
  const out: string[] = [];
  for (const b of bytes) out.push(byteToHex2(b));
  return out.join(' ');
}

/** 字节序列 → 紧凑格式（大写、无空格） */
export function formatHexCompact(bytes: Uint8Array | readonly number[]): string {
  let s = '';
  for (const b of bytes) s += byteToHex2(b);
  return s;
}

/** 数字数组 → Uint8Array */
export function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values.map((v) => v & 0xff));
}

/** 拼接多个字节序列 */
export function concatBytes(...parts: Array<Uint8Array | readonly number[]>): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 取前 n 字节的紧凑 hex（用于错误 dump，默认 256 字节） */
export function dumpHex(bytes: Uint8Array, maxBytes = 256): string {
  const view = bytes.length <= maxBytes ? bytes : bytes.subarray(0, maxBytes);
  return formatHexCompact(view);
}

/** ASCII 字符串 → hex（仿真数据集用；非 ASCII 字符按 '?' 兜底，绝不静默丢字节） */
export function asciiToHex(text: string): string {
  let s = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    s += byteToHex2(code <= 0x7f ? code : 0x3f);
  }
  return s;
}

/** hex → ASCII 字符串（不可打印字符按 '.' 兜底） */
export function hexToAscii(hex: string): string {
  const bytes = tryParseHex(hex);
  if (bytes === null) return '';
  let s = '';
  for (const b of bytes) {
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.';
  }
  return s;
}

/** 两个字节序列是否逐字节相等 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
