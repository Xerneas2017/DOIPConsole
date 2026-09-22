/**
 * DoIP / UDS 码表的内置 fallback（§3.5 Q2 落点）。
 *
 * 线上口径以可编辑的 `data/uds-library.json` 为准（T12 UdsLibraryStore 热更新后立即生效）；
 * 本文件仅作为库文件缺失/损坏时的兜底常量，保证协议栈永远能给出中文解释。
 *
 * ★B2：0x8003 NACK 码表按 ISO 13400-2:2012 Table 实现，未经真网关校准；
 *      若贵司网关实测口径不一致，直接在服务库 JSON 中改即可，无需改代码。
 */

import type { CodeEntry, NrcEntry } from '../types/library';

/* ─────────────── 通用头 NACK（0x0000）─────────────── */

export const FALLBACK_GENERIC_HEADER_NACK_CODES: readonly CodeEntry[] = [
  { code: '0x00', name: 'IncorrectPatternFormat', nameZh: '通用头格式错误', hint: '协议版本/inverse 字节不正确，检查对端实现', builtin: true },
  { code: '0x01', name: 'UnknownPayloadType', nameZh: '未知 payload type', hint: '对端不认识我们发的 payload type', builtin: true },
  { code: '0x02', name: 'MessageTooLarge', nameZh: '报文过大', hint: '超出对端单帧上限，拆小后重试', builtin: true },
  { code: '0x03', name: 'OutOfMemory', nameZh: '内存不足', hint: '对端资源不足，稍后重试', builtin: true },
  { code: '0x04', name: 'InvalidPayloadLength', nameZh: 'payload 长度非法', hint: 'payloadLength 与实际字节数不符', builtin: true },
];

/* ─────────────── 路由激活响应码（0x0006）─────────────── */

export const FALLBACK_ROUTING_ACTIVATION_CODES: readonly CodeEntry[] = [
  { code: '0x00', name: 'DeniedUnknownSourceAddress', nameZh: '拒绝：源地址未注册', hint: '检查 SA 是否在网关白名单内', builtin: true },
  { code: '0x01', name: 'DeniedAllSocketsInUse', nameZh: '拒绝：并发 socket 已达上限', hint: '断开其它 tester 连接后重激活', builtin: true },
  { code: '0x02', name: 'DeniedDifferentSourceAddress', nameZh: '拒绝：同一 socket 出现不同 SA', hint: '该 socket 已用其它 SA 激活', builtin: true },
  { code: '0x03', name: 'DeniedSourceAddressAlreadyActive', nameZh: '拒绝：SA 已在其它 socket 激活', hint: '先用原 socket 断开，或换一个 SA', builtin: true },
  { code: '0x04', name: 'DeniedVehicleManufacturerSpecific', nameZh: '拒绝：整车厂自定义原因', hint: '查阅整车厂文档', builtin: true },
  { code: '0x10', name: 'RoutingSuccessfullyActivated', nameZh: '路由激活成功', builtin: true },
  { code: '0x11', name: 'RoutingActivationPendingConfirmation', nameZh: '路由激活待确认', hint: '等待网关/用户确认后自动激活，可稍后查询状态', builtin: true },
];

/* ─────────────── 诊断报文 ACK 码（0x8002）─────────────── */

export const FALLBACK_ACK_CODES: readonly CodeEntry[] = [
  { code: '0x00', name: 'PositiveAcknowledge', nameZh: '网关已收下并转发', builtin: true },
];

/* ─────────────── 诊断报文 NACK 码（0x8003，ISO 13400-2:2019 Table 26）─────────────── */

/**
 * ★按 ISO 13400-2:2019（第二版）Table 26 对齐；0x00 / 0x01 为 Reserved，不得占用。
 *   （2012 版的码位比本表整体前移一格，老工具常把"源地址无效"误标成 0x00。）
 */
export const FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES: readonly CodeEntry[] = [
  { code: '0x02', name: 'InvalidSourceAddress', nameZh: '源地址无效', hint: '★网关未转发（非 UDS 层错误）：检查路由是否已激活、SA 是否被接受', builtin: true },
  { code: '0x03', name: 'UnknownTargetAddress', nameZh: '目标地址未知', hint: '★网关未转发（非 UDS 层错误）：TA 不在网关路由表内', builtin: true },
  { code: '0x04', name: 'DiagnosticMessageTooLarge', nameZh: '诊断报文过大', hint: '★网关未转发（非 UDS 层错误）：超出网关单帧上限', builtin: true },
  { code: '0x05', name: 'OutOfMemory', nameZh: '内存不足', hint: '★网关未转发（非 UDS 层错误）：网关资源不足，稍后重试', builtin: true },
  { code: '0x06', name: 'TargetUnreachable', nameZh: '目标不可达', hint: '★网关未转发（非 UDS 层错误）：目标 ECU 离线或子网不可达', builtin: true },
  { code: '0x07', name: 'UnknownNetwork', nameZh: '未知网络', hint: '★网关未转发（非 UDS 层错误）：检查网关网络配置', builtin: true },
  { code: '0x08', name: 'TransportProtocolError', nameZh: '传输协议错误', hint: '★网关未转发（非 UDS 层错误）：子网传输层（如 ISO-TP）出错', builtin: true },
];

