/**
 * 事务配对规则（§3.6）—— 纯函数，无状态，便于单测直接断言。
 */

/** 请求/响应双向的配对键（响应方向：sa=ECU，ta=Tester） */
export function keyOf(sa: number, ta: number): string {
  return `${sa}->${ta}`;
}

/** 正响应 SID = 请求 SID | 0x40 */
export function expectPositiveSid(sid: number): number {
  return (sid & 0xff) | 0x40;
}

export const NEGATIVE_RESPONSE_SID = 0x7f;
export const NRC_RESPONSE_PENDING = 0x78;

/**
 * 带子功能字节的服务（用于解析 suppressPosRsp 位）。
 *
 * ★这张表必须严格按 ISO 14229-1 的请求格式来，**多列一个就是协议级 bug**。
 *   曾经把 0x14 也列进来，导致用户发 `14 FF FF FF`（清除 DTC 组 0xFFFFFF）时，
 *   第 2 字节 `FF` 的 bit7 被误判成 suppressPosRsp → 事务被标成 SUPPRESSED，
 *   ECU 明明回了 `54 FF FF FF` 却被当作"不该有响应"丢弃，用户以为发送失败。
 *
 * 依据 ISO 14229-1 的请求格式逐个核对：
 *   有子功能：0x10 会话 / 0x11 复位 / 0x19 读DTC / 0x27 安全访问 / 0x28 通信控制 /
 *             0x29 认证 / 0x2C 动态DID / 0x31 例程 / 0x3E TesterPresent /
 *             0x83 时序参数 / 0x85 DTC设置 / 0x86 RoE / 0x87 链路控制
 *   **没有子功能**（第 2 字节起是数据，bit7 语义完全不同）：
 *             0x14 清DTC（DTCGroup 3B）/ 0x22 读DID / 0x2E 写DID /
 *             0x34 请求下载（dataFormatIdentifier）/ 0x35 请求上传 /
 *             0x36 传输数据（blockSequenceCounter，bit7 不是抑制位）/
 *             0x37 请求退出传输
 */
export const UDS_SERVICES_WITH_SUBFUNCTION: ReadonlySet<number> = new Set([
  0x10, 0x11, 0x19, 0x27, 0x28, 0x29, 0x2c, 0x31, 0x3e, 0x83, 0x85, 0x86, 0x87,
]);

export function hasSubFunction(sid: number): boolean {
  return UDS_SERVICES_WITH_SUBFUNCTION.has(sid & 0xff);
}

/** 7F <reqSid> <nrc> */
export function isNegativeResponse(userData: Uint8Array): boolean {
  return userData.length >= 3 && (userData[0] ?? 0) === NEGATIVE_RESPONSE_SID;
}

export function negativeResponseSid(userData: Uint8Array): number | null {
  if (!isNegativeResponse(userData)) return null;
  return userData[1] ?? null;
}

export function nrcOf(userData: Uint8Array): number | null {
  if (!isNegativeResponse(userData)) return null;
  return userData[2] ?? null;
}

export function isPendingNrc(nrc: number): boolean {
  return nrc === NRC_RESPONSE_PENDING;
}

export function isPositiveResponseFor(userData: Uint8Array, expectedPositiveSid: number): boolean {
  return userData.length >= 1 && (userData[0] ?? -1) === expectedPositiveSid;
}

/**
 * 子功能字节最高位 = suppressPosRsp 标志。
 * 仅对"有子功能的服务"生效，避免把数据字节误判成子功能。
 */
export function suppressPositiveResponseOf(userData: Uint8Array): boolean {
  if (userData.length < 2) return false;
  const sid = userData[0] ?? 0;
  if (!hasSubFunction(sid)) return false;
  return ((userData[1] ?? 0) & 0x80) !== 0;
}

/**
 * ACK/NACK 回显的 previousMessage 与本端请求是否一致。
 * 长度 < 2 时无法校验 → 视为一致（部分网关不回显）。
 */
export function previousMessageMatches(previousMessage: Uint8Array, request: Uint8Array): boolean {
  if (previousMessage.length < 2) return true;
  const n = Math.min(previousMessage.length, request.length);
  for (let i = 0; i < n; i += 1) {
    if (previousMessage[i] !== request[i]) return false;
  }
  return true;
}
