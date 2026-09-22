/**
 * DoIP Tester 侧客户端（§3.8 / §4.1）。
 *
 * ★难点 3 的关键约束：连仿真 ECU 与连真实网关走**完全相同**的 DoipClient 代码路径，
 *   差别只有 host/port（以及由此得到的 mode 标记）。本类不感知对端是仿真还是真件。
 *
 * ★Q1：本类不含任何自动重连 / 自动重发逻辑；失败只做状态上报，重激活由上层显式调用。
 */

import type { Socket } from 'node:net';
import {
  PayloadType,
  formatHexCompact,
  formatLogicalAddress,
  nowMonoMs,
  parseCode,
  parseLogicalAddress,
} from '@doip/shared';
import type {
  ConnectConfig,
  DiagnosticMessageAckPayload,
  DiagnosticMessageNackPayload,
  DiagnosticMessagePayload,
  DoipFrame,
  RoutingActivationResponsePayload,
} from '@doip/shared';
import { FALLBACK_ROUTING_ACTIVATION_CODES, describeCode } from '@doip/shared';
import { DoipFrameReader } from './DoipFrameReader';
import type { FrameReaderOptions, FrameReaderError } from './DoipFrameReader';
import { DoipHeaderCodec } from './DoipHeaderCodec';
import { DoipPayloadCodec } from './DoipPayloadCodec';
import type { SocketFactory } from './SocketFactory';
import { defaultSocketFactory } from './SocketFactory';
import { AppError, fromNodeError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getFrameReaderSettings, getTiming } from '../config/defaults';

export interface RoutingActivationResult {
  code: number;
  codeName: string;
  codeNameZh: string;
  testerLogicalAddress: number;
  doipEntityLogicalAddress: number;
  reservedOem: Uint8Array;
  latencyMs: number;
}

export interface AliveCheckResult {
  sourceAddress: number;
  latencyMs: number;
}

export interface DoipClientOptions {
  factory?: SocketFactory;
  protocolVersion?: number;
  activationType?: number;
  /** 分帧器参数覆盖（默认取 config/defaults.ts） */
  frameReader?: Partial<FrameReaderOptions>;
  onFrame?: (frame: DoipFrame, direction: 'TX' | 'RX') => void;
  onDiagnosticMessage?: (payload: DiagnosticMessagePayload) => void;
  onAck?: (payload: DiagnosticMessageAckPayload) => void;
  onNack?: (payload: DiagnosticMessageNackPayload) => void;
  onGenericHeaderNack?: (nackCode: number) => void;
  onClose?: (reason: string) => void;
  onError?: (error: AppError) => void;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: AppError) => void;
  timer: NodeJS.Timeout;
  startedAtMs: number;
}

export class DoipClient {
  private readonly log = getLogger('doip.client');
  private readonly factory: SocketFactory;
  private readonly options: DoipClientOptions;
  private readonly reader: DoipFrameReader;

  private socket: Socket | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private routingWaiter: Waiter<RoutingActivationResult> | null = null;
  private aliveWaiter: Waiter<AliveCheckResult> | null = null;
  private closedReason: string | null = null;

  readonly protocolVersion: number;
  readonly activationType: number;
  /** 本端逻辑地址（SA） */
  sa: number;
  /** 当前目标地址（TA），可由上层切换而不重建连接（Q4） */
  ta: number;