/* ─────────────── NRC（ISO 14229-1 Annex A 常用子集）─────────────── */

export const FALLBACK_NRC_TABLE: readonly NrcEntry[] = [
  { code: '0x10', name: 'GeneralReject', nameZh: '通用拒绝', severity: 'error', builtin: true },
  { code: '0x11', name: 'ServiceNotSupported', nameZh: '服务不支持', severity: 'error', hint: '该 ECU 未实现此服务', builtin: true },
  { code: '0x12', name: 'SubFunctionNotSupported', nameZh: '子功能不支持', severity: 'error', builtin: true },
  { code: '0x13', name: 'IncorrectMessageLengthOrInvalidFormat', nameZh: '报文长度或格式错误', severity: 'error', builtin: true },
  { code: '0x14', name: 'ResponseTooLong', nameZh: '响应过长', severity: 'error', builtin: true },
  { code: '0x21', name: 'BusyRepeatRequest', nameZh: '忙，请重发', severity: 'warn', builtin: true },
  { code: '0x22', name: 'ConditionsNotCorrect', nameZh: '前置条件不满足', severity: 'warn', hint: '检查车速/电源模式/会话等前置条件', builtin: true },
  { code: '0x24', name: 'RequestSequenceError', nameZh: '请求顺序错误', severity: 'warn', builtin: true },
  { code: '0x25', name: 'NoResponseFromSubnetComponent', nameZh: '子网组件无响应', severity: 'error', builtin: true },
  { code: '0x26', name: 'FailurePreventsExecutionOfRequestedAction', nameZh: '内部故障导致无法执行', severity: 'error', builtin: true },
  { code: '0x31', name: 'RequestOutOfRange', nameZh: '请求越界', severity: 'error', hint: 'DID/参数在该 ECU 上不存在', builtin: true },
  { code: '0x33', name: 'SecurityAccessDenied', nameZh: '安全访问被拒绝', severity: 'error', hint: '先执行 0x27 解锁再访问', builtin: true },
  { code: '0x35', name: 'InvalidKey', nameZh: '密钥错误', severity: 'error', hint: '检查 Seed/Key 算法：可换算法或改用自定义 JS', builtin: true },
  { code: '0x36', name: 'ExceedNumberOfAttempts', nameZh: '尝试次数超限', severity: 'error', hint: '等待延时计时器到期后重试', builtin: true },
  { code: '0x37', name: 'RequiredTimeDelayNotExpired', nameZh: '延时未到', severity: 'warn', hint: '等待延时计时器到期后重试', builtin: true },
  { code: '0x70', name: 'UploadDownloadNotAccepted', nameZh: '上传/下载不被接受', severity: 'error', builtin: true },
  { code: '0x71', name: 'TransferDataSuspended', nameZh: '数据传输暂停', severity: 'warn', builtin: true },
  { code: '0x72', name: 'GeneralProgrammingFailure', nameZh: '通用编程失败', severity: 'error', builtin: true },
  { code: '0x73', name: 'WrongBlockSequenceCounter', nameZh: '块序号错误', severity: 'error', builtin: true },
  { code: '0x78', name: 'RequestCorrectlyReceivedResponsePending', nameZh: '已收到请求，响应待续', severity: 'info', hint: '★非错误：ECU 处理中，事务转入 P2* 续等', builtin: true },
  { code: '0x7E', name: 'SubFunctionNotSupportedInActiveSession', nameZh: '当前会话不支持该子功能', severity: 'warn', hint: '先切到扩展会话（10 03）', builtin: true },
  { code: '0x7F', name: 'ServiceNotSupportedInActiveSession', nameZh: '当前会话不支持该服务', severity: 'warn', hint: '先切到扩展/编程会话', builtin: true },
  { code: '0x81', name: 'RpmTooHigh', nameZh: '转速过高', severity: 'warn', builtin: true },
  { code: '0x82', name: 'RpmTooLow', nameZh: '转速过低', severity: 'warn', builtin: true },
  { code: '0x83', name: 'EngineIsRunning', nameZh: '发动机正在运转', severity: 'warn', builtin: true },
  { code: '0x84', name: 'EngineIsNotRunning', nameZh: '发动机未运转', severity: 'warn', builtin: true },
  { code: '0x85', name: 'EngineRunTimeTooLow', nameZh: '发动机运行时间过短', severity: 'warn', builtin: true },
  { code: '0x86', name: 'TemperatureTooHigh', nameZh: '温度过高', severity: 'warn', builtin: true },
  { code: '0x87', name: 'TemperatureTooLow', nameZh: '温度过低', severity: 'warn', builtin: true },
  { code: '0x88', name: 'VehicleSpeedTooHigh', nameZh: '车速过高', severity: 'warn', builtin: true },
  { code: '0x89', name: 'VehicleSpeedTooLow', nameZh: '车速过低', severity: 'warn', builtin: true },
  { code: '0x8A', name: 'ThrottlePedalTooHigh', nameZh: '油门踏板过高', severity: 'warn', builtin: true },
  { code: '0x8B', name: 'ThrottlePedalTooLow', nameZh: '油门踏板过低', severity: 'warn', builtin: true },
  { code: '0x8C', name: 'TransmissionRangeNotInNeutral', nameZh: '变速箱不在空挡', severity: 'warn', builtin: true },
  { code: '0x8D', name: 'TransmissionRangeNotInGear', nameZh: '变速箱不在挡位', severity: 'warn', builtin: true },
  { code: '0x8F', name: 'BrakeSwitchNotClosed', nameZh: '制动开关未闭合', severity: 'warn', builtin: true },
  { code: '0x90', name: 'ShifterLeverNotInPark', nameZh: '换挡杆不在 P 挡', severity: 'warn', builtin: true },
  { code: '0x91', name: 'TorqueConverterClutchLocked', nameZh: '液力变矩器离合器锁止', severity: 'warn', builtin: true },
  { code: '0x92', name: 'VoltageTooHigh', nameZh: '电压过高', severity: 'warn', builtin: true },
  { code: '0x93', name: 'VoltageTooLow', nameZh: '电压过低', severity: 'warn', builtin: true },
  { code: '0x94', name: 'ResourceTemporarilyNotAvailable', nameZh: '资源暂时不可用', severity: 'warn', builtin: true },
];

