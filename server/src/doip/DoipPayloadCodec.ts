/**
 * DoIP payload 编解码（§3.4）—— 表驱动。
 *
 * 约定：
 *  - 未知 payloadType → 产出 `{kind:'unknown', hex}` 并标记 Unknown(0xXXXX)，**绝不抛异常**
 *  - 已知 type 但长度不足（对端违规）→ 同样退化为 unknown 而非抛异常
 *  - 所有字节序列输出均为**拷贝**，不引用调用方或分帧器的缓冲区
 */

import {
  PayloadType,
  formatHexCompact,
  payloadTypeMeta,
} from '@doip/shared';
import type {
  AliveCheckResponsePayload,
  DiagnosticMessageAckPayload,
  DiagnosticMessageNackPayload,
  DiagnosticMessagePayload,
  DoipPayload,
  EntityStatusResponsePayload,
  GenericHeaderNackPayload,
  PowerModeResponsePayload,
  RoutingActivationRequestPayload,
  RoutingActivationResponsePayload,
  VehicleAnnouncementPayload,
  VehicleIdentificationRequestEidPayload,
  VehicleIdentificationRequestPayload,
  VehicleIdentificationRequestVinPayload,
} from '@doip/shared';
import { AppError } from '../errors/AppError';

const VIN_LENGTH = 17;
const EID_LENGTH = 6;
const GID_LENGTH = 6;
/**
 * ★路由激活请求（0x0005）的长度：**7 或 11 都合法**。
 *
 * ISO 13400-2 的 payload 为 SA(2) + activationType(1) + reservedIso(4) [+ reservedOem(4)]，
 * 其中 **OEM 保留字段是可选的**——多数标准实现（如 python-doipclient 不传 vm_specific 时）
 * 只发 7 字节。
 *
 * 曾因把它写成 `length < 11` 硬校验，导致第三方标准客户端发 7 字节时被静默丢弃、
 * 路由激活永远超时（互操作性事故）。这里必须容忍两种长度。
 */
const ROUTING_REQ_MIN_LENGTH = 7; // SA(2) + activationType(1) + reservedIso(4)
const ROUTING_REQ_LENGTH = 11; // 上述 + reservedOem(4)
const ROUTING_RES_LENGTH = 13;
const ANNOUNCEMENT_LENGTH = 33;
const ENTITY_STATUS_RES_LENGTH = 7;

/** Uint8Array → Buffer 视图（零拷贝；shared 层不能依赖 node:buffer，故在此转换） */
function view(bytes: Uint8Array): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 拷贝一段字节（不用 subarray，避免持有调用方缓冲区） */
function sliceCopy(buf: Buffer, start: number, end: number): Uint8Array {
  return Uint8Array.from(buf.subarray(start, Math.min(end, buf.length)));
}

/** 定长 ASCII 字段编码（不足补 0x00，超出截断，绝不静默丢字节到错误位置） */
function asciiBytes(text: string, length: number): Buffer {
  const out = Buffer.alloc(length, 0x00);
  const src = Buffer.from(text, 'ascii');
  src.copy(out, 0, 0, Math.min(src.length, length));
  return out;
}

/* ─────────────── decode ─────────────── */

function decodeGenericHeaderNack(payload: Buffer): GenericHeaderNackPayload | null {
  if (payload.length < 1) return null;
  return { nackCode: payload.readUInt8(0) };
}

/** 无参数 payload（0x0001 / 0x0007 / 0x4001 / 0x4003）：任何长度都合法 */
function decodeEmpty(_payload: Buffer): VehicleIdentificationRequestPayload {
  return {};
}

function decodeVehicleIdentificationRequestEid(
  payload: Buffer,
): VehicleIdentificationRequestEidPayload | null {
  if (payload.length < EID_LENGTH) return null;
  return { eid: sliceCopy(payload, 0, EID_LENGTH) };
}

function decodeVehicleIdentificationRequestVin(
  payload: Buffer,
): VehicleIdentificationRequestVinPayload | null {
  if (payload.length < VIN_LENGTH) return null;
  return { vin: payload.subarray(0, VIN_LENGTH).toString('ascii') };
}

