/**
 * DoIP 实体侧 TCP Server（§3.10 / §5.6）。
 *
 * ★难点 3 的核心：这是 `net.createServer` 的**真 socket**，监听 127.0.0.1。
 * 客户端（DoipClient）连仿真与连真实网关走完全相同的代码路径，差别只有 host/port。
 *
 * 职责边界：本类负责分包/ACK/NACK/故障注入/路由；UDS 语义全在 VirtualEcu。
 */

import net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  DOIP_DEFAULTS,
  PayloadType,
  formatCode,
  formatLogicalAddress,
  parseCode,
  parseHex,
  parseLogicalAddress,
} from '@doip/shared';
import type {
  DiagnosticMessageAckPayload,
  DiagnosticMessageNackPayload,
  DiagnosticMessagePayload,
  DoipFrame,
  FaultRule,
  SimEntityConfig,
} from '@doip/shared';
import { FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES, FALLBACK_ROUTING_ACTIVATION_CODES, describeCode } from '@doip/shared';
import { DoipFrameReader } from '../doip/DoipFrameReader';
import type { FrameReaderError, FrameReaderOptions } from '../doip/DoipFrameReader';
import { DoipHeaderCodec } from '../doip/DoipHeaderCodec';
import { DoipPayloadCodec } from '../doip/DoipPayloadCodec';
import { AppError, fromNodeError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getFrameReaderSettings, getTiming } from '../config/defaults';
import { VirtualEcu } from './VirtualEcu';
import { FaultInjector, extractFirstDid, extractSidAndSub } from './FaultInjector';

/** 0x8003 NACK：ISO 13400-2:2019 Table 26 —— 0x02=源地址无效，0x03=目标地址未知 */
const NACK_INVALID_SOURCE_ADDRESS = 0x02;
const NACK_UNKNOWN_TARGET_ADDRESS = 0x03;
const NRC_RESPONSE_PENDING = 0x78;

export interface DoipEntityServerOptions {
  host: string;
  port: number;
  entities: SimEntityConfig[];
  protocolVersion?: number;
  injector?: FaultInjector;
  onEvent?: (event: SimEntityEvent) => void;
}

export type SimEntityEvent =
  | { kind: 'started'; host: string; port: number }
  | { kind: 'connection'; connId: string; peer: string }
  | { kind: 'closed'; connId: string; peer: string; reason: string }
  | { kind: 'routingActivation'; connId: string; sa: number; code: number; codeNameZh: string }
  | { kind: 'routingRejected'; connId: string; sa: number; code: number; codeNameZh: string }
  | { kind: 'diagnostic'; connId: string; sa: number; ta: number; hex: string; outcome: string }
  | { kind: 'fault'; connId: string; ruleId: string; action: string }
  | { kind: 'framingError'; connId: string; code: string; messageZh: string }
  | { kind: 'stopped' };

interface EntityConnection {
  id: string;
  socket: net.Socket;
  reader: DoipFrameReader;
  activated: boolean;
  sa: number;
  peer: string;
  timers: Set<NodeJS.Timeout>;
}

export class DoipEntityServer {
  private readonly log = getLogger('sim.entity');
  private readonly options: DoipEntityServerOptions;
  private readonly injector: FaultInjector;
  private readonly protocolVersion: number;
  private readonly ecus = new Map<string, VirtualEcu>();
  private readonly connections = new Map<string, EntityConnection>();
  private server: net.Server | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private connCounter = 0;
  private actualPort: number | null = null;

  constructor(options: DoipEntityServerOptions) {
    this.options = options;
    this.injector = options.injector ?? new FaultInjector();
    this.protocolVersion = options.protocolVersion ?? 0x02;
    for (const cfg of options.entities) {
      this.registerEcu(cfg);
    }
  }

  get port(): number | null {
    return this.actualPort;
  }

  get isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  getEntityCount(): number {
    return this.ecus.size;
  }

  getInjector(): FaultInjector {
    return this.injector;
  }

  registerEcu(cfg: SimEntityConfig): void {
    const ecu = new VirtualEcu(cfg);
    this.ecus.set(formatLogicalAddress(ecu.logicalAddress), ecu);
  }

  setFaultRules(rules: Parameters<FaultInjector['setRules']>[0]): void {
    this.injector.setRules(rules);
  }

