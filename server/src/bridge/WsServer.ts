/**
 * WebSocket 服务端（§3.12）：HTTP upgrade 接管 + 连接生命周期 + 心跳。
 *
 * ★Q11：绑定地址**写死 127.0.0.1**，不提供配置项（本机工具，不对外暴露）。
 * 心跳：每 `WS_HEARTBEAT_PING_MS` ping 一次；`WS_PONG_TIMEOUT_MS` 内未收到 pong → terminate。
 * 背压：暴露 `bufferedAmount`（所有连接中的最大值）供 BackpressureGuard 判定。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket, RawData } from 'ws';
import { BIND_HOST, PORTS } from '@doip/shared';
import type { WsEnvelope } from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getTiming } from '../config/defaults';

export type SendFn = (type: string, payload: unknown) => void;
export type MessageHandler = (text: string, send: SendFn, connId: string) => void;
export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

export interface WsServerOptions {
  /** 首选端口；被占用时顺延到 PORTS.BACKEND_PORT_FALLBACK_RANGE */
  port?: number;
  onMessage: MessageHandler;
  onHttpRequest?: HttpHandler;
  onOpen?: (connId: string) => void;
  onClose?: (connId: string) => void;
}

interface Connection {
  id: string;
  ws: WebSocket;
  lastPongMs: number;
  alive: boolean;
}

export class WsServer {
  private readonly log = getLogger('bridge.ws');
  private readonly options: WsServerOptions;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, Connection>();

  private heartbeat: NodeJS.Timeout | null = null;
  private nextConnId = 0;
  private port: number | null = null;

  constructor(options: WsServerOptions) {
    this.options = options;
    this.http = createServer((req, res) => {
      if (options.onHttpRequest !== undefined && options.onHttpRequest(req, res)) return;
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'not-found' }));
    });
    this.wss = new WebSocketServer({ noServer: true });

    this.http.on('upgrade', (req, socket, head) => {
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    });

    this.wss.on('connection', (ws) => {
      const id = this.register(ws);
      ws.on('message', (data: RawData) => {
        const text = typeof data === 'string' ? data : data.toString('utf8');
        try {
          this.options.onMessage(text, (type, payload) => this.sendTo(id, type, payload), id);
        } catch (err) {
          const appErr = err instanceof AppError ? err : new AppError('E_IMPL_UNEXPECTED', String(err));
          this.log.error('处理 WS 消息时抛出异常', { code: appErr.code, message: appErr.message });
          this.sendTo(id, 'error', appErr.toWsError());
        }
      });
      ws.on('pong', () => {
        const conn = this.connections.get(id);
        if (conn !== undefined) conn.lastPongMs = Date.now();
      });
      ws.on('error', (err: Error) => {
        this.log.warn('WS 连接错误', { connId: id, message: err.message });
      });
      ws.on('close', () => {
        this.connections.delete(id);
        this.options.onClose?.(id);
        this.log.info('WS 连接已关闭', { connId: id });
      });
      this.options.onOpen?.(id);
      this.log.info('WS 连接已建立', { connId: id });
    });
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get actualPort(): number | null {
    return this.port;
  }

  /** 所有连接中最大的未发送字节数（背压判定输入） */
  get bufferedAmount(): number {
    let max = 0;
    for (const conn of this.connections.values()) {
      if (conn.ws.bufferedAmount > max) max = conn.ws.bufferedAmount;
    }
    return max;
  }

  /** 启动监听；端口被占用则顺延到候选区间 */
  async start(): Promise<number> {
    const wanted = this.options.port ?? PORTS.BACKEND_HTTP;
    const candidates = [wanted, ...PORTS.BACKEND_PORT_FALLBACK_RANGE];
    for (const port of candidates) {
      const ok = await this.tryListen(port);
      if (ok) {
        this.port = port;
        this.startHeartbeat();
        this.log.info('后端 HTTP/WS 已监听', { host: BIND_HOST, port });
        return port;
      }
    }
    throw new AppError('E_SIM_PORT_BUSY', '后端端口被占用（含全部候选端口）');
  }

  async stop(): Promise<void> {
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const conn of this.connections.values()) {
      try {
        conn.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.http.close(() => resolve());
    });
    this.log.info('后端 HTTP/WS 已停止');
  }

  /** 广播一条服务端事件 */
  broadcast(type: string, payload: unknown): void {
    for (const conn of this.connections.values()) this.sendTo(conn.id, type, payload);
  }

  sendTo(connId: string, type: string, payload: unknown): void {
    const conn = this.connections.get(connId);
    if (conn === undefined) return;
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    const envelope: WsEnvelope<unknown> = { v: 1, type, ts: Date.now(), payload };
    try {
      conn.ws.send(JSON.stringify(envelope));
    } catch (err) {
      this.log.warn('WS 推送失败', {
        connId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /* ─────────────── 内部实现 ─────────────── */

  private register(ws: WebSocket): string {
    this.nextConnId += 1;
    const id = `ws-${String(this.nextConnId).padStart(3, '0')}`;
    this.connections.set(id, { id, ws, lastPongMs: Date.now(), alive: true });
    return id;
  }

  private tryListen(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        this.http.removeListener('error', onError);
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false);
        else resolve(false);
      };
      this.http.once('error', onError);
      this.http.listen(port, BIND_HOST, () => {
        this.http.removeListener('error', onError);
        resolve(true);
      });
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    const pingMs = getTiming('WS_HEARTBEAT_PING_MS');
    const pongTimeoutMs = getTiming('WS_PONG_TIMEOUT_MS');
    this.heartbeat = setInterval(() => {
      const nowMs = Date.now();
      for (const [id, conn] of [...this.connections.entries()]) {
        if (nowMs - conn.lastPongMs > pongTimeoutMs) {
          this.log.warn('WS 心跳超时，终止连接', { connId: id });
          conn.ws.terminate();
          this.connections.delete(id);
          continue;
        }
        if (conn.ws.readyState === conn.ws.OPEN) {
          try {
            conn.ws.ping();
          } catch {
            /* ignore */
          }
        }
      }
    }, pingMs);
  }
}
