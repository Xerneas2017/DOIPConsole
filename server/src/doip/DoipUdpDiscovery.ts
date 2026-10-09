/**
 * UDP 车辆发现（§3.4 / §5.1）：0x0001/0x0002/0x0003 主动请求 + 0x0004 被动监听。
 *
 * 失败分支：sendto 抛 EACCES/ENETUNREACH → 上报 E_UDP_BROADCAST_FAILED，
 * 降级为「仅单播 + 被动监听」；bind 失败 → E_UDP_BIND_FAILED。
 */

import dgram from 'node:dgram';
import type { RemoteInfo } from 'node:dgram';
import {
  DOIP_UDP_PORT,
  PayloadType,
  UDP_BROADCAST_ADDRESS,
  formatHexCompact,
  formatLogicalAddress,
  nowEpochMs,
} from '@doip/shared';
import type { DiscoveredEntity, DoipFrame } from '@doip/shared';
import { DoipHeaderCodec } from './DoipHeaderCodec';
import { DoipPayloadCodec } from './DoipPayloadCodec';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getTiming } from '../config/defaults';

export interface DiscoveryOptions {
  /** 目标/监听端口（默认 13400；连仿真时传仿真实际端口） */
  port?: number;
  protocolVersion?: number;
  /** 广播失败时是否同时探测 127.0.0.1（仿真 ECU 跑在回环上，默认 true） */
  includeLoopback?: boolean;
  onFrame?: (frame: DoipFrame, direction: 'TX' | 'RX', peer: string) => void;
}

export interface ScanOptions {
  targetIp?: string;
  timeoutMs?: number;
  passive?: boolean;
  port?: number;
}

export interface ScanResult {
  entities: DiscoveredEntity[];
  /** true = 超时提前返回，结果可能不全 */
  partial: boolean;
}

interface PendingRequest {
  resolve: (entities: DiscoveredEntity[]) => void;
  timer: NodeJS.Timeout;
}

export class DoipUdpDiscovery {
  private readonly log = getLogger('doip.udp');
  private readonly options: DiscoveryOptions;
  private readonly protocolVersion: number;
  private requestSocket: dgram.Socket | null = null;
  private passiveSocket: dgram.Socket | null = null;
  private pending: PendingRequest | null = null;
  private collected = new Map<string, DiscoveredEntity>();
  private degraded = false;

  constructor(options: DiscoveryOptions = {}) {
    this.options = options;
    this.protocolVersion = options.protocolVersion ?? 0x02;
  }

  get port(): number {
    return this.options.port ?? DOIP_UDP_PORT;
  }

  /** 是否已降级为「仅单播 + 被动监听」 */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** 单播识别请求 */
  async unicastRequest(ip: string, timeoutMs?: number, port?: number): Promise<DiscoveredEntity[]> {
    return this.request([ip], timeoutMs, port);
  }

  /** 广播识别请求（失败自动降级为单播 + 回环探测） */
  async broadcastRequest(timeoutMs?: number, port?: number): Promise<DiscoveredEntity[]> {
    const targets: string[] = [UDP_BROADCAST_ADDRESS];
    if (this.options.includeLoopback !== false) targets.push('127.0.0.1');
    return this.request(targets, timeoutMs, port);
  }

