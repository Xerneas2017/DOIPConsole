/**
 * English dictionary. Keys must match the Chinese baseline exactly
 * (missing keys fail at compile time via `satisfies Dict`).
 */

import type { Dict } from './types';

export const en = {
  /* ── App shell ── */
  'DoIP 诊断控制台': 'DoIP Diagnostic Console',
  '服务请求': 'Service Request',
  '安全解锁 0x27': 'Security Access 0x27',
  'A 连接': 'A · Connection',
  '展开连接面板': 'Expand connection panel',
  '折叠': 'Collapse',
  '展开': 'Expand',
  'D 详情 / 响应解码树': 'D · Details / Decoded response',
  'A 区连接面板': 'Zone A · Connection panel',
  'B 区服务请求': 'Zone B · Service request',
  'C 区 Trace': 'Zone C · Trace',
  'D 区详情': 'Zone D · Details',
  'E 区状态栏': 'Zone E · Status bar',

  /* ── Toolbar ── */
  '真实 ECU': 'Real ECU',
  '仿真 ECU': 'Simulated ECU',
  '目标': 'Target',
  '连接': 'Connect',
  '连接中…': 'Connecting…',
  '断开': 'Disconnect',
  '车辆发现': 'Vehicle discovery',
  '扫描中…': 'Scanning…',
  '服务库': 'Service library',
  'WebSocket：{label}（{status}）': 'WebSocket: {label} ({status})',
  '未连接': 'Not connected',
  '连接中': 'Connecting',
  '已连接': 'Connected',
  '自动重连中': 'Reconnecting',
  '已断开': 'Disconnected',
  '简体中文': 'Simplified Chinese',
  '英文': 'English',
  '德语': 'German',

  /* ── Status bar ── */
  '未知': 'Unknown',
  '路由': 'Routing',
  '会话': 'Session',
  '解锁': 'Unlocked',
  '错误': 'Errors',
  '条': 'entries',
  '缺口 {count}': 'Gaps {count}',
  '后端连接已断开 · 状态未知': 'Backend disconnected · status unknown',
  '后端已断开，路由激活状态未知': 'Backend disconnected; routing activation status unknown',
  '会话保持剩余时间（< 1 s 变橙预警）': 'Session keep-alive remaining (< 1 s turns orange)',
  '点击切换自动 TesterPresent': 'Click to toggle periodic TesterPresent',
  '清除': 'Clear',
  '导出…': 'Export…',
  '查看后端运行日志（自我排查：连接失败、超时、写盘异常等都有记录）':
    'View backend runtime logs (connection failures, timeouts, disk errors are all recorded)',
  '日志': 'Logs',
  '⏸ 跟随中': '⏸ Following',
  '▶ 已脱离': '▶ Detached',
  '● 录制 {entries} 条 / {mb} MB': '● Recording {entries} entries / {mb} MB',

  /* ── Connection panel ── */
  '仿真 ECU 控制': 'Simulated ECU control',
  '已发现实体': 'Discovered entities',
  'SA / TA': 'SA / TA',
  '路由激活': 'Routing activation',
  '传输层诊断': 'Transport diagnostics',
  '会话与解锁': 'Session & security',
  'SA（ tester 逻辑地址）': 'SA (tester logical address)',
  'TA（目标逻辑地址）': 'TA (target logical address)',
  '应用': 'Apply',
  'TA 切换走 target.set，不重建连接（Q4）':
    'TA changes use target.set and do not rebuild the connection (Q4)',
  '正在扫描…': 'Scanning…',
  '暂无发现结果': 'No entities discovered',
  '点击顶部「车辆发现」发起 UDP 车辆识别请求（0x0001 → 0x0004）':
    'Click "Vehicle discovery" in the toolbar to send a UDP vehicle identification request (0x0001 → 0x0004)',
  '仿真': 'Sim',
  '带入 {endpoint}': 'Use {endpoint}',
  '连': 'Use',

  /* ── Routing activation card ── */
  '激活类型': 'Activation type',
  '协议版本': 'Protocol version',
  '最近响应码': 'Last response code',
  '同一 socket 上重发 0x0005（最小间隔 {ms} ms）':
    'Resend 0x0005 on the same socket (min interval {ms} ms)',
  '仅在已建立 TCP 连接后可用': 'Available only after the TCP connection is established',
  '重激活': 'Reactivate',

  /* ── Transport diagnostics card ── */
  'Alive Check 走当前 TCP 连接；实体状态与电源模式走 UDP（缺省问当前连接目标）':
    'Alive Check uses the current TCP connection; entity status and power mode use UDP (defaults to the current peer)',
  '发送 0x0007 并等待 0x0008（超时 {ms} ms，不自动重试）':
    'Send 0x0007 and wait for 0x0008 (timeout {ms} ms, no automatic retry)',
  '需先连接并激活路由': 'Connect and activate routing first',
  'UDP 询问实体状态（0x4001 → 0x4002）：节点类型 / 并发容量 / 当前连接数':
    'Query entity status over UDP (0x4001 → 0x4002): node type / concurrent capacity / open sockets',
  'UDP 询问电源模式（0x4003 → 0x4004）：ECU 是否就绪':
    'Query power mode over UDP (0x4003 → 0x4004): whether the ECU is ready',
  'Alive Check': 'Alive Check',
  '实体状态': 'Entity status',
  '电源模式': 'Power mode',
  '存活 SA=0x{sa}（{ms} ms）': 'Alive, SA=0x{sa} ({ms} ms)',
  '{nodeType} 当前 {open}/{max} 连接': '{nodeType}, {open}/{max} sockets in use',

  /* ── Session & security card ── */
  '当前会话': 'Current session',
  '解锁等级': 'Security level',
  'S3 倒计时': 'S3 countdown',
  '3E 心跳': '3E heartbeat',
  '▶ {seconds} s': '▶ {seconds} s',
  '⏸ 已停': '⏸ Stopped',
  '自动 TesterPresent': 'Periodic TesterPresent',
  '范围 {min}–{max} ms': 'Range {min}–{max} ms',
  '周期 (ms)': 'Period (ms)',

  /* ── Sim & fault injection ── */
  '启动': 'Start',
  '停止': 'Stop',
  '故障注入…': 'Fault injection…',
  '仿真运行中，端口 {port}，实体 {count} 个{isolated}':
    'Simulation running on port {port}, {count} entities{isolated}',
  '（独立子进程）': ' (separate process)',
  '仿真未启动': 'Simulation not running',
  '故障注入（仿真 ECU）': 'Fault injection (simulated ECU)',
  '启用该规则': 'Enable this rule',
  '匹配 SID（可空=全部）': 'Match SID (empty = all)',
  '生效次数（空=无限）': 'Occurrences (empty = unlimited)',
  '注入动作': 'Injected action',
  '路由激活响应码': 'Routing activation response code',
  'NRC / NACK 码': 'NRC / NACK code',
  '延迟（ms）': 'Delay (ms)',
  '自定义响应 hex': 'Custom response hex',
  '返回指定 NRC': 'Return a specific NRC',
  '返回 NACK（网关未转发）': 'Return NACK (gateway did not forward)',
  '不响应（触发 P2 超时）': 'No response (triggers P2 timeout)',
  '延迟响应（先 7F xx 78）': 'Delayed response (7F xx 78 first)',
  '原样返回自定义 hex': 'Return custom hex as-is',
  '路由激活强制返回码': 'Force routing activation code',
  '0x11 服务不支持': '0x11 Service not supported',
  '0x22 条件不满足': '0x22 Conditions not correct',
  '0x31 请求越界': '0x31 Request out of range',
  '0x33 安全访问拒绝': '0x33 Security access denied',
  '0x78 待响应': '0x78 Response pending',
  '故障注入规则已下发（下一次匹配的请求生效）':
    'Fault injection rule applied (takes effect on the next matching request)',
  '已清除全部故障注入规则': 'All fault injection rules cleared',
  '清除规则': 'Clear rules',
  '下发': 'Apply',

  /* ── Request panel ── */
  '表单': 'Form',
  '原始 hex': 'Raw hex',
  '服务': 'Service',
  '物理寻址': 'Physical addressing',
  '功能寻址 0x1FFF': 'Functional addressing 0x1FFF',
  '取消收藏': 'Remove from favorites',
  '加入收藏夹': 'Add to favorites',
  '发送': 'Send',
  '停止周期': 'Stop periodic',
  '周期发送': 'Send periodically',
  '周期(ms)': 'Period (ms)',
  '原始 hex — 可发任意报文，不限于服务库里的条目':
    'Raw hex — send any message, not limited to library entries',
  '例如：14 FF FF FF（清除全部 DTC）　22 F1 90（读 VIN）':
    'e.g. 14 FF FF FF (clear all DTCs)  22 F1 90 (read VIN)',
  '非法 hex：必须为偶数位十六进制字符（空格与 0x 前缀会被忽略）':
    'Invalid hex: must be an even number of hex digits (spaces and 0x prefixes are ignored)',
  '按字节原样发送；服务库里有该服务时会自动带上解码与破坏性确认':
    'Sent byte-for-byte; known services get decoding and destructive-action confirmation',
  '收藏夹：': 'Favorites:',
  '预览 hex（与实际发出字节逐字节一致）': 'Hex preview (identical to the bytes actually sent)',
  '破坏性服务': 'Destructive service',
  '⚠ 破坏性操作二次确认': '⚠ Destructive operation — confirm again',
  '即将发送': 'About to send',
  '原始报文': 'raw message',
  '已按字节原样发送，不做任何补位或改写。请确认目标 ECU 支持该请求。':
    'Sent exactly as entered, without padding or rewriting. Make sure the target ECU supports this request.',
  '该服务会改变 ECU 状态或数据，且不可撤销。':
    'This service changes ECU state or data and cannot be undone.',
  '我确认已评估影响（此确认不替代鉴权）':
    'I have assessed the impact (this confirmation does not replace authentication)',
  '取消': 'Cancel',
  '确认发送': 'Confirm & send',
  '{name}（可选）': '{name} (optional)',
  '{name}（hex）{optional}': '{name} (hex) {optional}',
  '（可选）': ' (optional)',
  '（hex）': ' (hex)',
  '非法 hex': 'Invalid hex',
  '报文为空': 'Message is empty',
  'hex 位数必须为偶数': 'Hex length must be even',
  '0x11': '0x11',
  'ECU 会复位，正在进行的诊断会话与其它 tester 连接会被打断':
    'The ECU will reset; ongoing diagnostic sessions and other tester connections will be interrupted',
  'ECU 内已存储的 DTC 与快照数据会被永久清除，不可恢复':
    'Stored DTCs and freeze-frame data will be permanently erased and cannot be recovered',
  '会写入 ECU 的非易失存储，写错值可能导致 ECU 功能异常':
    'Writes to the ECU non-volatile memory; a wrong value may cause malfunction',
  '会启动/停止 ECU 内部例程，可能影响执行机构动作':
    'Starts/stops an internal ECU routine and may actuate components',
  '发送密钥错误会计入 ECU 解锁尝试计数，连续失败可能触发延迟惩罚甚至临时封禁（NRC 0x35/0x36）':
    'A wrong key counts against the ECU unlock attempts; repeated failures may trigger delays or a temporary lockout (NRC 0x35/0x36)',

  /* ── Security access panel ── */
  '安全等级': 'Security level',
  'Key 算法': 'Key algorithm',
  '待替换': 'To be replaced',
  '已手动指定，点此交还给后端推荐（仿真/已验证算法）':
    'Manually selected; click to restore the backend recommendation (simulation / verified algorithm)',
  '一键解锁': 'Unlock',
  '解锁成功（Level {level}，Seed {seed} → Key {key}）':
    'Unlocked (level {level}, seed {seed} → key {key})',
  '解锁失败：{reason}': 'Unlock failed: {reason}',
  '未知原因': 'unknown reason',
  '适用等级 {levels}': 'Applies to levels {levels}',
  '不限': 'any',
  'Seed {bytes} 字节': 'Seed {bytes} bytes',
  'Key {bytes}': 'Key {bytes}',
  '与 Seed 等长': 'same length as seed',
  '占位实现': 'Placeholder',
  '移植算法': 'Ported algorithm',
  '库定义 {provider}': 'Library-defined {provider}',
  '该算法未通过测试向量校验，解锁可能失败（NRC 0x35）':
    'This algorithm has not passed test-vector verification; unlocking may fail (NRC 0x35)',
  '试算': 'Trial compute',
  '算出 Key': 'Computed key',
  '向量期望值': 'Expected vector value',
  '（无对照向量）': '(no reference vector)',
  '与期望值一致': 'Matches the expected value',
  '与期望值不一致': 'Does not match the expected value',
  '测试向量（{count} 条）': 'Test vectors ({count})',
  '危险操作确认 · 0x27 SecurityAccess 解锁':
    'Dangerous operation · 0x27 SecurityAccess unlock',
  '当前算法「{name}」': 'Current algorithm "{name}"',
  '（占位实现，待替换）': ' (placeholder, to be replaced)',
  '未经测试向量校验，解锁大概率失败（NRC 0x35 incorrectKey）。':
    'has not passed test-vector verification; unlocking will most likely fail (NRC 0x35 incorrectKey).',
  '错误的 Key 会计入 ECU 的解锁尝试次数：连续失败可能触发延迟惩罚，次数耗尽后该安全等级会被 ECU 临时封禁（需重新上电或等待延时），影响后续诊断窗口。':
    'A wrong key counts against the ECU unlock attempts: repeated failures may trigger a delay, and once attempts are exhausted this security level will be temporarily locked by the ECU (power cycle or wait required), blocking further diagnostics.',
  '建议先用下方「试算」对照向量验证算法，或改用已验证（绿勾）/后端推荐算法。':
    'Verify the algorithm with the trial compute below, or switch to a verified (green check) / recommended algorithm.',
  '我已知悉上述风险：本次解锁由我人工发起，系统不会自动重试。':
    'I understand the risks: this unlock is initiated manually and the system will not retry automatically.',
  '确认发起解锁': 'Confirm unlock',

  /* ── Trace zone ── */
  '暂无报文': 'No messages yet',
  '启动仿真 ECU → 车辆发现 → 连接 → 路由激活后，Trace 会实时显示（含 UDP 发现与 TCP 诊断报文）':
    'Start the simulated ECU → discover vehicles → connect → activate routing; Trace then updates live (UDP discovery and TCP diagnostics)',
  '过滤表达式无法解析，当前按未过滤显示（不会静默丢行）':
    'Filter expression could not be parsed; showing unfiltered rows (nothing is silently dropped)',
  '⋯ 缺口：seq {seq} 起缺失 {count} 条（{reason}）':
    '⋯ Gap: {count} entries missing from seq {seq} ({reason})',
  '会自动按 seq 顺序向后端请求补齐；若后端环形缓冲已回绕覆盖该段，则不可恢复。':
    'Missing entries are requested from the backend in sequence order; if the ring buffer has already overwritten them, they cannot be recovered.',
  '复制行（JSON）': 'Copy row (JSON)',
  '复制 hex': 'Copy hex',
  '复制解码串': 'Copy decoded string',
  '在 D 区详情中查看': 'View in zone D',
  '以此为模板新建请求（T13）': 'Create request from this row (T13)',
  '显示 {shown} / {total} 条': 'Showing {shown} / {total}',
  '缺口 {count} 段': 'Gaps: {count}',
  '存在 seq 缺口（背压或缓冲溢出），seq 链条仍连续可审计':
    'Sequence gaps exist (backpressure or buffer overflow); the sequence chain remains auditable',
  '已复制{what}': 'Copied {what}',
  '复制失败（浏览器剪贴板不可用）': 'Copy failed (clipboard unavailable)',
  '第 {seq} 行 JSON': 'row {seq} JSON',
  '第 {seq} 行 hex': 'row {seq} hex',
  '第 {seq} 行解码串': 'row {seq} decoded string',
  '继续摄入（Space）': 'Resume capture (Space)',
  '暂停摄入（Space）': 'Pause capture (Space)',
  '继续': 'Resume',
  '暂停': 'Pause',
  '自动滚动到最新行（上滚会临时脱离）':
    'Auto-scroll to the newest row (scrolling up detaches temporarily)',
  '跟随': 'Follow',
  '清空前端缓冲（后端 trace.clear 同步执行）':
    'Clear the frontend buffer (backend trace.clear runs in sync)',
  '点击停止录制\n会话目录：{dir}\n当前分片：{file}\n分片数：{files}':
    'Click to stop recording\nSession directory: {dir}\nCurrent shard: {file}\nShards: {files}',
  '点击开始录制（后端 RollingFileSink，WS 背压不影响落盘完整性）':
    'Click to start recording (backend RollingFileSink; WS backpressure does not affect durability)',
  '尚无落盘目录': 'No recording directory yet',
  '尚无落盘目录（先开始录制）': 'No recording directory yet (start recording first)',
  '打开目录': 'Open folder',
  '导出 CSV / JSON / JSONL / HEX（可按过滤或 seq 区间）':
    'Export CSV / JSON / JSONL / HEX (by filter or sequence range)',
  '录制': 'Record',
  '落盘丢弃 {count}': 'Dropped on disk {count}',
  '暂停期间丢弃 {count} 条': 'Dropped while paused: {count}',
  '○ 未录制（未知）': '○ Not recording (unknown)',
  '● 录制中 {entries} 条 / {mb} MB / {files} 片':
    '● Recording {entries} entries / {mb} MB / {files} shards',
  '■ 已停止 {entries} 条 / {mb} MB / {files} 片':
    '■ Stopped {entries} entries / {mb} MB / {files} shards',
  '⚠ 录制异常 {code}（已写 {entries} 条）':
    '⚠ Recording error {code} ({entries} entries written)',
  '○ 未录制': '○ Not recording',
  '过滤：doip.type == 0x8001 && uds.sid == 0x22': 'Filter: doip.type == 0x8001 && uds.sid == 0x22',
  '表达式无法解析（按未过滤显示）': 'Expression could not be parsed (showing unfiltered)',
  '隐藏周期 3E': 'Hide periodic 3E',
  '复制当前过滤表达式': 'Copy current filter expression',
  '已复制过滤表达式': 'Filter expression copied',
  '列设置': 'Columns',
  '缓冲 {total}': 'Buffered {total}',
  'WS 背压降级': 'WS backpressure downgrade',
  '缓冲溢出淘汰': 'Buffer overflow eviction',
  '本地断号': 'Local sequence gap',
  '仅错误': 'Errors only',
  '仅 NRC': 'NRC only',
  '仅诊断报文': 'Diagnostic messages only',
  '仅读 DID(0x22)': 'Read DID (0x22) only',
  '正响应': 'Positive response',
  'NRC 否定响应': 'NRC negative response',
  '0x8002 ACK（传输层确认）': '0x8002 ACK (transport confirmation)',
  '0x8003 NACK（网关未转发）': '0x8003 NACK (not forwarded by gateway)',
  '周期 3E（可隐藏）': 'Periodic 3E (hideable)',

  /* ── Detail zone ── */
  '请求': 'Request',
  '响应': 'Response',
  '网关确认': 'Gateway ACK',
  '网关拒绝': 'Gateway NACK',
  '主动上报': 'Unsolicited',
  '事务': 'Transaction',
  '角色': 'Role',
  '耗时(ms)': 'Latency (ms)',
  '网关转发(ms)': 'Gateway forward (ms)',
  '跳转到配对行': 'Jump to paired row',
  '配对行 → seq {seq}': 'Paired row → seq {seq}',
  '超时': 'Timeout',
  '未选择报文': 'No message selected',
  '在 C 区点击任意一行，这里显示三层解码、原始 hex 与错误解释':
    'Click any row in zone C to see the three-layer decode, raw hex and error explanation here',
  '解码树': 'Decode tree',
  '错误解释': 'Error explanation',
  '点击任意字节可反向定位到字段': 'Click any byte to locate its field',
  '偏移 {offset} → {field}（{hex}）{name}': 'Offset {offset} → {field} ({hex}) {name}',
  'DoIP 通用头（8 字节）': 'DoIP generic header (8 bytes)',
  '反码版本': 'Inverse version',
  '校验通过（异或 = 0xFF）': 'Valid (XOR = 0xFF)',
  '★反码校验失败': '★Inverse version check failed',
  '负载长度': 'Payload length',
  '★网关未转发，不是 UDS 层错误': '★Not forwarded by the gateway — not a UDS-level error',
  '抑制正响应位已置起': 'Suppress-positive-response bit is set',
  '当前为兜底字段，T12 服务库接入后自动补齐':
    'Fallback field; completed once the service library is connected',
  '在 C 区选择一行报文查看三层解码': 'Select a message in zone C to view its decode',
  '偏移 {offset}（0x{hex}）': 'Offset {offset} (0x{hex})',
  '无数据': 'No data',
  '请求超时{code}': 'Request timeout{code}',
  '网关已收下并转发（收到 0x8002 ACK），但 ECU 未在 P2 时限内响应':
    'The gateway accepted and forwarded the request (0x8002 ACK), but the ECU did not respond within P2',
  '网关未在时限内返回 ACK/NACK，请求可能未进入网关':
    'The gateway did not return an ACK/NACK in time; the request may not have reached it',
  '建议：确认目标地址在线、ECU 未处于繁忙/锁定状态；必要时放大 P2 超时或检查故障注入规则。':
    'Hint: verify the target is online and the ECU is not busy/locked; increase the P2 timeout or check fault-injection rules if needed.',
  '★这是传输层错误：网关未把报文转发给 ECU，UDS 层还没有被执行（与 NRC 不同，不要按服务问题排查）。':
    '★This is a transport-layer error: the gateway did not forward the message to the ECU, so the UDS layer never ran (unlike an NRC — do not diagnose it as a service problem).',
  '建议：检查目标逻辑地址 TA 是否存在、路由激活是否成功、报文长度是否超限。':
    'Hint: check that the target logical address (TA) exists, routing activation succeeded, and the message length is within limits.',
  '是什么：{text}': 'What: {text}',
  '常见原因：{text}': 'Common causes: {text}',
  '建议动作：{text}': 'Suggested action: {text}',
  'ECU 返回了否定响应。': 'The ECU returned a negative response.',
  '否定响应': 'Negative response',
  '无事务': 'no transaction',

  /* ── Export dialog ── */
  'Excel 友好（UTF-8 BOM，26 列）': 'Excel-friendly (UTF-8 BOM, 26 columns)',
  '数组，逐字保留全部字段': 'Array preserving every field verbatim',
  '与落盘分片同格式，可流式处理': 'Same format as recording shards; stream-friendly',
  '偏移 + ASCII 侧栏，肉眼比对用': 'Offset + ASCII sidebar for visual comparison',
  'seq 区间非法（需要整数且 from ≤ to）':
    'Invalid sequence range (integers required, from ≤ to)',
  '已请求导出 {format}（{scope}）': 'Export requested: {format} ({scope})',
  '导出 Trace（{count} 条在缓冲）': 'Export Trace ({count} entries buffered)',
  '格式': 'Format',
  '范围': 'Range',
  '全部': 'All',
  '当前过滤': 'Current filter',
  'seq 区间': 'Sequence range',
  '表达式：{expr}': 'Expression: {expr}',
  '（过滤栏为空 = 全部）': '(empty filter = all)',
  '起始 seq': 'From seq',
  '结束 seq': 'To seq',
  '导出结果中剔除周期 TesterPresent（0x3E 0x80），减少噪音':
    'Exclude periodic TesterPresent (0x3E 0x80) from the export to reduce noise',
  '隐藏周期 TesterPresent（0x3E 0x80）': 'Hide periodic TesterPresent (0x3E 0x80)',
  '导出中…': 'Exporting…',
  '导出并下载': 'Export & download',

  /* ── Library editor ── */
  '服务库编辑器': 'Service library editor',
  '子功能': 'Sub-functions',
  '改动后下一次解码立即生效，并 repatch 最近 2000 条':
    'Changes apply to the next decode and repatch the most recent 2000 entries',
  '导出 JSON': 'Export JSON',
  '导入 JSON': 'Import JSON',
  '重置为内置基线': 'Reset to built-in baseline',
  '服务库尚未加载': 'Service library not loaded',
  '英文名': 'English name',
  '中文名': 'Chinese name',
  '编码': 'Codec',
  '内置': 'Built-in',
  '码值': 'Code',
  '处置建议': 'Recommendation',
  '级别': 'Severity',
  '逻辑地址': 'Logical address',
  '别名': 'Alias',
  '关闭': 'Close',
  '保存（校验后入库）': 'Save (validate then store)',
  '服务库被拒绝，已保留原库（{count} 处问题）':
    'Service library rejected; the previous library was kept ({count} issues)',
  '第 {line} 行第 {column} 列 · ': 'line {line}, column {column} · ',
  '新增': 'Add',
  '共 {count} 条': '{count} entries',
  '自定义': 'Custom',
  '中文全名': 'Full Chinese name',
  '所属服务': 'Parent service',
  '该服务没有子功能字段': 'This service has no sub-function fields',
  '值': 'Value',
  '新增 JS 算法': 'Add JS algorithm',
  '新增常量密钥': 'Add constant key',
  '自定义 JS 算法': 'Custom JS algorithm',
  '自定义常量密钥': 'Custom constant key',
  '导入的文件不是合法 JSON': 'The imported file is not valid JSON',

  /* ── Log panel ── */
  '后端运行日志': 'Backend runtime logs',
  '加载中…': 'Loading…',
  '已记录 {lines} 行 · 当前文件 {bytes} B · 保留 {files} 个文件':
    '{lines} lines recorded · current file {bytes} B · {files} files kept',
  '日志有 {count} 行因写入失败被丢弃（磁盘或权限问题），排查时请留意日志不完整。':
    '{count} log lines were dropped due to write failures (disk or permissions); logs may be incomplete.',
  '与后端的连接当前不是打开状态，显示的是上一次拉取的内容。':
    'The backend connection is not open; showing the last fetched content.',
  '只看警告/错误': 'Warnings/errors only',
  '自动刷新': 'Auto refresh',
  '仅显示最近若干行': 'Showing only the most recent lines',
  '已含全部现有日志': 'Contains all existing log lines',
  '（暂无日志）': '(no logs)',
  '（当前过滤条件下没有匹配行）': '(no lines match the current filter)',
  '目录：{dir}': 'Directory: {dir}',
  '在文件管理器里打开日志目录': 'Open the log directory in the file manager',
  '刷新': 'Refresh',

  /* ── Common ── */
  '重试': 'Retry',
  '渲染失败：{message}': 'Render failed: {message}',
  '非法 hex：只允许 0-9 / A-F': 'Invalid hex: only 0-9 / A-F allowed',
  '长度应为 {expected} 字节，当前 {actual} 字节':
    'Expected {expected} bytes, got {actual} bytes',
  '非法 hex 输入': 'Invalid hex input',
  '跳转': 'Jump',
  '跳转到对应 Trace 行': 'Jump to the corresponding Trace row',
  '暂无数据': 'No data',
} satisfies Dict;