/* ─────────────── 查表工具 ─────────────── */

export interface CodeDescription {
  code: number;
  known: boolean;
  name: string;
  nameZh: string;
  hint: string | null;
  severity: 'error' | 'warn' | 'info';
}

/** 把 '0x78' / '78' / '0X78' 统一解析为数值；非法返回 null */
function codeValueOf(text: string): number | null {
  const matched = /^(?:0[xX])?([0-9a-fA-F]{1,2})$/.exec(text.trim());
  if (matched === null || matched[1] === undefined) return null;
  const value = Number.parseInt(matched[1], 16);
  return Number.isFinite(value) ? value & 0xff : null;
}

/** 在码表中查找（code 字段形如 '0x10'，大小写与 0x 前缀均不敏感） */
export function lookupCodeEntry(table: readonly CodeEntry[], code: number): CodeEntry | null {
  const want = code & 0xff;
  for (const entry of table) {
    const value = codeValueOf(entry.code);
    if (value === want) return entry;
  }
  return null;
}

/** 查表并给出完整的中文描述；未命中时返回 Unknown(0xXX)，绝不抛异常 */
export function describeCode(table: readonly CodeEntry[], code: number): CodeDescription {
  const entry = lookupCodeEntry(table, code);
  const unknownHex = `0x${(code & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
  if (!entry) {
    return {
      code,
      known: false,
      name: `Unknown(${unknownHex})`,
      nameZh: `未知码(${unknownHex})`,
      hint: '码表中无此条目，可在服务库 JSON 中补充',
      severity: 'warn',
    };
  }
  let severity: CodeDescription['severity'] = 'error';
  const rawSeverity = 'severity' in entry ? entry.severity : undefined;
  if (rawSeverity === 'info' || rawSeverity === 'warn' || rawSeverity === 'error') {
    severity = rawSeverity;
  }
  return {
    code,
    known: true,
    name: entry.name,
    nameZh: entry.nameZh,
    hint: entry.hint ?? null,
    severity,
  };
}

/** 只要中文名（含 Unknown 兜底） */
export function codeNameZh(table: readonly CodeEntry[], code: number): string {
  return describeCode(table, code).nameZh;
}

/** 路由激活是否成功（0x10 = 成功，0x11 = 待确认） */
export function isRoutingActivationSuccess(code: number): boolean {
  return code === 0x10;
}

export function isRoutingActivationPending(code: number): boolean {
  return code === 0x11;
}
