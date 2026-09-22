/**
 * DoIP 通用头（8 字节，大端）编解码（§3.1）。
 *
 * ★§8.7：分帧/编解码模块禁用 `as` 断言，所有长度与取值必须显式校验。
 */

import { DOIP_HEADER_LENGTH, inverseVersionOf, isInverseVersionValid } from '@doip/shared';
import type { DoipHeader } from '@doip/shared';
import { AppError } from '../errors/AppError';

export class DoipHeaderCodec {
  static readonly HEADER_LENGTH: number = DOIP_HEADER_LENGTH;

  static inverseVersionOf(pv: number): number {
    return inverseVersionOf(pv);
  }

  static isInverseVersionValid(pv: number, ipv: number): boolean {
    return isInverseVersionValid(pv, ipv);
  }

  /** 8 字节头（不含 payload） */
  static encodeHeader(protocolVersion: number, payloadType: number, payloadLength: number): Buffer {
    if (!Number.isInteger(payloadType) || payloadType < 0 || payloadType > 0xffff) {
      throw new AppError('E_DOIP_UNSUPPORTED_PAYLOAD_TYPE', `payloadType 非法：${payloadType}`);
    }
    if (!Number.isInteger(payloadLength) || payloadLength < 0 || payloadLength > 0xffffffff) {
      throw new AppError('E_DOIP_PAYLOAD_TOO_LARGE', `payloadLength 非法：${payloadLength}`);
    }
    const buf = Buffer.allocUnsafe(DOIP_HEADER_LENGTH);
    buf.writeUInt8(protocolVersion & 0xff, 0);
    buf.writeUInt8(inverseVersionOf(protocolVersion), 1);
    buf.writeUInt16BE(payloadType & 0xffff, 2);
    buf.writeUInt32BE(payloadLength >>> 0, 4);
    return buf;
  }

  /** 完整帧（头 + payload） */
  static buildFrame(protocolVersion: number, payloadType: number, payload: Uint8Array): Buffer {
    const header = DoipHeaderCodec.encodeHeader(protocolVersion, payloadType, payload.length);
    if (payload.length === 0) return header;
    return Buffer.concat([header, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)]);
  }

  /** 解码；缓冲区不足 8 字节时返回 null（绝不抛异常，供分帧器热路径使用） */
  static tryDecodeHeader(buf: Buffer, offset = 0): DoipHeader | null {
    if (offset < 0 || buf.length - offset < DOIP_HEADER_LENGTH) return null;
    const protocolVersion = buf.readUInt8(offset);
    const inverseProtocolVersion = buf.readUInt8(offset + 1);
    const payloadType = buf.readUInt16BE(offset + 2);
    const payloadLength = buf.readUInt32BE(offset + 4);
    return {
      protocolVersion,
      inverseProtocolVersion,
      payloadType,
      payloadLength,
      inverseVersionValid: isInverseVersionValid(protocolVersion, inverseProtocolVersion),
    };
  }

  /** 解码；缓冲区不足时抛 AppError（调用方已确保长度的场景使用） */
  static decodeHeader(buf: Buffer, offset = 0): DoipHeader {
    const header = DoipHeaderCodec.tryDecodeHeader(buf, offset);
    if (header === null) {
      throw new AppError('E_DOIP_INCOMPLETE_FRAME_TIMEOUT', 'DoIP 头不足 8 字节，无法解码');
    }
    return header;
  }
}
