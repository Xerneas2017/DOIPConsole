/**
 * ★Q3 落点：全仓唯一的时序 / 容量 / 端口常量定义处。
 *
 * 约定（§8.8）：`src/**` 下禁止出现裸的超时数字字面量，
 * 由 `scripts/check-no-hardcoded-timeout.mjs` 在 CI 中守卫。
 * 本文件是唯一豁免文件。
 */

/** 所有时序参数（ms）。业务代码一律引用此处。 */
export const TIMING = {
  /* 连接与路由 */
  TCP_CONNECT_TIMEOUT_MS: 3000,
  ROUTING_ACTIVATION_TIMEOUT_MS: 500,
  ROUTING_REACTIVATE_MIN_INTERVAL_MS: 200,

  /* DoIP 传输层确认 */
  ACK_WAIT_TIMEOUT_MS: 2000, // 发出 0x8001 后等 0x8002/0x8003 的上限
  ALIVE_CHECK_TIMEOUT_MS: 500,

  /* UDS 应用层超时 */
  P2_CLIENT_MS: 200, // 请求 → 首响应
  P2_STAR_CLIENT_MS: 5000, // 收到 NRC 0x78 后的续等
  SUPPRESSED_NRC_WINDOW_MS: 200, // 抑制正响应时，仍短暂等待可能的 NRC

  /* 会话保持 */
  TESTER_PRESENT_PERIOD_MS: 2000,
  TESTER_PRESENT_MIN_PERIOD_MS: 100,
  TESTER_PRESENT_MAX_PERIOD_MS: 60000,
  TESTER_PRESENT_SAFETY_FACTOR: 0.6, // 实际周期 = min(配置周期, S3_server * 0.6)
  S3_SERVER_DEFAULT_MS: 5000,
  S3_WARN_THRESHOLD_MS: 1000, // 状态栏橙色预警

  /* 功能寻址 */
  FUNCTIONAL_AGGREGATION_WINDOW_MS: 2000,

  /* UDP 发现 */
  UDP_ANNOUNCE_LISTEN_MS: 5000,
  UDP_UNICAST_RESPONSE_TIMEOUT_MS: 2000,
  UDP_ANNOUNCE_INTERVAL_MS: 500, // 仿真端发 3 次
  UDP_ANNOUNCE_COUNT: 3,

  /* TCP 分帧守卫 */
  FRAME_ASSEMBLY_TIMEOUT_MS: 5000,
  /** DoipFrameReader 的 tick 巡检周期（由外层定时器驱动） */
  FRAME_READER_TICK_MS: 1000,

  /* 仿真子进程 */
  SIM_CHILD_START_TIMEOUT_MS: 5000,
  SIM_STOP_DRAIN_MS: 1000,

  /* WebSocket 桥接 */
  WS_PUSH_FLUSH_INTERVAL_MS: 50,
  /** 背压 L1 期间的复查周期 */
  WS_BACKPRESSURE_RECHECK_MS: 100,
  WS_HEARTBEAT_PING_MS: 15000,
  WS_PONG_TIMEOUT_MS: 45000,
  WS_RECONNECT_BASE_MS: 200,
  WS_RECONNECT_MAX_MS: 5000,

  /* Key 算法沙箱 */
  KEY_ALGO_TIMEOUT_MS: 100,

  /* 前端 UI 轮询（★N-01：这些也必须集中在此，禁止在 tsx 里裸写） */
  /** 前端首连后拉取服务库/算法清单的延迟 */
  UI_BOOTSTRAP_DELAY_MS: 300,
  /**
   * 前端"缺口自愈"轮询周期。
   * ★只在 `gaps.length > 0` 时才真的发 `session.hello` ——
   *   没有缺口时周期性重发 hello 纯属浪费（后端每次都要走一遍三分支判定）。
   */
  UI_RESYNC_POLL_INTERVAL_MS: 15000,
  /** S3 倒计时平滑插值步长（纯 UI 观感，不是协议超时） */
  UI_S3_TICK_MS: 100,
  /** 导出对话框：请求发出后兜底解锁按钮的等待时长（正常由 export.ready 提前解锁） */
  UI_EXPORT_UNLOCK_FALLBACK_MS: 1500,
} as const;