function decodeVehicleAnnouncement(payload: Buffer): VehicleAnnouncementPayload | null {
  if (payload.length < ANNOUNCEMENT_LENGTH) return null;
  return {
    vin: payload.subarray(0, VIN_LENGTH).toString('ascii'),
    logicalAddress: payload.readUInt16BE(VIN_LENGTH),
    eid: sliceCopy(payload, VIN_LENGTH + 2, VIN_LENGTH + 2 + EID_LENGTH),
    gid: sliceCopy(payload, VIN_LENGTH + 2 + EID_LENGTH, VIN_LENGTH + 2 + EID_LENGTH + GID_LENGTH),
    furtherActionRequired: payload.readUInt8(ANNOUNCEMENT_LENGTH - 2),
    vinGidSyncStatus: payload.readUInt8(ANNOUNCEMENT_LENGTH - 1),
  };
}

function decodeRoutingActivationRequest(payload: Buffer): RoutingActivationRequestPayload | null {
  // ★7 或 11 字节均可（OEM 保留字段可选，见上方常量注释）
  if (payload.length < ROUTING_REQ_MIN_LENGTH) return null;
  return {
    sourceAddress: payload.readUInt16BE(0),
    activationType: payload.readUInt8(2),
    reservedIso: payload.readUInt32BE(3),
    // 未携带 OEM 字段时给空数组，而不是 null —— 调用方不必做二次判空
    reservedOem: payload.length >= ROUTING_REQ_LENGTH ? sliceCopy(payload, 7, ROUTING_REQ_LENGTH) : new Uint8Array(0),
  };
}

function decodeRoutingActivationResponse(payload: Buffer): RoutingActivationResponsePayload | null {
  if (payload.length < ROUTING_RES_LENGTH) return null;
  return {
    testerLogicalAddress: payload.readUInt16BE(0),
    doipEntityLogicalAddress: payload.readUInt16BE(2),
    routingActivationResponseCode: payload.readUInt8(4),
    reservedIso: payload.readUInt32BE(5),
    reservedOem: sliceCopy(payload, 9, ROUTING_RES_LENGTH),
  };
}

function decodeAliveCheckResponse(payload: Buffer): AliveCheckResponsePayload | null {
  if (payload.length < 2) return null;
  return { sourceAddress: payload.readUInt16BE(0) };
}

function decodeEntityStatusResponse(payload: Buffer): EntityStatusResponsePayload | null {
  if (payload.length < ENTITY_STATUS_RES_LENGTH) return null;
  return {
    nodeType: payload.readUInt8(0),
    maxConcurrentSockets: payload.readUInt8(1),
    currentlyOpenSockets: payload.readUInt8(2),
    maxDataSize: payload.readUInt32BE(3),
  };
}

function decodePowerModeResponse(payload: Buffer): PowerModeResponsePayload | null {
  if (payload.length < 1) return null;
  return { powerMode: payload.readUInt8(0) };
}

function decodeDiagnosticMessage(payload: Buffer): DiagnosticMessagePayload | null {
  if (payload.length < 4) return null;
  return {
    sourceAddress: payload.readUInt16BE(0),
    targetAddress: payload.readUInt16BE(2),
    userData: sliceCopy(payload, 4, payload.length),
  };
}

function decodeDiagnosticMessageAck(payload: Buffer): DiagnosticMessageAckPayload | null {
  if (payload.length < 5) return null;
  return {
    sourceAddress: payload.readUInt16BE(0),
    targetAddress: payload.readUInt16BE(2),
    ackCode: payload.readUInt8(4),
    previousMessage: sliceCopy(payload, 5, payload.length),
  };
}

function decodeDiagnosticMessageNack(payload: Buffer): DiagnosticMessageNackPayload | null {
  if (payload.length < 5) return null;
  return {
    sourceAddress: payload.readUInt16BE(0),
    targetAddress: payload.readUInt16BE(2),
    nackCode: payload.readUInt8(4),
    previousMessage: sliceCopy(payload, 5, payload.length),
  };
}