  patchEntity(logicalAddress: string, patch: Partial<SimEntityConfig>): void {
    const key = formatLogicalAddress(parseLogicalAddress(logicalAddress));
    const ecu = this.ecus.get(key);
    if (ecu === undefined) {
      throw new AppError('E_SIM_NOT_RUNNING', `仿真中不存在逻辑地址 ${key}`);
    }
    ecu.patch(patch);
  }

  /** 启动监听；端口被占用抛 AppError(E_SIM_PORT_BUSY) */
  async start(): Promise<number> {
    if (this.isRunning) return this.actualPort ?? this.options.port;
    const server = net.createServer((socket) => {
      this.onConnection(socket);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        reject(fromNodeError(err, 'E_SIM_START_FAILED'));
      };
      server.once('error', onError);
      server.listen(this.options.port, this.options.host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    this.server = server;
    const addr = server.address();
    this.actualPort = addr !== null && typeof addr !== 'string' ? (addr as AddressInfo).port : this.options.port;
    server.on('error', (err: Error) => {
      this.log.error('仿真 TCP server 错误', { message: err.message });
    });
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => {
      for (const conn of this.connections.values()) conn.reader.tick();
    }, getTiming('FRAME_READER_TICK_MS'));
    this.log.info('仿真 DoIP 实体已监听', { host: this.options.host, port: this.actualPort });
    this.emit({ kind: 'started', host: this.options.host, port: this.actualPort });
    return this.actualPort;
  }

  async stop(): Promise<void> {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const conn of [...this.connections.values()]) {
      this.closeConnection(conn, 'server-stop');
    }
    this.connections.clear();
    const server = this.server;
    this.server = null;
    this.actualPort = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.log.info('仿真 DoIP 实体已停止');
    this.emit({ kind: 'stopped' });
  }

  /* ─────────────── 连接处理 ─────────────── */

