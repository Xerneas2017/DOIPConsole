import type { ClientCommand, ServerEvent, StreamEvent } from '@doip/shared';
import { TIMING } from '@doip/shared';

/**
 * WebSocket 客户端（T09）。
 *
 * 职责边界：
 *  - 连接生命周期：连接 / 指数退避重连 / 主动关闭；
 *  - 心跳与失活检测：后端 15 s 发一次 ws-ping（浏览器自动 pong，应用层不可见），
 *    因此前端按"最近一次入站消息时间"判活，超过 `WS_PONG_TIMEOUT_MS` 即重连；
 *  - seq 连续性：把 `trace.batch` 中的条目原样交给上层，缺口由 store 判定；
 *  - 指令 id 自增，便于 `cmd.ack` 对账。
 *
 * ★不做自动重发业务请求（Q1）：重连后只做"补齐"，不补发 UDS 请求。
 */

export type WsClientStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WsClientOptions {
  /** 例如 `ws://127.0.0.1:8787`（★Q11：只连本机） */
  url: string;
  onStatus?: (status: WsClientStatus, detail?: string) => void;
  /** 后端事件（已解析信封） */
  onEvent?: (event: ServerEvent) => void;
  /** 单个流事件（trace.entry / status / error），由 onEvent 拆分后回调 */
  onStream?: (event: StreamEvent) => void;
  /** 连接成功（含重连）——上层据此发起 resync */
  onOpen?: (lastSeq: number) => void;
  onError?: (message: string) => void;
}

/** WS 地址：优先走 Vite 代理的 /ws，同源端口；也支持显式 URL */
export function defaultWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/**
 * ★裁定①（Q1 守门三件套之一）：断线原因必须**对用户显式可见**。
 * 传输层自动重连保留，但"为什么断、现在在干什么"不能是黑盒。
 * 纯函数（供单测直接打）：把 close 事件归一成一句人话。
 */
export interface WsDisconnectInfo {
  reason: string;
  code?: number;
  at: number;
}

export function describeWsClose(input: {
  closedByUser: boolean;
  heartbeatTimeout: boolean;
  code: number;
  reason: string;
}): string {
  if (input.closedByUser) return '主动断开（用户操作，不会自动重连）';
  if (input.heartbeatTimeout) {
    return `心跳超时：连续 ${String(TIMING.WS_PONG_TIMEOUT_MS)} ms 未收到后端消息`;
  }
  const text = input.reason.trim();
  if (input.code === 1006) return '连接异常断开（1006：后端进程可能已退出）';
  if (input.code > 0) {
    return `远端断开 code=${String(input.code)}${text !== '' ? `（${text}）` : ''}`;
  }
  return '连接断开（无 close code：网络中断或后端不可达）';
}

export class WsClient {
  private readonly options: WsClientOptions;
  private socket: WebSocket | null = null;
  private status: WsClientStatus = 'idle';
  private cmdSeq = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private lastInboundAtMs = 0;
  private closedByUser = false;
  /** ★裁定①：心跳超时由本端主动 close，需要在 onclose 里区分归因 */
  private heartbeatTimeoutPending = false;
  private disconnectInfo: WsDisconnectInfo | null = null;
  /** 由上层在每次「连接成功」前更新（重连补齐起点） */
  private lastSeqProvider: () => number = () => 0;

  constructor(options: WsClientOptions) {
    this.options = options;
  }

  get currentStatus(): WsClientStatus {
    return this.status;
  }

  /** ★裁定①：最近一次断线的归因（连接成功后仍保留，供 UI 展示"上次为何断"） */
  get lastDisconnect(): WsDisconnectInfo | null {
    return this.disconnectInfo;
  }

  /** 让客户端知道当前已收到的最大 seq（重连时用于 hello 的 lastSeq） */
  setLastSeqProvider(provider: () => number): void {
    this.lastSeqProvider = provider;
  }