/* ─────────────── encode ─────────────── */

export function encodeGenericHeaderNack(value: GenericHeaderNackPayload): Buffer {
  return Buffer.from([value.nackCode & 0xff]);
}

export function encodeVehicleIdentificationRequest(_value: VehicleIdentificationRequestPayload): Buffer {
  return Buffer.alloc(0);
}

export function encodeVehicleIdentificationRequestEid(
  value: VehicleIdentificationRequestEidPayload,
): Buffer {
  const eid = view(value.eid);
  const out = Buffer.alloc(EID_LENGTH, 0x00);
  eid.copy(out, 0, 0, Math.min(EID_LENGTH, eid.length));
  return out;
}

export function encodeVehicleIdentificationRequestVin(value: VehicleIdentificationRequestVinPayload): Buffer {
  return asciiBytes(value.vin, VIN_LENGTH);
}

export function encodeVehicleAnnouncement(value: VehicleAnnouncementPayload): Buffer {
  const buf = Buffer.alloc(ANNOUNCEMENT_LENGTH, 0x00);
  asciiBytes(value.vin, VIN_LENGTH).copy(buf, 0);
  buf.writeUInt16BE(value.logicalAddress & 0xffff, VIN_LENGTH);
  view(value.eid).copy(buf, VIN_LENGTH + 2, 0, Math.min(EID_LENGTH, value.eid.length));
  view(value.gid).copy(buf, VIN_LENGTH + 2 + EID_LENGTH, 0, Math.min(GID_LENGTH, value.gid.length));
  buf.writeUInt8(value.furtherActionRequired & 0xff, ANNOUNCEMENT_LENGTH - 2);
  buf.writeUInt8(value.vinGidSyncStatus & 0xff, ANNOUNCEMENT_LENGTH - 1);
  return buf;
}

export function encodeRoutingActivationRequest(value: RoutingActivationRequestPayload): Buffer {
  const buf = Buffer.alloc(ROUTING_REQ_LENGTH, 0x00);
  buf.writeUInt16BE(value.sourceAddress & 0xffff, 0);
  buf.writeUInt8(value.activationType & 0xff, 2);
  buf.writeUInt32BE(value.reservedIso >>> 0, 3);
  view(value.reservedOem).copy(buf, 7, 0, Math.min(4, value.reservedOem.length));
  return buf;
}

export function encodeRoutingActivationResponse(value: RoutingActivationResponsePayload): Buffer {
  const buf = Buffer.alloc(ROUTING_RES_LENGTH, 0x00);
  buf.writeUInt16BE(value.testerLogicalAddress & 0xffff, 0);
  buf.writeUInt16BE(value.doipEntityLogicalAddress & 0xffff, 2);
  buf.writeUInt8(value.routingActivationResponseCode & 0xff, 4);
  buf.writeUInt32BE(value.reservedIso >>> 0, 5);
  view(value.reservedOem).copy(buf, 9, 0, Math.min(4, value.reservedOem.length));
  return buf;
}

export function encodeAliveCheckRequest(): Buffer {
  return Buffer.alloc(0);
}

export function encodeAliveCheckResponse(value: AliveCheckResponsePayload): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value.sourceAddress & 0xffff, 0);
  return buf;
}

export function encodeEntityStatusRequest(): Buffer {
  return Buffer.alloc(0);
}

export function encodeEntityStatusResponse(value: EntityStatusResponsePayload): Buffer {
  const buf = Buffer.alloc(ENTITY_STATUS_RES_LENGTH, 0x00);
  buf.writeUInt8(value.nodeType & 0xff, 0);
  buf.writeUInt8(value.maxConcurrentSockets & 0xff, 1);
  buf.writeUInt8(value.currentlyOpenSockets & 0xff, 2);
  buf.writeUInt32BE(value.maxDataSize >>> 0, 3);
  return buf;
}

export function encodePowerModeRequest(): Buffer {
  return Buffer.alloc(0);
}

