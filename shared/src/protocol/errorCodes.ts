/**
 * 错误码注册表（§8.2）—— 全项目唯一口径。
 *
 * 规则：
 *  - 格式 `E_<域>_<名称>`，域：DOIP / TXN / CONN / UDP / SEC / SIM / LIB / WS / IO / IMPL
 *  - ★禁止把原始英文 error（ECONNREFUSED）直接丢给用户，必须经本表映射为中文 + 处置建议
 *  - E_IMPL_* 视为 bug，必须同时落 error 级日志（含 stack）
 */

import type { WsError } from './wsMessages';

export type ErrorSeverity = 'info' | 'warn' | 'error';

export interface ErrorCodeDef {
  code: string;
  messageZh: string;
  severity: ErrorSeverity;
  hintZh?: string;
  /** 是否允许用户重试（★Q1：仅表示"可手动重试"，绝不触发自动重发） */
  retryable: boolean;
}

function def(
  code: string,
  messageZh: string,
  severity: ErrorSeverity,
  retryable: boolean,
  hintZh?: string,
): ErrorCodeDef {
  return hintZh === undefined ? { code, messageZh, severity, retryable } : { code, messageZh, severity, retryable, hintZh };
}

export const ERROR_CODES: Record<string, ErrorCodeDef> = {
  /* ── DOIP：协议层 ── */
  E_DOIP_INVERSE_VERSION_INVALID: def(
    'E_DOIP_INVERSE_VERSION_INVALID',
    'DoIP 协议版本校验失败，字节流可能已失同步',
    'error',
    false,
    '协议版本与其反码不满足 XOR=0xFF，可在设置中把版本校验切为 lenient 以继续解析',
  ),
  E_DOIP_PAYLOAD_TOO_LARGE: def(
    'E_DOIP_PAYLOAD_TOO_LARGE',
    'DoIP 帧 payloadLength 超过上限，疑似失同步',
    'error',
    false,
    '已停止解析并关闭连接；请检查对端是否为标准 DoIP 实现',
  ),
  E_DOIP_BUFFER_OVERFLOW: def(
    'E_DOIP_BUFFER_OVERFLOW',
    '分帧缓冲超过上界仍未凑齐一帧',
    'error',
    false,
    '已停止解析并关闭连接；通常由对端发来非 DoIP 流量引起',
  ),
  E_DOIP_INCOMPLETE_FRAME_TIMEOUT: def(
    'E_DOIP_INCOMPLETE_FRAME_TIMEOUT',
    'TCP 字节流中出现不完整 DoIP 帧且超时未完成',
    'error',
    false,
    '半包卡死；检查网络 MTU/分片或对端是否在发送中途崩溃',
  ),
  E_DOIP_HEADER_NACK: def(
    'E_DOIP_HEADER_NACK',
    '对端返回通用头否定响应（0x0000）',
    'error',
    false,
    '检查协议版本、payload type 与 payload 长度是否被对端接受',
  ),
  E_DOIP_UNSUPPORTED_PAYLOAD_TYPE: def(
    'E_DOIP_UNSUPPORTED_PAYLOAD_TYPE',
    '暂不支持该 payload type 的解析',
    'warn',
    false,
    '该报文已原样记录，仅显示为 Unknown',
  ),

  /* ── CONN：连接与路由激活 ── */
  E_CONN_REFUSED: def('E_CONN_REFUSED', '目标主动拒绝 TCP 连接', 'error', true, '检查 IP/端口是否正确、DoIP 服务是否已启动'),
  E_CONN_TIMEOUT: def('E_CONN_TIMEOUT', 'TCP 连接超时', 'error', true, '检查网线/VLAN/防火墙，确认目标在线'),
  E_CONN_RESET: def('E_CONN_RESET', '连接被对端重置', 'error', true, '对端异常或路由被网关断开，可手动重新连接'),
  E_CONN_HOST_UNREACH: def('E_CONN_HOST_UNREACH', '目标主机不可达', 'error', true, '检查路由与子网配置'),
  E_CONN_EPIPE: def('E_CONN_EPIPE', '写入失败：连接已断开', 'error', true, '连接已被对端关闭，请重新连接'),
  E_CONN_NOT_CONNECTED: def('E_CONN_NOT_CONNECTED', '当前没有已建立的 DoIP 连接', 'warn', true, '请先连接并激活路由'),
  E_CONN_INVALID_CONFIG: def('E_CONN_INVALID_CONFIG', '连接参数非法', 'error', false, '检查 SA/TA/协议版本/激活类型的填写'),
  E_ROUTING_TIMEOUT: def(
    'E_ROUTING_TIMEOUT',
    '路由激活响应超时',
    'error',
    true,
    '★未自动重试：请手动点击「重激活」；若持续超时，检查网关 DoIP 路由表',
  ),
  E_ROUTING_DENIED: def(
    'E_ROUTING_DENIED',
    '路由激活被网关拒绝',
    'error',
    true,
    '★未自动重试：可手动点击「重激活」；具体原因见响应码说明',
  ),
  E_ROUTING_CONFIRM_REQUIRED: def(
    'E_ROUTING_CONFIRM_REQUIRED',
    '路由激活需网关确认（响应码 0x11）',
    'warn',
    true,
    '等待网关/用户确认后会自动激活，可稍后查询状态',
  ),

  /* ── TXN：事务层（难点 2）── */
  E_TXN_ACK_TIMEOUT: def(
    'E_TXN_ACK_TIMEOUT',
    '网关未在规定时间内返回 ACK/NACK，请求可能未进入网关',
    'error',
    true,
    '★与 ECU 超时严格区分：这是"网关没收下"，排查方向为路由激活状态与网关负载',
  ),
  E_TXN_UDS_TIMEOUT: def(
    'E_TXN_UDS_TIMEOUT',
    '网关已收下并转发（收到 0x8002 ACK），但 ECU 在 P2/P2* 内未响应',
    'error',
    true,
    '★与 ACK 超时严格区分：这是"网关已转发但 ECU 未回"，排查方向为目标 ECU 状态与子网',
  ),
  E_TXN_NACK: def(
    'E_TXN_NACK',
    '网关明确拒绝转发（收到 0x8003 NACK）',
    'error',
    true,
    '★网关未转发（非 UDS 层错误）：不要按 NRC 排查，请查 NACK 码含义',
  ),
  E_TXN_CANCELLED: def('E_TXN_CANCELLED', '事务被取消（连接断开或用户取消）', 'warn', true, '重新连接后重发'),
  E_TXN_ACK_PREVIOUS_MISMATCH: def(
    'E_TXN_ACK_PREVIOUS_MISMATCH',
    'ACK 回显的 previousMessage 与本端请求不一致',
    'warn',
    true,
    '部分网关会截断回显，已按 FIFO 继续配对，请人工核对',
  ),
  E_TXN_UNMATCHED_ACK: def('E_TXN_UNMATCHED_ACK', '收到无法配对的 ACK/NACK', 'warn', false, '可能存在并发 tester 或响应乱序'),
  E_TXN_UNSOLICITED: def('E_TXN_UNSOLICITED', '收到非本端请求触发的报文', 'info', false, 'ECU 主动上报或来自其它 tester'),
  E_TXN_INVALID_STATE: def('E_TXN_INVALID_STATE', '事务状态迁移非法', 'warn', false, '内部一致性告警，已忽略该迁移'),
  E_TXN_REQUEST_INVALID: def('E_TXN_REQUEST_INVALID', 'UDS 请求构造失败', 'error', false, '检查 hex 输入与服务/子功能/DID 填写'),

  /* ── UDP：车辆发现 ── */
  E_UDP_BROADCAST_FAILED: def(
    'E_UDP_BROADCAST_FAILED',
    'UDP 广播发送失败',
    'warn',
    true,
    '检查多网卡与防火墙；已降级为「仅单播 + 被动监听」，可在设置中填写目标 IP',
  ),
  E_UDP_BIND_FAILED: def('E_UDP_BIND_FAILED', 'UDP 监听端口绑定失败', 'warn', true, '端口被占用，已降级为仅主动请求模式'),
  E_UDP_TIMEOUT: def('E_UDP_TIMEOUT', 'UDP 车辆发现超时，未收到任何实体响应', 'warn', true, '确认目标在线且 13400 端口可达'),

  /* ── SEC：安全访问 ── */
  E_SEC_DELAY_NOT_EXPIRED: def('E_SEC_DELAY_NOT_EXPIRED', '安全访问延时未到（NRC 0x37）', 'warn', true, '等待延时计时器到期后重试'),
  E_SEC_INVALID_KEY: def('E_SEC_INVALID_KEY', '密钥错误（NRC 0x35）', 'error', true, '检查 Seed/Key 算法：可用当前 Seed 试算对照，或换用自定义 JS 算法'),
  E_SEC_ATTEMPTS_EXCEEDED: def('E_SEC_ATTEMPTS_EXCEEDED', '安全访问尝试次数超限（NRC 0x36）', 'error', true, '等待延时后重试'),
  E_SEC_LOCKED: def('E_SEC_LOCKED', '安全访问已被锁定', 'error', true, '等待锁定时间结束或复位 ECU'),
  E_SEC_NO_SEED: def('E_SEC_NO_SEED', '未取到 Seed', 'error', true, '请求种子失败或被 NRC 拒绝，检查当前会话与安全等级'),
  E_SEC_SEND_KEY_FAILED: def('E_SEC_SEND_KEY_FAILED', '发送密钥失败', 'error', true, '检查连接状态与 ECU 是否处于延时锁定'),

  /* ── SIM：仿真 ── */
  E_SIM_PORT_BUSY: def('E_SIM_PORT_BUSY', '仿真端口被占用', 'warn', true, '已顺延到候选端口，UI 会显示实际端口'),
  E_SIM_START_FAILED: def('E_SIM_START_FAILED', '仿真 ECU 启动失败', 'error', true, '检查端口占用与本地回环是否可用'),
  E_SIM_NOT_RUNNING: def('E_SIM_NOT_RUNNING', '仿真 ECU 未在运行', 'warn', true, '请先启动仿真'),

  /* ── LIB：服务库 ── */
  E_LIB_KEY_ALGO_FAILED: def('E_LIB_KEY_ALGO_FAILED', 'Key 算法执行失败', 'error', true, '检查算法表达式/JS 源码与超时设置'),
  E_LIB_INVALID_JSON: def('E_LIB_INVALID_JSON', '服务库 JSON 非法', 'error', false, '按提示的行位置修正后重试'),
  E_LIB_NOT_LOADED: def('E_LIB_NOT_LOADED', '服务库尚未加载', 'warn', true, '后端正在加载 data/uds-library.json，可稍后重试'),
  E_LIB_DUPLICATE_ID: def('E_LIB_DUPLICATE_ID', '服务库存在重复 id', 'error', false, '同一列表内 id 必须唯一（SID / DID / NRC / 别名地址）'),
  E_LIB_INVALID_HEX: def('E_LIB_INVALID_HEX', '服务库中存在非法 hex 字段', 'error', false, 'code / maskHex / keyHex 必须为合法 hex'),
  E_LIB_SHORT_NAME_TOO_LONG: def(
    'E_LIB_SHORT_NAME_TOO_LONG',
    '短名超长，Trace 列会被截断',
    'warn',
    false,
    '★Q13 口径：shortEn ≤ 5 字符、shortZh ≤ 6 个汉字',
  ),
  E_LIB_KEY_ALGO_NOT_FOUND: def('E_LIB_KEY_ALGO_NOT_FOUND', '未找到指定的 Key 算法', 'error', false, '算法 id 不存在，检查服务库或注册表'),
  E_LIB_KEY_ALGO_SEED_LEN: def('E_LIB_KEY_ALGO_SEED_LEN', 'Seed 长度与算法要求不符', 'error', false, '该算法对 seed 字节数有约束，请核对'),
  E_LIB_KEY_ALGO_KEY_LEN: def('E_LIB_KEY_ALGO_KEY_LEN', '算法产出的 Key 长度不符', 'error', false, '移植算法的输出长度约束未满足，检查 compute 实现'),
  E_LIB_KEY_ALGO_UNVERIFIED: def(
    'E_LIB_KEY_ALGO_UNVERIFIED',
    '该算法未通过测试向量校验',
    'warn',
    true,
    '★当前为占位实现或向量未全部通过：解锁可能失败（NRC 0x35）',
  ),

  /* ── WS / IO ── */
  E_WS_BAD_MESSAGE: def('E_WS_BAD_MESSAGE', '收到无法解析的 WebSocket 消息', 'warn', false, '前端与后端版本可能不一致'),
  E_WS_PONG_TIMEOUT: def('E_WS_PONG_TIMEOUT', 'WebSocket 心跳超时，已断开该连接', 'warn', true, '前端会自动重连并重放补齐，无需人工干预'),
  E_WS_SEND_FAILED: def('E_WS_SEND_FAILED', 'WebSocket 推送失败', 'warn', true, '连接可能已断开，前端重连后会按 seq 补齐'),
  E_IO_EXPORT_FAILED: def('E_IO_EXPORT_FAILED', '导出失败', 'error', true, '检查磁盘空间与目标路径权限'),
  E_IO_EXPORT_OK: def('E_IO_EXPORT_OK', '导出完成', 'info', false, '文件已开始下载'),
  E_IO_UNSUPPORTED_FORMAT: def('E_IO_UNSUPPORTED_FORMAT', '不支持的导出格式', 'error', false, '当前仅支持 CSV / JSON / JSONL / HEX 四种'),

  /* ── REC：长挂机滚动落盘（★变更 1）── */
  E_IO_SINK_OPEN_FAILED: def(
    'E_IO_SINK_OPEN_FAILED',
    '录盘目录/文件创建失败，已停止录盘',
    'warn',
    true,
    '★不影响当前连接与 Trace：可换一个可写目录后在 UI 手动重新开启录盘',
  ),
  E_IO_WRITE_FAILED: def(
    'E_IO_WRITE_FAILED',
    '录盘写入失败，已停止录盘',
    'error',
    true,
    '★不影响当前连接与 Trace：已写分片保留可用，可在 UI 手动重新开启录盘（会开新分片）',
  ),
  E_IO_DISK_FULL: def(
    'E_IO_DISK_FULL',
    '磁盘可用空间不足，已停止录盘',
    'warn',
    true,
    '★不影响当前连接与 Trace：清理磁盘后可在 UI 手动重新开启录盘',
  ),
  E_IO_SINK_BACKPRESSURE: def(
    'E_IO_SINK_BACKPRESSURE',
    '落盘写入积压，已临时丢弃部分普通条目',
    'warn',
    false,
    '缺口已在分片中以 gap 行显式标记；关键错误条目仍被保留',
  ),
  E_RECORD_NOT_STARTED: def('E_RECORD_NOT_STARTED', '录盘尚未开启', 'warn', true, '点击「开始录制」或等待后端自动开启'),

  /* ── SESSION：会话层（T05）── */
  E_SESSION_INVALID_TRANSITION: def(
    'E_SESSION_INVALID_TRANSITION',
    '会话状态迁移非法，已被拦截',
    'warn',
    false,
    '内部一致性告警，已忽略该迁移；UI 状态以最近一次 status 快照为准',
  ),

  /* ── IMPL：视为 bug ── */
  E_IMPL_UNEXPECTED: def('E_IMPL_UNEXPECTED', '发生未预期的内部错误', 'error', false, '请查看终端日志并反馈'),
  E_IMPL_NOT_IMPLEMENTED: def('E_IMPL_NOT_IMPLEMENTED', '该功能尚未实现', 'warn', false, '当前里程碑未包含此能力'),
};

