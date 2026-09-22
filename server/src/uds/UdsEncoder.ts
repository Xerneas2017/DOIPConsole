/**
 * UDS 编码器（§3.5 / T13）。
 *
 * 职责边界：只做「字节组装 + 原始 hex 校验」，
 * 真正的发送一律走 `UdsService.sendUdsRequest()`（★P0-06 唯一入口）。
 */

import { tryParseHex } from '@doip/shared';
import { AppError } from '../errors/AppError';

export interface EncodedField {
  /** 已填好的 hex（优先） */
  hex?: string;
  /** 或数值（按 length + endian 编码） */
  value?: number;
  length: number;
  endian?: 'big' | 'little';
}

export class UdsEncoder {
  /** 原始 hex 严格校验：非法即抛 AppError（绝不静默补零） */
  static parseRawHex(text: string): Uint8Array {
    const bytes = tryParseHex(text);
    if (bytes === null || bytes.length === 0) {
      throw new AppError('E_TXN_REQUEST_INVALID', `原始 hex 非法："${text}"`, {
        hintZh: 'hex 必须为偶数位十六进制字符，允许空格分隔',
      });
    }
    return bytes;
  }

  /** 宽松校验（UI 实时提示用）：返回 null 表示非法 */
  static tryParseRawHex(text: string): Uint8Array | null {
    return tryParseHex(text);
  }

  /** 组装请求：sid + 各字段 */
  static encode(sid: number, fields: EncodedField[]): Uint8Array {
    const out: number[] = [sid & 0xff];
    for (const field of fields) {
      if (field.hex !== undefined && field.hex.trim().length > 0) {
        const bytes = UdsEncoder.parseRawHex(field.hex);
        for (const b of bytes) out.push(b & 0xff);
        continue;
      }
      if (field.value === undefined) continue;
      const width = Math.max(1, Math.min(4, field.length));
      const value = field.value >>> 0;
      const bytes: number[] = [];
      for (let i = 0; i < width; i += 1) {
        bytes.push((value >>> (8 * (width - 1 - i))) & 0xff);
      }
      if (field.endian === 'little') bytes.reverse();
      out.push(...bytes);
    }
    return Uint8Array.from(out);
  }

  /** 0x27 请求种子 / 发送密钥的字节组装 */
  static securityAccessBytes(subFunction: number, payload?: Uint8Array): Uint8Array {
    const head = [0x27, subFunction & 0xff];
    const body = payload === undefined ? [] : Array.from(payload).map((b) => b & 0xff);
    return Uint8Array.from([...head, ...body]);
  }

  /** 安全等级 → 请求种子 / 发送密钥子功能（奇数请求、偶数发送） */
  static securitySubFunctions(level: number): { requestSeed: number; sendKey: number } {
    const requestSeed = Math.max(1, Math.min(0x7f, (level - 1) * 2 + 1));
    return { requestSeed, sendKey: requestSeed + 1 };
  }

  /** 从正响应 userData 中取出 seed（`67 <sub> <seed...>`） */
  static extractSeed(userData: Uint8Array | null): Uint8Array | null {
    if (userData === null || userData.length < 3) return null;
    if ((userData[0] ?? 0) !== 0x67) return null;
    return userData.subarray(2);
  }
}