/** ★变更 1：长挂机滚动落盘策略（§3.11.1）—— 唯一来源，业务代码不得裸写这些数字 */
export interface RecordingConst {
  /** 后端启动即开始录盘（客户有长挂机需求） */
  AUTO_START: boolean;
  /** 相对用户主目录的落盘根（§3.11.1：~/.doip-console/trace-logs） */
  ROOT_DIR: string;
  /** 攒批后最长这么久强制刷盘（可调小到 100ms 提高崩溃安全性） */
  FLUSH_INTERVAL_MS: number;
  /** 攒够这么多条立即刷盘 */
  MAX_ENTRIES_PER_BATCH: number;
  /** 滚动触发（三选一，先到者生效）：条数 */
  MAX_ENTRIES_PER_FILE: number;
  /** 滚动触发：字节 */
  MAX_FILE_BYTES: number;
  /** 滚动触发：时长 */
  MAX_FILE_DURATION_MS: number;
  /** 单会话保留上限，超出删最旧分片 */
  RETAIN_MAX_BYTES_PER_SESSION: number;
  /** 0 = 不限制 */
  RETAIN_MAX_FILES: number;
  /** 0 = 不限制 */
  RETAIN_MAX_DAYS: number;
  /** 可用空间低于该值 → 停录并报错 */
  MIN_FREE_BYTES: number;
  /** 落盘侧写入流高水位，超过转 lossy */
  SINK_HIGH_WATER_BYTES: number;
  /** 状态/进度事件推送节流 */
  PROGRESS_PUSH_INTERVAL_MS: number;
}

export const RECORDING: RecordingConst = {
  AUTO_START: true,
  ROOT_DIR: '.doip-console/trace-logs',
  FLUSH_INTERVAL_MS: 1000,
  MAX_ENTRIES_PER_BATCH: 1000,
  MAX_ENTRIES_PER_FILE: 500_000,
  MAX_FILE_BYTES: 256 * 1024 * 1024,
  MAX_FILE_DURATION_MS: 3_600_000,
  RETAIN_MAX_BYTES_PER_SESSION: 5 * 1024 * 1024 * 1024,
  RETAIN_MAX_FILES: 0,
  RETAIN_MAX_DAYS: 0,
  MIN_FREE_BYTES: 1024 * 1024 * 1024,
  SINK_HIGH_WATER_BYTES: 16 * 1024 * 1024,
  PROGRESS_PUSH_INTERVAL_MS: 5000,
} as const;

/**
 * 后端运行日志落文件（自我排查用）。
 *
 * 目的：终端输出关掉/打包后就没有留痕了，出问题（如"目标主动拒绝 TCP 连接"）时
 * 只能靠猜。这里把后端日志同时写入 `~/.doip-console/logs/`，可在界面里直接查看尾部。
 */
export interface LoggingConst {
  /** 相对用户主目录的日志根：`~/.doip-console/logs` */
  ROOT_DIR: string;
  /** 单个日志文件上限，超过则按序号续写 */
  MAX_FILE_BYTES: number;
  /** 保留最近多少个日志文件（0 = 不限制） */
  KEEP_FILES: number;
  /** 攒批刷盘间隔 */
  FLUSH_INTERVAL_MS: number;
  /** 攒够这么多行立即刷盘 */
  MAX_LINES_PER_BATCH: number;
  /** 界面「查看日志」一次最多回多少行 */
  TAIL_MAX_LINES: number;
  /** 界面「查看日志」默认回多少行 */
  TAIL_DEFAULT_LINES: number;
  /**
   * 单批写入的确认上界。
   *
   * ★必须有：写入流在"已出错但 write 回调又没来"的窗口里，await 会永久挂起，
   *   而 `log.tail` 挂起会把 ack 也拖死 → 界面上"查看日志"一直转圈。
   *   超时即放行（该批计为丢弃），**日志功能绝不能把主链路拖住**。
   */
  WRITE_ACK_TIMEOUT_MS: number;
  /** `settled()` 整体等待上界（多个批次累积时的兜底） */
  SETTLE_TIMEOUT_MS: number;
}

export const LOGGING: LoggingConst = {
  ROOT_DIR: '.doip-console/logs',
  MAX_FILE_BYTES: 16 * 1024 * 1024,
  KEEP_FILES: 14,
  FLUSH_INTERVAL_MS: 1000,
  MAX_LINES_PER_BATCH: 200,
  TAIL_MAX_LINES: 5000,
  TAIL_DEFAULT_LINES: 300,
  WRITE_ACK_TIMEOUT_MS: 2000,
  SETTLE_TIMEOUT_MS: 3000,
} as const;

