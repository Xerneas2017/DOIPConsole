/**
 * DoIP 实体侧 UDP（§3.10 / §5.1）：响应 0x0001/0x0002/0x0003 识别请求，
 * 并在启动后按 UDP_ANNOUNCE_INTERVAL_MS 发 UDP_ANNOUNCE_COUNT 次 0x0004 公告。
 *
 * 真 dgram socket（难点 3 要求），可被 Wireshark 抓 lo0 观测。
 */

import dgram from 'node:dgram';
import type { RemoteInfo } from 'node:dgram';
import { LIMITS, PayloadType, UDP_BROADCAST_ADDRESS, parseHex, parseLogicalAddress } from '@doip/shared';
import type { SimEntityConfig } from '@doip/shared';
import { DoipHeaderCodec } from '../doip/DoipHeaderCodec';
import { DoipPayloadCodec } from '../doip/DoipPayloadCodec';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getTiming } from '../config/defaults';

export interface DoipEntityUdpOptions {
  host: string;
  port: number;
  entities: SimEntityConfig[];
  protocolVersion?: number;
  /** 公告同时发往该单播地址（回环场景：广播包到不了 127.0.0.1 绑定socket） */
  announceUnicastHosts?: string[];
  /** 当前已建立的 TCP 诊断连接数（用于 0x4002 实体状态响应的 currentlyOpenSockets） */
  openSocketCount?: () => number;
}

/**
 * "实体 → tester"方向的 payload type：正常情况下不该由 tester 发给我们。
 * 我们自己的公告/状态响应会回环到本 socket，这类报文静默忽略（debug），不报 warn。
 */
const ENTITY_ORIGINATED_TYPES: ReadonlySet<number> = new Set([
  PayloadType.VEHICLE_ANNOUNCEMENT, // 0x0004
  PayloadType.ALIVE_CHECK_RES, // 0x0008
  PayloadType.ENTITY_STATUS_RES, // 0x4002
  PayloadType.POWER_MODE_RES, // 0x4004
]);

export class DoipEntityUdp {
  private readonly log = getLogger('sim.udp');
  private readonly options: DoipEntityUdpOptions;
  private readonly protocolVersion: number;
  private socket: dgram.Socket | null = null;
  private entities: SimEntityConfig[];
  private announceTimers: NodeJS.Timeout[] = [];

  constructor(options: DoipEntityUdpOptions) {
    this.options = options;
    this.protocolVersion = options.protocolVersion ?? 0x02;
    this.entities = options.entities;
  }

  get port(): number | null {
    const addr = this.socket?.address();
    return addr === undefined ? null : addr.port;
  }

  get isRunning(): boolean {
    return this.socket !== null;
  }

  updateEntities(entities: SimEntityConfig[]): void {
    this.entities = entities;
  }

