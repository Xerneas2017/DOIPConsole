/**
 * DoIP 报文结构与 payload 接口（§3.1 / §3.4）。
 *
 * ★§8.7：shared 层不允许运行时依赖 node 内置模块，
 *   因此所有字节序列一律声明为 Uint8Array（server 侧再转 Buffer 视图）。
 */

export const DOIP_HEADER_LENGTH = 8;
export const DOIP_TCP_PORT = 13400;
export const DOIP_UDP_PORT = 13400;
export const DOIP_TLS_PORT = 3496; // P1
export const PROTOCOL_VERSION_2012 = 0x02;
export const PROTOCOL_VERSION_2019 = 0x03;

/** 通用 DoIP 头：固定 8 字节，大端 */
export interface DoipHeader {
  protocolVersion: number; // 0x02 | 0x03
  inverseProtocolVersion: number; // = (~protocolVersion) & 0xff
  payloadType: number; // 见 PayloadType
  payloadLength: number; // 后续 payload 字节数（0..0xFFFFFFFF）
  /** 派生字段：(protocolVersion ^ inverseProtocolVersion) === 0xFF */
  inverseVersionValid: boolean;
}

/** 一个完整解出的 DoIP 帧（含头） */
export interface DoipFrame {
  header: DoipHeader;
  /** 长度严格等于 header.payloadLength */
  payload: Uint8Array;
  /** 8 + payloadLength，深拷贝（不得引用 reader 内部缓冲） */
  raw: Uint8Array;
  /** 该帧首字节到达的 mono 时间戳（ms），用于分帧超时判定 */
  firstByteAtMs: number;
}

export function inverseVersionOf(pv: number): number {
  return ~pv & 0xff;
}

export function isInverseVersionValid(pv: number, ipv: number): boolean {
  return ((pv ^ ipv) & 0xff) === 0xff;
}

/* ─────────────── payload 接口（§3.4）─────────────── */

export interface GenericHeaderNackPayload {
  nackCode: number;
}

export interface VehicleIdentificationRequestPayload {
  /* 0x0001：无参数 */
}

export interface VehicleIdentificationRequestEidPayload {
  eid: Uint8Array; // 6B
}

export interface VehicleIdentificationRequestVinPayload {
  vin: string; // 17B ASCII
}

export interface VehicleAnnouncementPayload {
  vin: string;
  logicalAddress: number;
  eid: Uint8Array; // 6B
  gid: Uint8Array; // 6B
  furtherActionRequired: number;
  vinGidSyncStatus: number;
}

export interface RoutingActivationRequestPayload {
  sourceAddress: number;
  activationType: number;
  reservedIso: number; // 4B，恒 0
  reservedOem: Uint8Array; // 4B
}

export interface RoutingActivationResponsePayload {
  testerLogicalAddress: number;
  doipEntityLogicalAddress: number;
  routingActivationResponseCode: number;
  reservedIso: number; // 4B
  reservedOem: Uint8Array; // 4B
}

export interface AliveCheckRequestPayload {
  /* 0x0007：无参数（payloadLength = 0） */
}

export interface AliveCheckResponsePayload {
  sourceAddress: number;
}

export interface EntityStatusRequestPayload {
  /* 0x4001：无参数 */
}

export interface EntityStatusResponsePayload {
  nodeType: number;
  maxConcurrentSockets: number;
  currentlyOpenSockets: number;
  maxDataSize: number;
}

export interface PowerModeRequestPayload {
  /* 0x4003：无参数 */
}

export interface PowerModeResponsePayload {
  powerMode: number;
}

export interface DiagnosticMessagePayload {
  sourceAddress: number;
  targetAddress: number;
  userData: Uint8Array;
}

export interface DiagnosticMessageAckPayload {
  sourceAddress: number;
  targetAddress: number;
  ackCode: number;
  /** 网关回显的被确认报文（长度不定，可能被截断） */
  previousMessage: Uint8Array;
}

export interface DiagnosticMessageNackPayload {
  sourceAddress: number;
  targetAddress: number;
  nackCode: number;
  previousMessage: Uint8Array;
}

/** 未知 payload type：不抛异常，保留原始 hex（§3.4 表驱动约定） */
export interface UnknownPayload {
  payloadType: number;
  hex: string;
}

export type DoipPayload =
  | { kind: 'genericHeaderNack'; payloadType: 0x0000; value: GenericHeaderNackPayload }
  | { kind: 'vehicleIdentificationRequest'; payloadType: 0x0001; value: VehicleIdentificationRequestPayload }
  | { kind: 'vehicleIdentificationRequestEid'; payloadType: 0x0002; value: VehicleIdentificationRequestEidPayload }
  | { kind: 'vehicleIdentificationRequestVin'; payloadType: 0x0003; value: VehicleIdentificationRequestVinPayload }
  | { kind: 'vehicleAnnouncement'; payloadType: 0x0004; value: VehicleAnnouncementPayload }
  | { kind: 'routingActivationRequest'; payloadType: 0x0005; value: RoutingActivationRequestPayload }
  | { kind: 'routingActivationResponse'; payloadType: 0x0006; value: RoutingActivationResponsePayload }
  | { kind: 'aliveCheckRequest'; payloadType: 0x0007; value: AliveCheckRequestPayload }
  | { kind: 'aliveCheckResponse'; payloadType: 0x0008; value: AliveCheckResponsePayload }
  | { kind: 'entityStatusRequest'; payloadType: 0x4001; value: EntityStatusRequestPayload }
  | { kind: 'entityStatusResponse'; payloadType: 0x4002; value: EntityStatusResponsePayload }
  | { kind: 'powerModeRequest'; payloadType: 0x4003; value: PowerModeRequestPayload }
  | { kind: 'powerModeResponse'; payloadType: 0x4004; value: PowerModeResponsePayload }
  | { kind: 'diagnosticMessage'; payloadType: 0x8001; value: DiagnosticMessagePayload }
  | { kind: 'diagnosticMessageAck'; payloadType: 0x8002; value: DiagnosticMessageAckPayload }
  | { kind: 'diagnosticMessageNack'; payloadType: 0x8003; value: DiagnosticMessageNackPayload }
  | { kind: 'unknown'; payloadType: number; value: UnknownPayload };