/** 容量与上限守卫 */
export const LIMITS = {
  MAX_PAYLOAD_BYTES: 4 * 1024 * 1024, // 单帧 payload 上界（可调至 16 MiB）
  /**
   * 仿真实体允许的并发 TCP 诊断连接上限。
   * ISO 13400-2 里该值由 OEM 定义（不固定），这里给一个常用默认值，
   * 仅用于回 0x4002 实体状态响应的 `maxConcurrentSockets` 字段。
   */
  SIM_MAX_CONCURRENT_TCP_SOCKETS: 5,
  MAX_FRAME_READER_BUFFER_BYTES: 32 * 1024 * 1024,
  MAX_UDS_USERDATA_BYTES: 4 * 1024 * 1024 - 4,
  TRACE_RING_MAX_ENTRIES: 100_000,
  TRACE_RING_MAX_BYTES: 200 * 1024 * 1024, // 与条数双上限，先到者触发淘汰
  /** 单条 TraceEntry 除 rawHex 外的对象开销估算（§9.4：~450 B） */
  TRACE_ENTRY_OVERHEAD_BYTES: 450,
  TRACE_RESYNC_SNAPSHOT_ENTRIES: 2000,
  WS_MAX_ENTRIES_PER_BATCH: 500,
  WS_MAX_BYTES_PER_BATCH: 256 * 1024,
  WS_HIGH_WATER_BYTES: 1024 * 1024,
  WS_LOW_WATER_BYTES: 256 * 1024,
  WS_MAX_BACKPRESSURE_MS: 5000, // 持续超限进入降级
  /** L2 采样率：每 N 条保留 1 条，其余计数丢弃并显式告知缺口 */
  WS_L2_SAMPLE_EVERY: 100,
  UI_TRACE_RENDER_WINDOW: 500, // 前端同时保有的 DOM 行上限

  /* ── 分帧器内部 ── */
  /** 初始缓冲区容量 */
  FRAME_READER_INITIAL_BUFFER_BYTES: 64 * 1024,
  /** 已消费字节超过该阈值即触发压实（避免 O(n^2) 拷贝） */
  FRAME_COMPACT_THRESHOLD_BYTES: 1024 * 1024,
  /** 分帧错误时 dump 的最大字节数 */
  FRAME_ERROR_DUMP_BYTES: 256,
  /** 已终态事务保留条数（供导出配对） */
  TXN_COMPLETED_RING_SIZE: 1000,

  /* ── WS 补齐（§3.12 ResyncService） ── */
  /** 补齐时每包条目数 */
  RESYNC_PACKET_ENTRIES: 500,

  /* ── 服务库（T12 / T14） ── */
  /** ★P0-10：库热更新后 repatch 重算的最近条目数 */
  LIBRARY_REPATCH_MAX_ENTRIES: 2000,
  /** 注册算法允许的最大 seed / key 长度（防呆） */
  KEY_ALGO_MAX_SEED_BYTES: 64,
  KEY_ALGO_MAX_KEY_BYTES: 64,
} as const;

export const PORTS = {
  BACKEND_HTTP: 8787,
  BACKEND_PORT_FALLBACK_RANGE: [8788, 8797] as const,
  SIM_DEFAULT_TCP_UDP: 13401, // 与真实 13400 错开
  SIM_PORT_FALLBACK_RANGE: [13402, 13410] as const,
} as const;

/** §8.4 地址与协议的默认值 */
export const DOIP_DEFAULTS = {
  PROTOCOL_VERSION: 0x02, // ISO 13400-2:2012
  TESTER_LOGICAL_ADDRESS: 0x0e00,
  FUNCTIONAL_ADDRESS: 0x1fff,
  ACTIVATION_TYPE_DEFAULT: 0x00,
  /** 逻辑地址广播/功能寻址常用值 */
  BROADCAST_ADDRESS: 0xffff,
} as const;

/** ★Q11：绑定地址写死 localhost，不提供配置项 */
export const BIND_HOST = '127.0.0.1' as const;

/** UDP 广播地址（车辆发现） */
export const UDP_BROADCAST_ADDRESS = '255.255.255.255' as const;
