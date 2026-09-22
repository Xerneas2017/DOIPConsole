/**
 * socket 创建注入点（§3.8 / Q9）。
 * P0 只有明文 TCP；P1 加 TlsSocketFactory 即可，协议层（DoipClient / DoipFrameReader）零改动。
 */

import net from 'node:net';
import type { Socket } from 'node:net';
import { AppError, fromNodeError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getTiming } from '../config/defaults';

export interface SocketConnectOptions {
  host: string;
  port: number;
  /** TIMING.TCP_CONNECT_TIMEOUT_MS */
  timeoutMs: number;
}

export interface SocketFactory {
  /** 建立一条字节流连接；失败抛 AppError（已映射为中文错误码） */
  connect(options: SocketConnectOptions): Promise<Socket>;
}

export class PlainTcpFactory implements SocketFactory {
  connect(options: SocketConnectOptions): Promise<Socket> {
    const log = getLogger('doip.conn');
    return new Promise<Socket>((resolve, reject) => {
      const socket = net.createConnection({ host: options.host, port: options.port });
      let settled = false;

      const cleanup = (): void => {
        socket.removeListener('error', onError);
        socket.removeListener('connect', onConnect);
        socket.removeListener('timeout', onTimeout);
      };

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      function onError(err: Error): void {
        finish(() => {
          reject(fromNodeError(err, 'E_CONN_REFUSED'));
        });
      }

      function onConnect(): void {
        finish(() => {
          socket.setTimeout(0); // 连接完成，交回上层管理
          log.info('TCP 连接建立', { host: options.host, port: options.port });
          resolve(socket);
        });
      }

      function onTimeout(): void {
        finish(() => {
          socket.destroy();
          reject(
            new AppError(
              'E_CONN_TIMEOUT',
              `TCP 连接 ${options.host}:${options.port} 在 ${options.timeoutMs}ms 内未建立`,
              { detail: { host: options.host, port: options.port } },
            ),
          );
        });
      }

      socket.once('error', onError);
      socket.once('timeout', onTimeout);
      socket.once('connect', onConnect);
      socket.setTimeout(options.timeoutMs);
    });
  }
}

/** 默认注入实例 */
export const defaultSocketFactory: SocketFactory = new PlainTcpFactory();

/** 便捷函数：用默认工厂建立连接（超时取 TIMING） */
export function connectTcp(
  host: string,
  port: number,
  factory: SocketFactory = defaultSocketFactory,
): Promise<Socket> {
  return factory.connect({ host, port, timeoutMs: getTiming('TCP_CONNECT_TIMEOUT_MS') });
}