  async start(): Promise<number> {
    if (this.socket !== null) return this.port ?? this.options.port;
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        socket.close();
        reject(
          new AppError(
            code === 'EADDRINUSE' ? 'E_SIM_PORT_BUSY' : 'E_SIM_START_FAILED',
            `仿真 UDP 端口 ${this.options.port} 绑定失败`,
            { detail: { code, message: err.message }, cause: err },
          ),
        );
      };
      socket.once('error', onError);
      socket.once('listening', () => {
        socket.removeListener('error', onError);
        resolve();
      });
      try {
        socket.bind(this.options.port, this.options.host);
      } catch (err) {
        onError(err instanceof Error ? err : new Error(String(err)));
      }
    });
    try {
      socket.setBroadcast(true);
    } catch {
      this.log.debug('设置 SO_BROADCAST 失败（不影响单播响应）');
    }
    socket.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
      this.onMessage(msg, rinfo);
    });
    socket.on('error', (err: Error) => {
      this.log.warn('仿真 UDP socket 错误', { message: err.message });
    });
    this.socket = socket;
    this.log.info('仿真 UDP 已绑定', { host: this.options.host, port: this.port });
    return this.port ?? this.options.port;
  }

  /** 周期公告（默认 TIMING.UDP_ANNOUNCE_COUNT 次，间隔 TIMING.UDP_ANNOUNCE_INTERVAL_MS） */
  announce(count?: number, intervalMs?: number): void {
    const total = count ?? getTiming('UDP_ANNOUNCE_COUNT');
    const gap = intervalMs ?? getTiming('UDP_ANNOUNCE_INTERVAL_MS');
    for (let i = 0; i < total; i += 1) {
      const timer = setTimeout(() => {
        this.sendAnnouncements();
      }, i * gap);
      this.announceTimers.push(timer);
    }
  }

  async stop(): Promise<void> {
    for (const timer of this.announceTimers) clearTimeout(timer);
    this.announceTimers = [];
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    await new Promise<void>((resolve) => {
      socket.close(() => resolve());
    });
    this.log.info('仿真 UDP 已停止');
  }

  /* ─────────────── 内部实现 ─────────────── */

  private onMessage(msg: Buffer, rinfo: RemoteInfo): void {
    const header = DoipHeaderCodec.tryDecodeHeader(msg, 0);
    if (header === null) return;
    if (msg.length < 8 + header.payloadLength) return;
    switch (header.payloadType) {
      case PayloadType.VEHICLE_IDENTIFICATION_REQ:
        this.replyAll(rinfo);
        return;
      case PayloadType.VEHICLE_IDENTIFICATION_REQ_EID: {
        const decoded = DoipPayloadCodec.decode(
          PayloadType.VEHICLE_IDENTIFICATION_REQ_EID,
          msg.subarray(8, 8 + header.payloadLength),
        );
        if (decoded.kind !== 'vehicleIdentificationRequestEid') return;
        const wanted = Array.from(decoded.value.eid)
          .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
          .join('');
        this.replyMatching(rinfo, (cfg) => cfg.eid.replace(/^0x/i, '').toUpperCase() === wanted);
        return;
      }
      case PayloadType.VEHICLE_IDENTIFICATION_REQ_VIN: {
        const decoded = DoipPayloadCodec.decode(
          PayloadType.VEHICLE_IDENTIFICATION_REQ_VIN,
          msg.subarray(8, 8 + header.payloadLength),
        );
        if (decoded.kind !== 'vehicleIdentificationRequestVin') return;
        this.replyMatching(rinfo, (cfg) => cfg.vin === decoded.value.vin);
        return;
      }
      /**
       * ★DoIP 实体状态请求（0x4001 → 0x4002），走 UDP。
       *
       * 之前这里只处理了 0x0001/0x0002/0x0003 三种"车辆识别"请求，
       * 0x4001 落到 default 被静默丢弃 —— 于是第三方标准客户端
       * （如 python-doipclient 的 `request_entity_status()`）必然超时。
       * 这是互操作性缺口，不是对方的问题。
       */
      case PayloadType.ENTITY_STATUS_REQ:
        this.replyEntityStatus(rinfo);
        return;
      /**
       * ★协议完整度补齐：电源模式请求（0x4003 → 0x4004）。
       *
       * 与 0x4001 同属 UDP 管理通道。之前仿真侧没有这个分支，tester 发 0x4003
       * 会落到 default 被丢弃 —— 互操作性缺口（第三方库 request_power_mode() 必超时）。
       * 仿真恒回 0x02（准备就绪）；需要模拟未就绪场景时用故障注入扩展。
       */
      case PayloadType.POWER_MODE_REQ:
        this.replyPowerMode(rinfo);
        return;
      default:
        /**
         * ★"实体 → tester"方向的报文会**回环到我们自己的 socket**
         * （公告按 `announceUnicastHosts` 单播到 127.0.0.1，端口与本 socket 相同），
         * 这类报文不需要处理，属于正常现象，不能报 warn，否则日志会被噪声淹没。
         *
         * 只有"看起来像请求但我们没处理"的类型才值得 warn 并留下原始字节
         * —— 这条日志正是当初定位 0x4001 缺失的关键。
         */
        if (ENTITY_ORIGINATED_TYPES.has(header.payloadType)) {
          this.log.debug('UDP 收到实体自身方向报文（回环，正常）', {
            payloadType: `0x${header.payloadType.toString(16).padStart(4, '0')}`,
          });
          return;
        }
        this.log.warn('仿真 UDP 收到未处理的请求（已记录原始字节）', {
          peer: `${rinfo.address}:${rinfo.port}`,
          payloadType: `0x${header.payloadType.toString(16).padStart(4, '0')}`,
          payloadLength: header.payloadLength,
          payloadHex: msg.subarray(8, 8 + Math.min(header.payloadLength, 24)).toString('hex').toUpperCase(),
        });
        return;
    }
  }

  /**
   * 回 0x4002 实体状态响应（7 字节：nodeType + maxConcurrentSockets + currentlyOpenSockets + maxDataSize）。
   *
   * 取值口径：NodeType=0x01（DoIP gateway，本仿真一个实体挂多个逻辑地址，语义上更接近网关）；
   * 并发 socket 上限与"当前已开"取实际值；maxDataSize 取本项目的单帧 payload 上界。
   */
  private replyEntityStatus(rinfo: RemoteInfo): void {
    const socket = this.socket;
    if (socket === null) return;
    const cfg = this.entities[0];
    const payload = DoipPayloadCodec.encode({
      kind: 'entityStatusResponse',
      payloadType: PayloadType.ENTITY_STATUS_RES,
      value: {
        nodeType: 0x01,
        maxConcurrentSockets: LIMITS.SIM_MAX_CONCURRENT_TCP_SOCKETS,
        currentlyOpenSockets: this.options.openSocketCount?.() ?? 0,
        maxDataSize: LIMITS.MAX_PAYLOAD_BYTES,
      },
    });
    const frame = DoipHeaderCodec.buildFrame(this.protocolVersion, PayloadType.ENTITY_STATUS_RES, payload);
    try {
      socket.send(frame, 0, frame.length, rinfo.port, rinfo.address);
      this.log.info('已回实体状态响应 0x4002', { peer: `${rinfo.address}:${rinfo.port}`, logicalAddress: cfg?.logicalAddress });
    } catch (err) {
      this.log.warn('实体状态响应发送失败', {
        peer: `${rinfo.address}:${rinfo.port}`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private replyAll(rinfo: RemoteInfo): void {
    for (const cfg of this.entities) this.sendAnnouncement(cfg, rinfo.address, rinfo.port);
  }

  /** 回 0x4004 电源模式响应（1 字节）。仿真恒回 0x02 = 准备就绪。 */
  private replyPowerMode(rinfo: RemoteInfo): void {
    const socket = this.socket;
    if (socket === null) return;
    const payload = DoipPayloadCodec.encode({
      kind: 'powerModeResponse',
      payloadType: PayloadType.POWER_MODE_RES,
      value: { powerMode: 0x02 },
    });
    const frame = DoipHeaderCodec.buildFrame(this.protocolVersion, PayloadType.POWER_MODE_RES, payload);
    try {
      socket.send(frame, 0, frame.length, rinfo.port, rinfo.address);
      this.log.info('已回电源模式响应 0x4004', { peer: `${rinfo.address}:${rinfo.port}` });
    } catch (err) {
      this.log.warn('电源模式响应发送失败', {
        peer: `${rinfo.address}:${rinfo.port}`,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private replyMatching(rinfo: RemoteInfo, predicate: (cfg: SimEntityConfig) => boolean): void {
    for (const cfg of this.entities) {
      if (predicate(cfg)) this.sendAnnouncement(cfg, rinfo.address, rinfo.port);
    }
  }

  /** 主动公告：广播 + 可配单播（回环） */
  private sendAnnouncements(): void {
    const socket = this.socket;
    if (socket === null) return;
    const port = this.port ?? this.options.port;
    const unicastHosts = this.options.announceUnicastHosts ?? ['127.0.0.1'];
    for (const cfg of this.entities) {
      const frame = this.announcementFrame(cfg);
      try {
        socket.send(frame, 0, frame.length, port, UDP_BROADCAST_ADDRESS);
      } catch (err) {
        this.log.debug('UDP 广播公告失败', { message: err instanceof Error ? err.message : String(err) });
      }
      for (const host of unicastHosts) {
        const frame = this.announcementFrame(cfg);
        try {
          socket.send(frame, 0, frame.length, port, host);
        } catch (err) {
          this.log.debug('UDP 单播公告失败', { host, message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  private sendAnnouncement(cfg: SimEntityConfig, host: string, port: number): void {
    const socket = this.socket;
    if (socket === null) return;
    const frame = this.announcementFrame(cfg);
    try {
      socket.send(frame, 0, frame.length, port, host);
    } catch (err) {
      this.log.warn('UDP 公告发送失败', { host, port, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private announcementFrame(cfg: SimEntityConfig): Buffer {
    const payload = DoipPayloadCodec.encode({
      kind: 'vehicleAnnouncement',
      payloadType: PayloadType.VEHICLE_ANNOUNCEMENT,
      value: {
        vin: cfg.vin,
        logicalAddress: parseLogicalAddress(cfg.logicalAddress),
        eid: parseHex(cfg.eid),
        gid: parseHex(cfg.gid),
        furtherActionRequired: cfg.furtherActionRequired,
        vinGidSyncStatus: cfg.vinGidSyncStatus,
      },
    });
    return DoipHeaderCodec.buildFrame(this.protocolVersion, PayloadType.VEHICLE_ANNOUNCEMENT, payload);
  }
}