  constructor(options: DoipClientOptions = {}) {
    this.options = options;
    this.factory = options.factory ?? defaultSocketFactory;
    this.protocolVersion = options.protocolVersion ?? 0x02;
    this.activationType = options.activationType ?? 0x00;
    this.sa = 0x0e00;
    this.ta = 0x1000;

    const settings = getFrameReaderSettings();
    const readerOptions: FrameReaderOptions = {
      maxPayloadBytes: options.frameReader?.maxPayloadBytes ?? settings.maxPayloadBytes,
      maxBufferBytes: options.frameReader?.maxBufferBytes ?? settings.maxBufferBytes,
      incompleteFrameTimeoutMs:
        options.frameReader?.incompleteFrameTimeoutMs ?? settings.incompleteFrameTimeoutMs,
      versionPolicy: options.frameReader?.versionPolicy ?? settings.versionPolicy,
      resyncOnDesync: options.frameReader?.resyncOnDesync ?? settings.resyncOnDesync,
      onFrame: (frame) => this.handleInboundFrame(frame),
      onError: (err) => this.handleFramingError(err),
    };
    this.reader = new DoipFrameReader(readerOptions);
  }

  /* ─────────────── 连接生命周期 ─────────────── */

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.closedReason === null;
  }

  get peer(): { host: string; port: number } | null {
    if (!this.socket) return null;
    return { host: this.socket.remoteAddress ?? '', port: this.socket.remotePort ?? 0 };
  }

  /** 建立 TCP 连接（不激活路由） */
  async connect(cfg: ConnectConfig): Promise<void> {
    const sa = parseLogicalAddress(cfg.sa);
    const ta = parseLogicalAddress(cfg.ta);
    const socket = await this.factory.connect({
      host: cfg.host,
      port: cfg.port,
      timeoutMs: getTiming('TCP_CONNECT_TIMEOUT_MS'),
    });
    this.sa = sa;
    this.ta = ta;
    if (cfg.activationType !== undefined) {
      // activationType 为字符串码（'0x00'），仅覆盖实例默认值
      this.options.activationType = parseCode(cfg.activationType);
    }
    this.attach(socket);
  }

  /** 手动重激活（★Q1 唯一允许的"重试"）：同一 socket 重发 0x0005 */
  async sendRoutingActivation(
    sa: number = this.sa,
    activationType: number = this.activationType,
  ): Promise<RoutingActivationResult> {
    this.ensureSocket();
    if (this.routingWaiter !== null) {
      throw new AppError('E_ROUTING_TIMEOUT', '上一次路由激活尚未结束');
    }
    const payload = DoipPayloadCodec.encode({
      kind: 'routingActivationRequest',
      payloadType: PayloadType.ROUTING_ACTIVATION_REQ,
      value: {
        sourceAddress: sa,
        activationType,
        reservedIso: 0,
        reservedOem: new Uint8Array(4),
      },
    });
    const startedAtMs = nowMonoMs();
    this.writeFrame(PayloadType.ROUTING_ACTIVATION_REQ, payload);
    this.sa = sa;

    return new Promise<RoutingActivationResult>((resolve, reject) => {
      const timeoutMs = getTiming('ROUTING_ACTIVATION_TIMEOUT_MS');
      const timer = setTimeout(() => {
        this.routingWaiter = null;
        reject(
          new AppError(
            'E_ROUTING_TIMEOUT',
            `路由激活响应在 ${timeoutMs}ms 内未到达（★未自动重试，请手动重激活）`,
          ),
        );
      }, timeoutMs);
      this.routingWaiter = { resolve, reject, timer, startedAtMs };
    });
  }

  /** 发一条 UDS 诊断报文（0x8001）；不等待响应（等待由 TransactionManager 负责） */
  sendDiagnosticMessage(sa: number, ta: number, userData: Uint8Array): void {
    this.ensureSocket();
    const payload = DoipPayloadCodec.encode({
      kind: 'diagnosticMessage',
      payloadType: PayloadType.DIAGNOSTIC_MESSAGE,
      value: { sourceAddress: sa, targetAddress: ta, userData },
    });
    this.writeFrame(PayloadType.DIAGNOSTIC_MESSAGE, payload);
  }

  /** 主动 Alive Check（P1-06；P0 至少保证被动回 0x0008，见 handleInboundFrame） */
  sendAliveCheck(): Promise<AliveCheckResult> {
    this.ensureSocket();
    if (this.aliveWaiter !== null) {
      return Promise.reject(new AppError('E_CONN_NOT_CONNECTED', '上一次 Alive Check 尚未结束'));
    }
    const startedAtMs = nowMonoMs();
    this.writeFrame(PayloadType.ALIVE_CHECK_REQ, DoipPayloadCodec.encode({
      kind: 'aliveCheckRequest',
      payloadType: PayloadType.ALIVE_CHECK_REQ,
      value: {},
    }));
    return new Promise<AliveCheckResult>((resolve, reject) => {
      const timeoutMs = getTiming('ALIVE_CHECK_TIMEOUT_MS');
      const timer = setTimeout(() => {
        this.aliveWaiter = null;
        reject(new AppError('E_CONN_TIMEOUT', `Alive Check 响应在 ${timeoutMs}ms 内未到达`));
      }, timeoutMs);
      this.aliveWaiter = { resolve, reject, timer, startedAtMs };
    });
  }

  close(reason = 'client-close'): void {
    if (this.closedReason !== null) return;
    this.closedReason = reason;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.rejectWaiter(this.routingWaiter, new AppError('E_CONN_RESET', `连接已关闭：${reason}`));
    this.routingWaiter = null;
    this.rejectWaiter(this.aliveWaiter, new AppError('E_CONN_RESET', `连接已关闭：${reason}`));
    this.aliveWaiter = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) socket.destroy();
    this.log.info('DoIP 连接已关闭', { reason });
    this.options.onClose?.(reason);
  }

  /* ─────────────── 内部实现 ─────────────── */

  private ensureSocket(): void {
    if (!this.isConnected()) {
      throw new AppError('E_CONN_NOT_CONNECTED', '当前没有已建立且可用的 DoIP 连接');
    }
  }

  private attach(socket: Socket): void {
    this.closedReason = null;
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      try {
        this.reader.push(chunk);
      } catch (err) {
        this.options.onError?.(fromNodeError(err, 'E_IMPL_UNEXPECTED'));
      }
    });
    socket.on('error', (err: Error) => {
      const appErr = fromNodeError(err, 'E_CONN_RESET');
      this.log.warn('socket 错误', { code: appErr.code, message: appErr.message });
      this.options.onError?.(appErr);
    });
    socket.on('close', () => {
      this.close('socket-closed');
    });
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      this.reader.tick();
    }, getTiming('FRAME_READER_TICK_MS'));
    this.log.info('DoIP socket 已挂载', { peer: `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}` });
  }

  private writeFrame(payloadType: number, payload: Buffer): void {
    const socket = this.socket;
    if (socket === null || socket.destroyed) {
      throw new AppError('E_CONN_EPIPE', 'socket 已关闭，无法发送');
    }
    const frame = DoipHeaderCodec.buildFrame(this.protocolVersion, payloadType, payload);
    socket.write(frame);
    this.emitLocalFrame(frame, 'TX');
  }

  /** 把本地发出的帧也交给 onFrame（Trace 需要 TX 方向，且 raw 为独立拷贝） */
  private emitLocalFrame(frame: Buffer, direction: 'TX' | 'RX'): void {
    const header = DoipHeaderCodec.tryDecodeHeader(frame, 0);
    if (header === null) return;
    this.options.onFrame?.(
      {
        header,
        payload: Uint8Array.from(frame.subarray(8)),
        raw: Uint8Array.from(frame),
        firstByteAtMs: nowMonoMs(),
      },
      direction,
    );
  }

  private handleInboundFrame(frame: DoipFrame): void {
    this.options.onFrame?.(frame, 'RX');
    const decoded = DoipPayloadCodec.decode(frame.header.payloadType, frame.payload);
    switch (decoded.kind) {
      case 'routingActivationResponse':
        this.resolveRouting(decoded.value);
        return;
      case 'aliveCheckResponse':
        this.resolveAlive(decoded.value.sourceAddress);
        return;
      case 'aliveCheckRequest':
        // ★B15：P0 必须实现"收到 0x0007 → 自动回 0x0008"，否则真网关会判定 tester 失联
        this.replyAliveCheck();
        return;
      case 'diagnosticMessage':
        this.options.onDiagnosticMessage?.(decoded.value);
        return;
      case 'diagnosticMessageAck':
        this.options.onAck?.(decoded.value);
        return;
      case 'diagnosticMessageNack':
        this.options.onNack?.(decoded.value);
        return;
      case 'genericHeaderNack': {
        this.log.warn('收到通用头否定响应', { nackCode: `0x${decoded.value.nackCode.toString(16)}` });
        this.options.onGenericHeaderNack?.(decoded.value.nackCode);
        const waiter = this.routingWaiter;
        if (waiter !== null) {
          clearTimeout(waiter.timer);
          this.routingWaiter = null;
          waiter.reject(new AppError('E_DOIP_HEADER_NACK', '对端返回通用头否定响应（0x0000）'));
        }
        return;
      }
      case 'unknown':
        this.log.debug('未知 payload type，仅记录', {
          payloadType: `0x${frame.header.payloadType.toString(16)}`,
        });
        return;
      default:
        return;
    }
  }

  /** 回 0x0008 Alive Check Response（传输层保活，与 UDS 3E 不同层） */
  private replyAliveCheck(): void {
    try {
      this.writeFrame(
        PayloadType.ALIVE_CHECK_RES,
        DoipPayloadCodec.encode({
          kind: 'aliveCheckResponse',
          payloadType: PayloadType.ALIVE_CHECK_RES,
          value: { sourceAddress: this.sa },
        }),
      );
      this.log.debug('已回应 Alive Check (0x0008)', { sa: formatLogicalAddress(this.sa) });
    } catch (err) {
      this.options.onError?.(fromNodeError(err, 'E_CONN_EPIPE'));
    }
  }

  private resolveRouting(value: RoutingActivationResponsePayload): void {
    const waiter = this.routingWaiter;
    if (waiter === null) {
      this.log.warn('收到路由激活响应但没有等待中的请求', { code: `0x${value.routingActivationResponseCode.toString(16)}` });
      return;
    }
    clearTimeout(waiter.timer);
    this.routingWaiter = null;
    const desc = describeCode(FALLBACK_ROUTING_ACTIVATION_CODES, value.routingActivationResponseCode);
    waiter.resolve({
      code: value.routingActivationResponseCode,
      codeName: desc.name,
      codeNameZh: desc.nameZh,
      testerLogicalAddress: value.testerLogicalAddress,
      doipEntityLogicalAddress: value.doipEntityLogicalAddress,
      reservedOem: value.reservedOem,
      latencyMs: nowMonoMs() - waiter.startedAtMs,
    });
  }

  private resolveAlive(sourceAddress: number): void {
    const waiter = this.aliveWaiter;
    if (waiter === null) return;
    clearTimeout(waiter.timer);
    this.aliveWaiter = null;
    waiter.resolve({ sourceAddress, latencyMs: nowMonoMs() - waiter.startedAtMs });
  }

  private handleFramingError(err: FrameReaderError): void {
    this.log.error('分帧错误，关闭连接', { code: err.code, messageZh: err.messageZh, dumpHex: err.dumpHex });
    this.options.onError?.(new AppError(err.code, err.messageZh, { detail: { dumpHex: err.dumpHex } }));
    // 字节流已失同步，继续解析只会产出垃圾帧 → 关闭，由上层决定是否手动重连（★Q1 不自动重连）
    this.close(`framing-error:${err.code}`);
  }

  private rejectWaiter<T>(waiter: Waiter<T> | null, error: AppError): void {
    if (waiter === null) return;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  /** 最近一次写出的帧头 hex（调试用） */
  static frameHex(frame: DoipFrame): string {
    return formatHexCompact(frame.raw);
  }
}