  connect(): void {
    if (this.socket !== null && (this.status === 'open' || this.status === 'connecting')) return;
    this.closedByUser = false;
    this.setStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (err) {
      const message = `WebSocket 创建失败：${String(err)}`;
      this.disconnectInfo = { reason: message, at: Date.now() };
      this.options.onError?.(message);
      this.scheduleReconnect();
      this.setStatus('reconnecting', `${message} · 自动重连第 ${String(this.reconnectAttempts)} 次尝试`);
      return;
    }
    this.socket = socket;

    socket.onopen = (): void => {
      this.reconnectAttempts = 0;
      this.lastInboundAtMs = Date.now();
      this.setStatus('open');
      this.startHeartbeat();
      const lastSeq = this.lastSeqProvider();
      // ★连接即 hello：后端回 hello + 按 lastSeq 补齐（ResyncService 三分支）
      this.send({ type: 'session.hello', id: this.nextId(), payload: { lastSeq } });
      this.options.onOpen?.(lastSeq);
    };

    socket.onmessage = (evt: MessageEvent<string>): void => {
      this.lastInboundAtMs = Date.now();
      const event = this.parse(evt.data);
      if (event === null) return;
      this.options.onEvent?.(event);
      this.dispatchStream(event);
    };

    socket.onerror = (): void => {
      this.options.onError?.('WebSocket 连接错误（后端未启动？）');
    };

    socket.onclose = (evt: CloseEvent): void => {
      this.socket = null;
      this.stopHeartbeat();
      const reason = describeWsClose({
        closedByUser: this.closedByUser,
        heartbeatTimeout: this.heartbeatTimeoutPending,
        code: evt.code,
        reason: evt.reason,
      });
      this.heartbeatTimeoutPending = false;
      this.disconnectInfo = { reason, code: evt.code, at: Date.now() };
      if (this.closedByUser) {
        this.setStatus('closed', reason);
        return;
      }
      // ★裁定①：先排期再广播——detail 里带上第几次尝试，UI 能说清"正在自动重连"
      this.scheduleReconnect();
      this.setStatus(
        'reconnecting',
        `${reason} · 自动重连第 ${String(this.reconnectAttempts)} 次尝试（不补发业务请求）`,
      );
    };
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.setStatus('closed', describeWsClose({ closedByUser: true, heartbeatTimeout: false, code: 0, reason: '' }));
  }

  /** 发送指令，返回指令 id（供 cmd.ack 对账） */
  send(cmd: ClientCommand): string {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      this.options.onError?.('未连接到后端，指令已丢弃');
      return '';
    }
    socket.send(JSON.stringify(cmd));
    return cmd.id;
  }

  /**
   * 发送指令（按类型生成 id）。
   * 载荷类型由调用方（泛型包装 `sendCommand`）保证，内部统一按信封序列化。
   */
  sendCommand(type: ClientCommand['type'], payload: unknown): string {
    const id = this.nextId();
    return this.send({ type, id, payload } as unknown as ClientCommand);
  }

  /* ─────────────── 内部 ─────────────── */

  private nextId(): string {
    this.cmdSeq += 1;
    return `c${String(this.cmdSeq).padStart(5, '0')}`;
  }

  private setStatus(status: WsClientStatus, detail?: string): void {
    this.status = status;
    this.options.onStatus?.(status, detail);
  }

  private parse(text: string): ServerEvent | null {
    try {
      const parsed = JSON.parse(text) as { type?: string; payload?: unknown };
      if (typeof parsed.type !== 'string') return null;
      return { type: parsed.type, payload: parsed.payload } as ServerEvent;
    } catch {
      return null;
    }
  }

  private dispatchStream(event: ServerEvent): void {
    if (event.type === 'trace.batch') {
      const payload = event.payload as { events?: StreamEvent[] };
      for (const streamEvent of payload.events ?? []) this.options.onStream?.(streamEvent);
      return;
    }
    if (event.type === 'status') {
      this.options.onStream?.({ kind: 'status', status: event.payload as never });
      return;
    }
    if (event.type === 'error') {
      this.options.onStream?.({ kind: 'error', error: event.payload as never });
    }
  }

  /**
   * 失活检测（★应用层心跳版）。
   *
   * 为什么不能只靠"最近入站消息时间"：后端的 15 s ws-ping 由浏览器协议层自动 pong，
   * **应用层完全不可见**，`lastInboundAtMs` 不会刷新 —— 空闲 45 s 就会被误判失联，
   * 每分鐘无谓重连一次（还会连带触发"陈旧状态"清屏）。
   *
   * 正确做法：本端周期发应用层 `ping`，后端回 `pong`（会走 onmessage 刷新时间戳）；
   * 只有连续 `WS_PONG_TIMEOUT_MS` 没有任何入站消息才判定失联。
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => {
      const idle = Date.now() - this.lastInboundAtMs;
      if (idle > TIMING.WS_PONG_TIMEOUT_MS) {
        this.options.onError?.(`超过 ${TIMING.WS_PONG_TIMEOUT_MS} ms 未收到后端消息，主动重连`);
        this.heartbeatTimeoutPending = true;
        this.socket?.close();
        return;
      }
      // 链路看起来还活着 → 发应用层心跳探测（pong 由 onmessage 刷新 lastInboundAtMs）
      this.send({ type: 'ping', id: this.nextId(), payload: { t: Date.now() } });
    }, TIMING.WS_HEARTBEAT_PING_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** 指数退避：base * 2^n，上限 WS_RECONNECT_MAX_MS */
  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectTimer !== null) return;
    const attempts = this.reconnectAttempts;
    const delay = Math.min(
      TIMING.WS_RECONNECT_MAX_MS,
      TIMING.WS_RECONNECT_BASE_MS * 2 ** attempts,
    );
    this.reconnectAttempts = attempts + 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