const UNKNOWN_ERROR_DEF: ErrorCodeDef = {
  code: 'E_IMPL_UNEXPECTED',
  messageZh: '发生未预期的内部错误',
  severity: 'error',
  retryable: false,
  hintZh: '错误码未在注册表中登记',
};

/** 查表；未登记的错误码统一回落到 E_IMPL_UNEXPECTED（绝不把裸 code 丢给用户） */
export function getErrorDef(code: string): ErrorCodeDef {
  return ERROR_CODES[code] ?? UNKNOWN_ERROR_DEF;
}

/** 构造 WsError（★§8.2：前端只消费 WsError，不得自行拼错误文案） */
export function makeWsError(
  code: string,
  overrides?: { hintZh?: string; linkedSeq?: number; detail?: unknown; messageZh?: string },
): WsError {
  const base = getErrorDef(code);
  const error: WsError = {
    code: base.code,
    messageZh: overrides?.messageZh ?? base.messageZh,
    severity: base.severity,
    retryable: base.retryable,
  };
  const hintZh = overrides?.hintZh ?? base.hintZh;
  if (hintZh !== undefined) error.hintZh = hintZh;
  if (overrides?.linkedSeq !== undefined) error.linkedSeq = overrides.linkedSeq;
  if (overrides?.detail !== undefined) error.detail = overrides.detail;
  return error;
}

/** socket 层错误码 → 本表错误码（★禁止把 ECONNREFUSED 直接丢给用户） */
export function mapSocketErrorCode(nodeCode: string): string {
  switch (nodeCode) {
    case 'ECONNREFUSED':
      return 'E_CONN_REFUSED';
    case 'ETIMEDOUT':
      return 'E_CONN_TIMEOUT';
    case 'ECONNRESET':
      return 'E_CONN_RESET';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'E_CONN_HOST_UNREACH';
    case 'EPIPE':
      return 'E_CONN_EPIPE';
    case 'EACCES':
      return 'E_UDP_BROADCAST_FAILED';
    case 'EADDRINUSE':
      return 'E_SIM_PORT_BUSY';
    default:
      return 'E_IMPL_UNEXPECTED';
  }
}