  /** 综合扫描：主动请求 + 可选被动监听 */
  async scan(opts: ScanOptions = {}): Promise<ScanResult> {
    const port = opts.port ?? this.port;
    const timeoutMs = opts.timeoutMs ?? getTiming('UDP_ANNOUNCE_LISTEN_MS');
    /**
     * ★审计 P2（#9）：曾因回调写成 `() => undefined`，被动监听收到的 0x0004 公告
     * 全部被丢弃，passive 扫描永远只有主动请求的结果。这里按与主动请求相同的
     * key 去重并入 collected（不动 request() 内部的重置时机，避免竞态丢帧）。
     */
    const passiveEntities = new Map<string, DiscoveredEntity>();
    let passiveRequested = false;
    if (opts.passive === true) {
      passiveRequested = true;
      try {
        this.startPassiveListen((entity) => {
          const key = `${entity.vin}|${entity.logicalAddress}|${entity.ip}`;
          if (!passiveEntities.has(key)) passiveEntities.set(key, entity);
        }, port);
      } catch (err) {
        this.log.warn('被动监听启动失败，降级为仅主动请求', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const entities = opts.targetIp
      ? await this.unicastRequest(opts.targetIp, timeoutMs, port)
      : await this.broadcastRequest(timeoutMs, port);
    this.stopPassiveListen();
    // 合并被动公告（可能与主动响应重复同一台，按 key 去重）
    const merged = [...entities];
    const seen = new Set(entities.map((e) => `${e.vin}|${e.logicalAddress}|${e.ip}`));
    for (const [key, entity] of passiveEntities) {
      if (!seen.has(key)) merged.push(entity);
    }
    /**
     * `partial` 语义（★与前端注释同步）：true = 本次结果可能不全。
     * 广播被降级（只能单播+回环）或开了被动监听（监听窗口外的公告必然错过）都算。
     */
    return { entities: merged, partial: this.degraded || passiveRequested };
  }

  /** 被动监听 0x0004 公告 */
  startPassiveListen(cb: (entity: DiscoveredEntity) => void, port?: number): void {
    if (this.passiveSocket !== null) return;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
      const entity = this.parseAnnouncement(msg, rinfo, true);
      if (entity !== null) cb(entity);
    });
    socket.on('error', (err: Error) => {
      this.log.warn('被动监听 socket 错误', { message: err.message });
    });
    const targetPort = port ?? this.port;
    try {
      socket.bind(targetPort);
    } catch (err) {
      socket.close();
      throw new AppError('E_UDP_BIND_FAILED', `UDP 被动监听端口 ${targetPort} 绑定失败`, {
        detail: { message: err instanceof Error ? err.message : String(err) },
        cause: err,
      });
    }
    this.passiveSocket = socket;
  }

  stopPassiveListen(): void {
    const socket = this.passiveSocket;
    this.passiveSocket = null;
    if (socket === null) return;
    try {
      socket.close();
    } catch {
      /* 关闭失败无需处理：socket 会随进程回收 */
    }
  }

  /* ─────────────── 内部实现 ─────────────── */

  private async request(targets: string[], timeoutMs?: number, port?: number): Promise<DiscoveredEntity[]> {
    const targetPort = port ?? this.port;
    const waitMs = timeoutMs ?? getTiming('UDP_UNICAST_RESPONSE_TIMEOUT_MS');
    this.collected = new Map<string, DiscoveredEntity>();

    const socket = this.ensureRequestSocket();
    const payload = DoipPayloadCodec.encode({
      kind: 'vehicleIdentificationRequest',
      payloadType: PayloadType.VEHICLE_IDENTIFICATION_REQ,
      value: {},
    });
    const frame = DoipHeaderCodec.buildFrame(this.protocolVersion, PayloadType.VEHICLE_IDENTIFICATION_REQ, payload);
    this.options.onFrame?.(this.toFrame(frame), 'TX', `${targets.join(',')}:${targetPort}`);

    let sent = 0;
    for (const target of targets) {
      try {
        socket.send(frame, 0, frame.length, targetPort, target);
        sent += 1;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (!this.degraded && (code === 'EACCES' || code === 'ENETUNREACH' || code === 'EPERM')) {
          this.degraded = true;
          this.log.warn('UDP 广播失败，降级为仅单播 + 被动监听', { target, code });
        } else {
          this.log.warn('UDP 发送失败', { target, code, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
    if (sent === 0) {
      this.log.warn('UDP 识别请求未能发往任何目标', { targets });
    }

    return new Promise<DiscoveredEntity[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.releaseRequestSocket();
        resolve([...this.collected.values()]);
      }, waitMs);
      this.pending = { resolve, timer };
    });
  }

  private ensureRequestSocket(): dgram.Socket {
    if (this.requestSocket !== null) return this.requestSocket;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
      this.options.onFrame?.(this.toFrame(msg), 'RX', `${rinfo.address}:${rinfo.port}`);
      const entity = this.parseAnnouncement(msg, rinfo, false);
      if (entity === null) return;
      const key = `${entity.vin}|${entity.logicalAddress}|${entity.ip}`;
      if (!this.collected.has(key)) this.collected.set(key, entity);
    });
    socket.on('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      this.log.warn('UDP 请求 socket 错误', { code, message: err.message });
      if (code === 'EACCES' || code === 'ENETUNREACH') this.degraded = true;
    });
    socket.bind(0);
    try {
      socket.setBroadcast(true);
    } catch {
      this.degraded = true;
    }
    this.requestSocket = socket;
    return socket;
  }

  private releaseRequestSocket(): void {
    const socket = this.requestSocket;
    this.requestSocket = null;
    if (socket === null) return;
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  }

  /** 解析 0x0004 车辆公告；非公告报文返回 null */
  private parseAnnouncement(msg: Buffer, rinfo: RemoteInfo, viaAnnouncement: boolean): DiscoveredEntity | null {
    const header = DoipHeaderCodec.tryDecodeHeader(msg, 0);
    if (header === null || header.payloadType !== PayloadType.VEHICLE_ANNOUNCEMENT) return null;
    if (msg.length < 8 + header.payloadLength) return null;
    const decoded = DoipPayloadCodec.decode(PayloadType.VEHICLE_ANNOUNCEMENT, msg.subarray(8, 8 + header.payloadLength));
    if (decoded.kind !== 'vehicleAnnouncement') return null;
    const v = decoded.value;
    return {
      vin: v.vin,
      eid: formatHexCompact(v.eid),
      gid: formatHexCompact(v.gid),
      logicalAddress: formatLogicalAddress(v.logicalAddress),
      ip: rinfo.address,
      port: rinfo.port,
      nodeType: v.logicalAddress === 0x1000 ? 'gateway' : 'node',
      furtherActionRequired: v.furtherActionRequired,
      vinGidSyncStatus: v.vinGidSyncStatus,
      viaAnnouncement,
      discoveredAtMs: nowEpochMs(),
      isSimulated: isLoopbackAddress(rinfo.address),
    };
  }

  private toFrame(buf: Buffer): DoipFrame {
    const header = DoipHeaderCodec.decodeHeader(buf, 0);
    return {
      header,
      payload: Uint8Array.from(buf.subarray(8, 8 + header.payloadLength)),
      raw: Uint8Array.from(buf),
      firstByteAtMs: 0,
    };
  }

  /** 立即结束等待中的主动请求（供上层取消） */
  cancelPending(): void {
    const pending = this.pending;
    if (pending === null) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve([...this.collected.values()]);
  }
}

function isLoopbackAddress(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}