export function encodePowerModeResponse(value: PowerModeResponsePayload): Buffer {
  return Buffer.from([value.powerMode & 0xff]);
}

export function encodeDiagnosticMessage(value: DiagnosticMessagePayload): Buffer {
  const userData = view(value.userData);
  const buf = Buffer.alloc(4 + userData.length);
  buf.writeUInt16BE(value.sourceAddress & 0xffff, 0);
  buf.writeUInt16BE(value.targetAddress & 0xffff, 2);
  userData.copy(buf, 4);
  return buf;
}

export function encodeDiagnosticMessageAck(value: DiagnosticMessageAckPayload): Buffer {
  const prev = view(value.previousMessage);
  const buf = Buffer.alloc(5 + prev.length);
  buf.writeUInt16BE(value.sourceAddress & 0xffff, 0);
  buf.writeUInt16BE(value.targetAddress & 0xffff, 2);
  buf.writeUInt8(value.ackCode & 0xff, 4);
  prev.copy(buf, 5);
  return buf;
}

export function encodeDiagnosticMessageNack(value: DiagnosticMessageNackPayload): Buffer {
  const prev = view(value.previousMessage);
  const buf = Buffer.alloc(5 + prev.length);
  buf.writeUInt16BE(value.sourceAddress & 0xffff, 0);
  buf.writeUInt16BE(value.targetAddress & 0xffff, 2);
  buf.writeUInt8(value.nackCode & 0xff, 4);
  prev.copy(buf, 5);
  return buf;
}

/* ─────────────── 表驱动分发 ─────────────── */

type PayloadDecoder = (payload: Buffer) => DoipPayload | null;

const DECODERS: Record<number, PayloadDecoder> = {
  [PayloadType.GENERIC_HEADER_NACK]: (p) => {
    const v = decodeGenericHeaderNack(p);
    return v === null ? null : { kind: 'genericHeaderNack', payloadType: 0x0000, value: v };
  },
  [PayloadType.VEHICLE_IDENTIFICATION_REQ]: (p) => ({
    kind: 'vehicleIdentificationRequest',
    payloadType: 0x0001,
    value: decodeEmpty(p),
  }),
  [PayloadType.VEHICLE_IDENTIFICATION_REQ_EID]: (p) => {
    const v = decodeVehicleIdentificationRequestEid(p);
    return v === null ? null : { kind: 'vehicleIdentificationRequestEid', payloadType: 0x0002, value: v };
  },
  [PayloadType.VEHICLE_IDENTIFICATION_REQ_VIN]: (p) => {
    const v = decodeVehicleIdentificationRequestVin(p);
    return v === null ? null : { kind: 'vehicleIdentificationRequestVin', payloadType: 0x0003, value: v };
  },
  [PayloadType.VEHICLE_ANNOUNCEMENT]: (p) => {
    const v = decodeVehicleAnnouncement(p);
    return v === null ? null : { kind: 'vehicleAnnouncement', payloadType: 0x0004, value: v };
  },
  [PayloadType.ROUTING_ACTIVATION_REQ]: (p) => {
    const v = decodeRoutingActivationRequest(p);
    return v === null ? null : { kind: 'routingActivationRequest', payloadType: 0x0005, value: v };
  },
  [PayloadType.ROUTING_ACTIVATION_RES]: (p) => {
    const v = decodeRoutingActivationResponse(p);
    return v === null ? null : { kind: 'routingActivationResponse', payloadType: 0x0006, value: v };
  },
  [PayloadType.ALIVE_CHECK_REQ]: (p) => ({
    kind: 'aliveCheckRequest',
    payloadType: 0x0007,
    value: decodeEmpty(p),
  }),
  [PayloadType.ALIVE_CHECK_RES]: (p) => {
    const v = decodeAliveCheckResponse(p);
    return v === null ? null : { kind: 'aliveCheckResponse', payloadType: 0x0008, value: v };
  },
  [PayloadType.ENTITY_STATUS_REQ]: (p) => ({
    kind: 'entityStatusRequest',
    payloadType: 0x4001,
    value: decodeEmpty(p),
  }),
  [PayloadType.ENTITY_STATUS_RES]: (p) => {
    const v = decodeEntityStatusResponse(p);
    return v === null ? null : { kind: 'entityStatusResponse', payloadType: 0x4002, value: v };
  },
  [PayloadType.POWER_MODE_REQ]: (p) => ({
    kind: 'powerModeRequest',
    payloadType: 0x4003,
    value: decodeEmpty(p),
  }),
  [PayloadType.POWER_MODE_RES]: (p) => {
    const v = decodePowerModeResponse(p);
    return v === null ? null : { kind: 'powerModeResponse', payloadType: 0x4004, value: v };
  },
  [PayloadType.DIAGNOSTIC_MESSAGE]: (p) => {
    const v = decodeDiagnosticMessage(p);
    return v === null ? null : { kind: 'diagnosticMessage', payloadType: 0x8001, value: v };
  },
  [PayloadType.DIAGNOSTIC_MESSAGE_ACK]: (p) => {
    const v = decodeDiagnosticMessageAck(p);
    return v === null ? null : { kind: 'diagnosticMessageAck', payloadType: 0x8002, value: v };
  },
  [PayloadType.DIAGNOSTIC_MESSAGE_NACK]: (p) => {
    const v = decodeDiagnosticMessageNack(p);
    return v === null ? null : { kind: 'diagnosticMessageNack', payloadType: 0x8003, value: v };
  },
};