  private onConnection(socket: net.Socket): void {
    this.connCounter += 1;
    const connId = `c${String(this.connCounter).padStart(3, '0')}`;
    const settings = getFrameReaderSettings();
    const readerOptions: FrameReaderOptions = {
      ...settings,
      onFrame: (frame) => this.onFrame(connId, frame),
      onError: (err) => this.onFramingError(connId, err),
    };
    const conn: EntityConnection = {
      id: connId,
      socket,
      reader: new DoipFrameReader(readerOptions),
      activated: false,
      sa: 0,
      peer: `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? 0}`,
      timers: new Set<NodeJS.Timeout>(),
    };
    this.connections.set(connId, conn);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => {
      conn.reader.push(chunk);
    });
    socket.on('error', (err: Error) => {
      this.log.debug('仿真连接 socket 错误', { connId, message: err.message });
    });
    socket.on('close', () => {
      this.closeConnection(conn, 'socket-closed');
    });
    this.log.info('仿真收到新连接', { connId, peer: conn.peer });
    this.emit({ kind: 'connection', connId, peer: conn.peer });
  }

  /** 当前已建立的 TCP 诊断连接数（供 0x4002 实体状态响应的 currentlyOpenSockets 使用） */
  get connectionCount(): number {
    return this.connections.size;
  }

  private closeConnection(conn: EntityConnection, reason: string): void {    for (const timer of conn.timers) clearTimeout(timer);
    conn.timers.clear();
    if (this.connections.get(conn.id) === conn) this.connections.delete(conn.id);
    if (!conn.socket.destroyed) conn.socket.destroy();
    this.log.info('仿真连接关闭', { connId: conn.id, reason });
    this.emit({ kind: 'closed', connId: conn.id, peer: conn.peer, reason });
  }

  private onFramingError(connId: string, err: FrameReaderError): void {
    this.log.error('仿真实体分帧错误', { connId, code: err.code, dumpHex: err.dumpHex });
    this.emit({ kind: 'framingError', connId, code: err.code, messageZh: err.messageZh });
    const conn = this.connections.get(connId);
    if (conn !== undefined) this.closeConnection(conn, `framing-error:${err.code}`);
  }

  private onFrame(connId: string, frame: DoipFrame): void {
    const conn = this.connections.get(connId);
    if (conn === undefined) return;
    const decoded = DoipPayloadCodec.decode(frame.header.payloadType, frame.payload);
    switch (decoded.kind) {
      case 'routingActivationRequest':
        this.handleRoutingActivation(conn, decoded.value.sourceAddress, decoded.value.activationType);
        return;
      case 'diagnosticMessage':
        this.handleDiagnostic(conn, decoded.value);
        return;
      case 'aliveCheckResponse':
        return; // tester 回应我们的 0x0007，无需处理
      /**
       * ★tester 主动发 0x0007 询问存活：这也是合法互操作场景。
       *
       * ISO 13400-2 里 Alive check 通常是"实体 → tester 发 0x0007、tester 回 0x0008"，
       * 但 tester 主动发 0x0007 问一句同样成立（python-doipclient 的
       * `request_alive_check()` 就是这么用的），实体应当回 0x0008。
       *
       * 之前这里没有分支，请求落到 default 被丢弃 →
       * 第三方库 request_alive_check() 必然超时（互操作性缺口）。
       * 回包 payload = 实体逻辑地址（2 字节）。
       */
      case 'aliveCheckRequest': {
        const primary = [...this.ecus.values()][0];
        const entityLa = primary === undefined ? 0x1000 : primary.logicalAddress;
        this.write(
          conn,
          PayloadType.ALIVE_CHECK_RES,
          DoipPayloadCodec.encode({
            kind: 'aliveCheckResponse',
            payloadType: PayloadType.ALIVE_CHECK_RES,
            value: { sourceAddress: entityLa },
          }),
        );
        return;
      }
      case 'genericHeaderNack':
        this.log.warn('仿真收到通用头 NACK', { connId, nackCode: decoded.value.nackCode });
        return;
      default:
        /**
         * ★这里必须是 warn + 带原始字节，不能是 debug。
         *
         * 教训：曾经把路由激活请求的长度写成 `>= 11` 硬校验，第三方标准客户端发来的
         * 7 字节请求被解码器判为 null → 落到这个分支 → 而这里当时是 `debug`，
         * 默认日志级别 info 下**完全不可见**。现象是"连上了、然后超时"，日志里一片空白，
         * 只能靠抓包定位。任何"收到了帧但处理不了"的情况，都必须留下原始字节可供排查。
         */
        this.log.warn('仿真收到未处理的 payload（已记录原始字节以便排查）', {
          connId,
          payloadType: `0x${frame.header.payloadType.toString(16).padStart(4, '0')}`,
          payloadLength: frame.header.payloadLength,
          payloadHex: Buffer.from(frame.payload).subarray(0, 32).toString('hex').toUpperCase(),
          decodedKind: decoded.kind,
        });
        return;
    }
  }

  /* ─────────────── 路由激活（0x0005 → 0x0006） ─────────────── */

  private handleRoutingActivation(conn: EntityConnection, sa: number, activationType: number): void {
    const routingRule = this.injector.matchRouting();
    let code: number;
    if (routingRule !== null && routingRule.action.kind === 'routingCode') {
      code = parseCode(routingRule.action.code);
      this.injector.consume(routingRule);
      this.emit({ kind: 'fault', connId: conn.id, ruleId: routingRule.id, action: `routingCode:${formatCode(code)}` });
    } else {
      const rejected = [...this.ecus.values()].find((ecu) => ecu.config.routingActivation.accept === false);
      code = rejected === undefined ? 0x10 : parseCode(rejected.config.routingActivation.forcedCode ?? '0x00');
    }
    const primary = [...this.ecus.values()][0];
    const entityLa = primary === undefined ? 0x1000 : primary.logicalAddress;
    const reservedOemHex = primary?.config.routingActivation.reservedOemHex;
    const reservedOem = reservedOemHex === undefined ? new Uint8Array(4) : parseHex(reservedOemHex);

    conn.activated = code === 0x10;
    conn.sa = sa;
    const desc = describeCode(FALLBACK_ROUTING_ACTIVATION_CODES, code);
    this.write(
      conn,
      PayloadType.ROUTING_ACTIVATION_RES,
      DoipPayloadCodec.encode({
        kind: 'routingActivationResponse',
        payloadType: PayloadType.ROUTING_ACTIVATION_RES,
        value: {
          testerLogicalAddress: sa,
          doipEntityLogicalAddress: entityLa,
          routingActivationResponseCode: code,
          reservedIso: 0,
          reservedOem,
        },
      }),
    );
    this.log.info('路由激活响应', {
      connId: conn.id,
      sa: formatLogicalAddress(sa),
      code: formatCode(code),
      codeNameZh: desc.nameZh,
      activationType: formatCode(activationType),
    });
    this.emit(
      conn.activated
        ? { kind: 'routingActivation', connId: conn.id, sa, code, codeNameZh: desc.nameZh }
        : { kind: 'routingRejected', connId: conn.id, sa, code, codeNameZh: desc.nameZh },
    );
  }

  /* ─────────────── 诊断报文（0x8001 → 0x8002 + 0x8001） ─────────────── */

  private handleDiagnostic(conn: EntityConnection, msg: DiagnosticMessagePayload): void {
    const testerSa = msg.sourceAddress;
    const ecuTa = msg.targetAddress;
    const userData = msg.userData;
    const sid = userData[0] ?? 0;
    const laHex = formatLogicalAddress(ecuTa);
    const { subFunction } = extractSidAndSub(userData);
    const did = extractFirstDid(userData);

    // ① 未激活路由 → 传输层直接 NACK（不进 UDS）
    if (!conn.activated) {
      this.sendNack(conn, testerSa, ecuTa, NACK_INVALID_SOURCE_ADDRESS, userData);
      return;
    }

    // ② 故障注入在最外层拦截
    const rule = this.injector.match({ logicalAddress: laHex, sid: formatCode(sid), subFunction, did });
    if (rule !== null) {
      this.applyFault(conn, rule, testerSa, ecuTa, userData);
      return;
    }

    // ③ 功能寻址（TA=0x1FFF）：网关只回一条 ACK，各 ECU 各自回一条 0x8001
    if (ecuTa === DOIP_DEFAULTS.FUNCTIONAL_ADDRESS) {
      this.sendAck(conn, testerSa, ecuTa, 0x00, userData);
      for (const ecu of this.ecus.values()) {
        const sidHex = formatCode(sid);
        // 不支持该服务的 ECU 在功能寻址下静默（ISO 14229 约定）
        if (!ecu.config.supportedSids.some((s) => s.toUpperCase() === sidHex.toUpperCase())) continue;
        const r = ecu.handleUds(userData);
        if (r.kind === 'ignore') continue;
        const out = r.kind === 'response' ? r.userData : Uint8Array.from([0x7f, sid, r.nrc]);
        this.sendDiagnostic(conn, ecu.logicalAddress, testerSa, out);
      }
      this.emit({
        kind: 'diagnostic',
        connId: conn.id,
        sa: testerSa,
        ta: ecuTa,
        hex: formatCode(sid),
        outcome: 'functional-broadcast',
      });
      return;
    }

    // ④ 目标地址未知
    const ecu = this.ecus.get(laHex);
    if (ecu === undefined) {
      this.sendNack(conn, testerSa, ecuTa, NACK_UNKNOWN_TARGET_ADDRESS, userData);
      return;
    }

    // ⑤ 正常路径：先 ACK（网关已收下），UDS 响应可带 ECU 处理延迟
    const result = ecu.handleUds(userData);
    this.sendAck(conn, testerSa, ecuTa, 0x00, userData);
    if (result.kind === 'ignore') {
      this.emit({ kind: 'diagnostic', connId: conn.id, sa: testerSa, ta: ecuTa, hex: '', outcome: 'suppressed' });
      return;
    }
    const sendResponse = (): void => {
      if (result.kind === 'response') {
        this.sendDiagnostic(conn, ecuTa, testerSa, result.userData);
        this.emit({
          kind: 'diagnostic',
          connId: conn.id,
          sa: testerSa,
          ta: ecuTa,
          hex: formatCode(result.userData[0] ?? 0),
          outcome: 'positive',
        });
        return;
      }
      this.sendDiagnostic(conn, ecuTa, testerSa, Uint8Array.from([0x7f, sid, result.nrc]));
      this.emit({
        kind: 'diagnostic',
        connId: conn.id,
        sa: testerSa,
        ta: ecuTa,
        hex: `7F ${formatCode(sid)} ${formatCode(result.nrc)}`,
        outcome: `nrc:${formatCode(result.nrc)}`,
      });
    };
    const delayMs = ecu.config.timing.responseDelayMs;
    if (delayMs > 0) {
      this.schedule(conn, sendResponse, delayMs);
    } else {
      sendResponse();
    }
  }

  private applyFault(
    conn: EntityConnection,
    rule: FaultRule,
    testerSa: number,
    ecuTa: number,
    userData: Uint8Array,
  ): void {
    const sid = userData[0] ?? 0;
    const action = rule.action;
    this.emit({ kind: 'fault', connId: conn.id, ruleId: rule.id, action: action.kind });
    switch (action.kind) {
      case 'nack':
        // 不进 UDS 层：直接回 0x8003
        this.sendNack(conn, testerSa, ecuTa, parseCode(action.code), userData);
        break;
      case 'noResponse':
        // ★网关已 ACK 收下并"转发"，但 ECU 不回 → 客户端应判 FAILED_UDS_TIMEOUT（§9.3 步骤 11）
        this.sendAck(conn, testerSa, ecuTa, 0x00, userData);
        break;
      case 'dropConnection':
        this.closeConnection(conn, 'fault:dropConnection');
        break;
      case 'nrc':
        this.sendAck(conn, testerSa, ecuTa, 0x00, userData);
        this.sendDiagnostic(conn, ecuTa, testerSa, Uint8Array.from([0x7f, sid, parseCode(action.code)]));
        break;
      case 'customHex':
        this.sendAck(conn, testerSa, ecuTa, 0x00, userData);
        this.sendDiagnostic(conn, ecuTa, testerSa, parseHex(action.hex));
        break;
      case 'delayMs': {
        // 先给 7F <sid> 78（pending），延迟后再给真实响应 —— 验证客户端 P2* 链路
        this.sendAck(conn, testerSa, ecuTa, 0x00, userData);
        this.sendDiagnostic(conn, ecuTa, testerSa, Uint8Array.from([0x7f, sid, NRC_RESPONSE_PENDING]));
        const ecu = this.ecus.get(formatLogicalAddress(ecuTa));
        this.schedule(conn, () => {
          if (ecu === undefined) return;
          const result = ecu.handleUds(userData);
          if (result.kind === 'response') this.sendDiagnostic(conn, ecuTa, testerSa, result.userData);
          else if (result.kind === 'nrc') {
            this.sendDiagnostic(conn, ecuTa, testerSa, Uint8Array.from([0x7f, sid, result.nrc]));
          }
        }, action.ms);
        break;
      }
      case 'routingCode':
        break;
      default:
        break;
    }
    this.injector.consume(rule);
  }

  /* ─────────────── 写出 ─────────────── */

  private sendAck(
    conn: EntityConnection,
    testerSa: number,
    ecuTa: number,
    ackCode: number,
    previousMessage: Uint8Array,
  ): void {
    const payload: DiagnosticMessageAckPayload = {
      sourceAddress: ecuTa,
      targetAddress: testerSa,
      ackCode,
      previousMessage,
    };
    this.write(
      conn,
      PayloadType.DIAGNOSTIC_MESSAGE_ACK,
      DoipPayloadCodec.encode({
        kind: 'diagnosticMessageAck',
        payloadType: PayloadType.DIAGNOSTIC_MESSAGE_ACK,
        value: payload,
      }),
    );
  }

  private sendNack(
    conn: EntityConnection,
    testerSa: number,
    ecuTa: number,
    nackCode: number,
    previousMessage: Uint8Array,
  ): void {
    const payload: DiagnosticMessageNackPayload = {
      sourceAddress: ecuTa,
      targetAddress: testerSa,
      nackCode,
      previousMessage,
    };
    const desc = describeCode(FALLBACK_DIAGNOSTIC_MESSAGE_NACK_CODES, nackCode);
    this.log.info('仿真回 0x8003 NACK', { connId: conn.id, nackCode: formatCode(nackCode), nameZh: desc.nameZh });
    this.write(
      conn,
      PayloadType.DIAGNOSTIC_MESSAGE_NACK,
      DoipPayloadCodec.encode({
        kind: 'diagnosticMessageNack',
        payloadType: PayloadType.DIAGNOSTIC_MESSAGE_NACK,
        value: payload,
      }),
    );
  }

  private sendDiagnostic(conn: EntityConnection, sourceAddress: number, targetAddress: number, userData: Uint8Array): void {
    this.write(
      conn,
      PayloadType.DIAGNOSTIC_MESSAGE,
      DoipPayloadCodec.encode({
        kind: 'diagnosticMessage',
        payloadType: PayloadType.DIAGNOSTIC_MESSAGE,
        value: { sourceAddress, targetAddress, userData },
      }),
    );
  }

  private write(conn: EntityConnection, payloadType: number, payload: Buffer): void {
    if (conn.socket.destroyed) return;
    const frame = DoipHeaderCodec.buildFrame(this.protocolVersion, payloadType, payload);
    conn.socket.write(frame);
  }

  private schedule(conn: EntityConnection, fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      conn.timers.delete(timer);
      if (conn.socket.destroyed) return;
      fn();
    }, ms);
    conn.timers.add(timer);
  }

  private emit(event: SimEntityEvent): void {
    this.options.onEvent?.(event);
  }
}
