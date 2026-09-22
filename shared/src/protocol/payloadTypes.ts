/**
 * DoIP payload type 枚举与元信息（§3.4）。
 */

export const PayloadType = {
  GENERIC_HEADER_NACK: 0x0000,
  VEHICLE_IDENTIFICATION_REQ: 0x0001,
  VEHICLE_IDENTIFICATION_REQ_EID: 0x0002,
  VEHICLE_IDENTIFICATION_REQ_VIN: 0x0003,
  VEHICLE_ANNOUNCEMENT: 0x0004,
  ROUTING_ACTIVATION_REQ: 0x0005,
  ROUTING_ACTIVATION_RES: 0x0006,
  ALIVE_CHECK_REQ: 0x0007,
  ALIVE_CHECK_RES: 0x0008,
  ENTITY_STATUS_REQ: 0x4001,
  ENTITY_STATUS_RES: 0x4002,
  POWER_MODE_REQ: 0x4003,
  POWER_MODE_RES: 0x4004,
  DIAGNOSTIC_MESSAGE: 0x8001,
  DIAGNOSTIC_MESSAGE_ACK: 0x8002,
  DIAGNOSTIC_MESSAGE_NACK: 0x8003,
  /** 2019/Amd1，P0 仅识别不解析 */
  TRANSPORT_LAYER_PAYLOAD_TYPE: 0x9001,
} as const;

export type PayloadTypeValue = (typeof PayloadType)[keyof typeof PayloadType];

export interface PayloadTypeMeta {
  name: string;
  nameZh: string;
  transport: 'TCP' | 'UDP' | 'BOTH';
}

export const PAYLOAD_TYPE_META: Record<number, PayloadTypeMeta> = {
  0x0000: { name: 'GenericDoipHeaderNack', nameZh: '通用头否定响应', transport: 'BOTH' },
  0x0001: { name: 'VehicleIdentificationRequest', nameZh: '车辆识别请求', transport: 'UDP' },
  0x0002: { name: 'VehicleIdentificationRequestEid', nameZh: '按 EID 车辆识别请求', transport: 'UDP' },
  0x0003: { name: 'VehicleIdentificationRequestVin', nameZh: '按 VIN 车辆识别请求', transport: 'UDP' },
  0x0004: { name: 'VehicleAnnouncement', nameZh: '车辆公告/识别响应', transport: 'UDP' },
  0x0005: { name: 'RoutingActivationRequest', nameZh: '路由激活请求', transport: 'TCP' },
  0x0006: { name: 'RoutingActivationResponse', nameZh: '路由激活响应', transport: 'TCP' },
  0x0007: { name: 'AliveCheckRequest', nameZh: '存活检查请求', transport: 'TCP' },
  0x0008: { name: 'AliveCheckResponse', nameZh: '存活检查响应', transport: 'TCP' },
  0x4001: { name: 'EntityStatusRequest', nameZh: '实体状态请求', transport: 'UDP' },
  0x4002: { name: 'EntityStatusResponse', nameZh: '实体状态响应', transport: 'UDP' },
  0x4003: { name: 'PowerModeRequest', nameZh: '电源模式请求', transport: 'UDP' },
  0x4004: { name: 'PowerModeResponse', nameZh: '电源模式响应', transport: 'UDP' },
  0x8001: { name: 'DiagnosticMessage', nameZh: '诊断报文', transport: 'TCP' },
  0x8002: { name: 'DiagnosticMessagePositiveAck', nameZh: '诊断报文肯定确认', transport: 'TCP' },
  0x8003: { name: 'DiagnosticMessageNegativeAck', nameZh: '诊断报文否定确认', transport: 'TCP' },
  0x9001: { name: 'TransportLayerPayloadType', nameZh: '传输层载荷类型（2019）', transport: 'TCP' },
};

const UNKNOWN_META: PayloadTypeMeta = {
  name: 'Unknown',
  nameZh: '未知',
  transport: 'BOTH',
};

export function payloadTypeMeta(payloadType: number): PayloadTypeMeta {
  return PAYLOAD_TYPE_META[payloadType] ?? UNKNOWN_META;
}

export function payloadTypeName(payloadType: number): string {
  const meta = payloadTypeMeta(payloadType);
  return meta === UNKNOWN_META ? `Unknown(0x${payloadType.toString(16).toUpperCase().padStart(4, '0')})` : meta.name;
}

export function payloadTypeNameZh(payloadType: number): string {
  const meta = payloadTypeMeta(payloadType);
  return meta === UNKNOWN_META
    ? `未知(0x${payloadType.toString(16).toUpperCase().padStart(4, '0')})`
    : meta.nameZh;
}

export function isKnownPayloadType(payloadType: number): boolean {
  return PAYLOAD_TYPE_META[payloadType] !== undefined;
}