export type DoipPayloadInput = Exclude<DoipPayload, { kind: 'unknown' }>;

export class DoipPayloadCodec {
  static meta(payloadType: number): ReturnType<typeof payloadTypeMeta> {
    return payloadTypeMeta(payloadType);
  }

  /** 解码；未知 type 或长度不足 → `{kind:'unknown', hex}`（不抛异常） */
  static decode(payloadType: number, payload: Uint8Array): DoipPayload {
    const decoder = DECODERS[payloadType];
    if (decoder === undefined) {
      return { kind: 'unknown', payloadType, value: { payloadType, hex: formatHexCompact(payload) } };
    }
    const decoded = decoder(view(payload));
    if (decoded === null) {
      return { kind: 'unknown', payloadType, value: { payloadType, hex: formatHexCompact(payload) } };
    }
    return decoded;
  }

  /** 编码：按 kind 分发，编译期即保证 value 与 payloadType 匹配 */
  static encode(value: DoipPayloadInput): Buffer {
    switch (value.kind) {
      case 'genericHeaderNack':
        return encodeGenericHeaderNack(value.value);
      case 'vehicleIdentificationRequest':
        return encodeVehicleIdentificationRequest(value.value);
      case 'vehicleIdentificationRequestEid':
        return encodeVehicleIdentificationRequestEid(value.value);
      case 'vehicleIdentificationRequestVin':
        return encodeVehicleIdentificationRequestVin(value.value);
      case 'vehicleAnnouncement':
        return encodeVehicleAnnouncement(value.value);
      case 'routingActivationRequest':
        return encodeRoutingActivationRequest(value.value);
      case 'routingActivationResponse':
        return encodeRoutingActivationResponse(value.value);
      case 'aliveCheckRequest':
        return encodeAliveCheckRequest();
      case 'aliveCheckResponse':
        return encodeAliveCheckResponse(value.value);
      case 'entityStatusRequest':
        return encodeEntityStatusRequest();
      case 'entityStatusResponse':
        return encodeEntityStatusResponse(value.value);
      case 'powerModeRequest':
        return encodePowerModeRequest();
      case 'powerModeResponse':
        return encodePowerModeResponse(value.value);
      case 'diagnosticMessage':
        return encodeDiagnosticMessage(value.value);
      case 'diagnosticMessageAck':
        return encodeDiagnosticMessageAck(value.value);
      case 'diagnosticMessageNack':
        return encodeDiagnosticMessageNack(value.value);
      default:
        throw new AppError('E_DOIP_UNSUPPORTED_PAYLOAD_TYPE', 'payload 编码：未知 kind');
    }
  }
}
