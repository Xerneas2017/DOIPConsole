/**
 * 请求路由（§3.12）：前端指令 → 各服务；统一 `cmd.ack` / `error` / 结果事件。
 *
 * ★所有后端→前端的出口都经 EventBus（§8.8），本类不直接持有 ws 实例。
 * ★未实现的能力（服务库编辑 T12、0x27 解锁 T14）显式回 `E_IMPL_NOT_IMPLEMENTED`，
 *   绝不静默吞掉指令——否则前端会一直等一个永远不会来的 ack。
 */

import {
  BIND_HOST,
  LIMITS,
  LOGGING,
  PORTS,
  formatHex,
  parseClientCommand,
  parseLogicalAddress,
} from '@doip/shared';
import type {
  ClientCommand,
  ExportRequest,
  FaultRule,
  KeyAlgorithmDescriptor,
  KeyTrialResult,
  KeyVectorsFile,
  SendUdsResult,
  SessionStatus,
  SimStatus,
  UnlockResult,
  WsError,
  RecordingConfigOverrides,
} from '@doip/shared';
import { AppError, errorToWsError, toAppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getFileLogSink } from '../logging/fileLog';
import type { FileLogSink } from '../logging/fileLog';
import { getTiming } from '../config/defaults';
import { DoipUdpDiscovery } from '../doip/DoipUdpDiscovery';
import type { ConnectionManager } from '../session/ConnectionManager';
import { SIM_KEY_ALGORITHM_ID } from '../sim/simPresets';
import type { SimEcuRuntime } from '../sim/SimEcuRuntime';
import type { TraceStore } from '../trace/TraceStore';
import type { RollingFileSink } from '../trace/RollingFileSink';
import { runExport } from '../trace/exporters';
import type { UdsLibraryStore } from '../uds/UdsLibraryStore';
import type { KeyAlgorithmRegistry } from '../uds/algorithms/KeyAlgorithmRegistry';
import type { KeyAlgorithmEngine } from '../uds/KeyAlgorithmEngine';
import type { SecurityAccessFlow } from '../uds/SecurityAccessFlow';
import { UdsEncoder } from '../uds/UdsEncoder';
import type { UdsService } from '../uds/UdsService';
import type { EventBus } from './EventBus';
import type { ResyncService } from './ResyncService';
import type { SendFn } from './WsServer';

export interface DownloadItem {
  buffer: Buffer;
  filename: string;
  mime: string;
  atMs: number;
}

export interface RequestRouterDeps {
  bus: EventBus;
  store: TraceStore;
  connections: ConnectionManager;
  sim: SimEcuRuntime;
  sink: RollingFileSink;
  resync: ResyncService;
  /** T12：服务库（可编辑 + 热更新 repatch） */
  library: UdsLibraryStore;
  /** T14：移植算法注册表 / 执行器 / 解锁流程 */
  registry: KeyAlgorithmRegistry;
  engine: KeyAlgorithmEngine;
  security: SecurityAccessFlow;
  /** ★P0-06：UDS 发送的唯一入口（B 区表单 / 原始 hex / 周期发送 / 0x27 都走它） */
  uds: UdsService;
  serverVersion: string;
  /** 运行日志落文件（自我排查）；不传则用进程单例 */
  logSink?: FileLogSink;
  /** 广播一条服务端事件（非补齐路径） */
  broadcast: (type: string, payload: unknown) => void;
  getStatus: () => SessionStatus | null;
  /** 当前测试向量文件（试算同屏对照） */
  getVectors: () => KeyVectorsFile;
  /** 库/向量文件被外部改动后的回调（重跑向量校验） */
  onLibraryChanged?: (vectors: KeyVectorsFile) => void;
}

const DOWNLOAD_KEEP_MAX = 20;

export class RequestRouter {
  private readonly log = getLogger('bridge.router');
  private readonly deps: RequestRouterDeps;
  private readonly downloads = new Map<string, DownloadItem>();

  constructor(deps: RequestRouterDeps) {
    this.deps = deps;
  }

  /** 取下载项（HTTP `/api/download/:id` 用） */
  getDownload(id: string): DownloadItem | undefined {
    return this.downloads.get(id);
  }

  /** 处理一条前端指令（已是 JSON 字符串） */
  handle(text: string, send: SendFn): void {
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      this.replyError(send, null, new AppError('E_WS_BAD_MESSAGE', '收到非 JSON 的 WebSocket 消息'));
      return;
    }
    const cmd = parseClientCommand(raw);
    if (cmd === null) {
      this.replyError(send, null, new AppError('E_WS_BAD_MESSAGE', 'WebSocket 消息缺少 type/id/payload'));
      return;
    }
    void this.dispatch(cmd, send);
  }

  /* ─────────────── 分发 ─────────────── */

  private async dispatch(cmd: ClientCommand, send: SendFn): Promise<void> {
    try {
      switch (cmd.type) {
        case 'ping':
          // ★应用层心跳：浏览器对协议层 ping 的自动 pong 应用层不可见，
          //   前端判活只能靠这条回包；必须原样回 t，绝不走 E_WS_BAD_MESSAGE。
          send('pong', { t: (cmd.payload as { t?: number }).t ?? Date.now() });
          break;
        case 'session.hello':
          this.onHello(cmd.payload.lastSeq, send);
          break;
        case 'scan.request':
          await this.onScan(cmd.payload, send, cmd.id);
          break;
        case 'connect.request':
          await this.onConnect(cmd.payload, send, cmd.id);
          break;
        case 'disconnect':
          await this.deps.connections.disconnect(cmd.payload.reason ?? 'user-disconnect');
          this.ack(send, cmd.id, true);
          break;
        case 'routing.reactivate':
          await this.deps.connections.reactivate();
          this.ack(send, cmd.id, true);
          break;
        case 'target.set':
          this.deps.connections.setTargetAddress(parseLogicalAddress(cmd.payload.ta));
          this.ack(send, cmd.id, true);
          break;
        case 'uds.send':
          await this.onUdsSend(cmd.payload, send, cmd.id);
          break;
        case 'testerPresent':
          this.deps.connections.setTesterPresent(cmd.payload.enable, cmd.payload.periodMs);
          this.ack(send, cmd.id, true);
          break;
        case 'sim.start':
          await this.onSimStart(cmd.payload, send, cmd.id);
          break;
        case 'sim.stop':
          await this.deps.sim.stop();
          this.broadcastSimStatus();
          this.ack(send, cmd.id, true);
          break;
        case 'sim.injectFault':
          this.deps.sim.setFaultRules(cmd.payload.rules as FaultRule[]);
          this.broadcastSimStatus();
          this.ack(send, cmd.id, true);
          break;
        case 'trace.resync':
          this.deps.resync.handleHello(cmd.payload.fromSeq);
          this.ack(send, cmd.id, true);
          break;
        case 'trace.clear':
          this.deps.store.clear();
          this.ack(send, cmd.id, true);
          break;
        case 'record.start':
          await this.onRecordStart(cmd.payload, send, cmd.id);
          break;
        case 'record.stop':
          await this.deps.sink.stop();
          this.pushLogFile();
          this.ack(send, cmd.id, true);
          break;
        case 'record.status':
          send('trace.logfile', this.deps.sink.getStatus());
          this.ack(send, cmd.id, true);
          break;
        case 'record.openDir':
          this.onRecordOpenDir(cmd.payload, send, cmd.id);
          break;
        case 'export.request':
          this.onExport(cmd.payload, send, cmd.id);
          break;
        case 'security.unlock':
          await this.onSecurityUnlock(cmd.payload, send, cmd.id);
          break;
        case 'library.get':
          send('library.snapshot', this.deps.library.get());
          this.ack(send, cmd.id, true);
          break;
        case 'library.update':
          this.onLibraryUpdate(cmd.payload, send, cmd.id);
          break;
        case 'library.reset':
          this.deps.library.resetBuiltin();
          this.broadcastLibrary();
          this.ack(send, cmd.id, true);
          break;
        case 'keyAlgo.list':
          this.onKeyAlgoList(cmd.payload, send, cmd.id);
          break;
        case 'keyAlgo.trial':
          this.onKeyAlgoTrial(cmd.payload, send, cmd.id);
          break;
        case 'log.status':
          send('log.info', { status: this.logSink().getStatus() });
          this.ack(send, cmd.id, true);
          break;
        case 'log.tail':
          await this.onLogTail(cmd.payload, send, cmd.id);
          break;
        case 'log.openDir':
          this.onLogOpenDir(cmd.payload, send, cmd.id);
          break;
        default: {
          // 未知的指令类型：判别联合已被穷尽，此处用宽松视图取 type/id 做提示
          const unknownCmd = cmd as { type?: string; id?: string };
          this.replyError(
            send,
            unknownCmd.id ?? null,
            new AppError('E_WS_BAD_MESSAGE', `未知的指令类型：${String(unknownCmd.type)}`),
          );
          break;
        }
      }
    } catch (err) {
      const appErr = err instanceof AppError ? err : toAppError(err, 'E_IMPL_UNEXPECTED');
      this.replyError(send, cmd.id, appErr);
    }
  }

  /* ─────────────── 各指令实现 ─────────────── */

  private onHello(lastSeq: number, send: SendFn): void {
    send('hello', {
      serverVersion: this.deps.serverVersion,
      seqNow: this.deps.bus.seqNow,
      traceMinSeq: this.deps.store.minSeq,
      traceMaxSeq: this.deps.store.maxSeq,
    });
    this.deps.resync.handleHello(lastSeq);
    this.log.info('前端已连接并完成补齐', { lastSeq, seqNow: this.deps.bus.seqNow });
  }

  private async onScan(
    payload: { targetIp?: string; timeoutMs?: number; passive?: boolean; port?: number },
    send: SendFn,
    id: string,
  ): Promise<void> {
    const discovery = new DoipUdpDiscovery({
      port: payload.port ?? PORTS.SIM_DEFAULT_TCP_UDP,
    });
    try {
      const result = await discovery.scan({
        ...(payload.targetIp === undefined ? {} : { targetIp: payload.targetIp }),
        ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
        ...(payload.passive === undefined ? {} : { passive: payload.passive }),
      });
      send('scan.result', { entities: result.entities, partial: result.partial });
      this.ack(send, id, true);
    } finally {
      discovery.stopPassiveListen();
      discovery.cancelPending();
    }
  }

  private async onConnect(
    payload: Parameters<ConnectionManager['connect']>[0],
    send: SendFn,
    id: string,
  ): Promise<void> {
    // ★先记下"连接意图 + 仿真实际状态"：排查 ECONNREFUSED 时这两组值必须能对上
    const sim = this.deps.sim.getStatus();
    this.log.info('收到连接请求', {
      mode: payload.mode,
      host: payload.host,
      port: payload.port,
      sa: payload.sa,
      ta: payload.ta,
      simRunning: sim.running,
      simPort: sim.port,
    });
    try {
      const status = await this.deps.connections.connect(payload);
      this.deps.bus.publishStatus(status);
      this.log.info('连接成功', {
        state: status.state,
        sessionId: status.sessionId,
        target: `${payload.host}:${payload.port}`,
      });
      this.ack(send, id, true);
    } catch (err) {
      const appErr = err instanceof AppError ? err : toAppError(err, 'E_CONN_REFUSED');
      this.logConnectFailure(payload, appErr, sim);
      throw appErr;
    }
  }

  /**
   * 连接失败诊断（自我排查的关键一环）。
   *
   * 把"界面填的目标"与"仿真实际状态"摆在一起，直接给出可执行结论，
   * 而不是只丢一句 `ECONNREFUSED`。日志同时进终端与 `~/.doip-console/logs/`。
   */
  private logConnectFailure(
    payload: Parameters<ConnectionManager['connect']>[0],
    appErr: AppError,
    sim: SimStatus,
  ): void {
    let diagnosis = '目标未在该地址/端口监听：请确认 ECU 的 DoIP 服务已启动、IP 与端口正确';
    if (payload.mode === 'sim') {
      if (!sim.running) {
        diagnosis = '仿真 ECU 尚未启动：请先在左侧点【启动仿真 ECU】，再点【连接】';
      } else if (sim.port !== null && sim.port !== payload.port) {
        diagnosis = `端口不一致：界面目标端口 ${payload.port}，但仿真 ECU 实际监听 ${sim.port}。请把目标端口改为 ${sim.port}`;
      } else {
        diagnosis = '仿真 ECU 已启动且端口一致，但连接仍失败：请查看日志中仿真侧最近的报错';
      }
    } else if (appErr.code === 'E_CONN_TIMEOUT') {
      diagnosis = '连接超时：目标可能不在同一网段、被防火墙拦截，或 DoIP 服务未就绪';
    } else if (appErr.code === 'E_CONN_HOST_UNREACH') {
      diagnosis = '主机不可达：请检查本机网卡是否与目标同网段、路由是否正确';
    }
    this.log.error('连接失败', {
      code: appErr.code,
      message: appErr.message,
      target: `${payload.host}:${payload.port}`,
      mode: payload.mode,
      simRunning: sim.running,
      simPort: sim.port,
      diagnosis,
    });
  }

  private async onUdsSend(
    payload: Parameters<ConnectionManager['sendUds']>[0],
    send: SendFn,
    id: string,
  ): Promise<void> {
    // ★P0-06：唯一入口，绝不绕过 UdsService 直连 ConnectionManager
    const result: SendUdsResult = await this.deps.uds.sendUdsRequest(payload);
    send('uds.result', result);
    if (!result.ok && result.errorCode !== undefined && result.errorCode !== null) {
      this.deps.bus.publishError(new AppError(result.errorCode, result.note).toWsError());
    }
    // ★D-06：指令必须有 ack，且 id 回显真实请求 id（前端靠它对账，否则一直挂着等）
    this.ack(send, id, result.ok, { txnId: result.txnId, state: result.state });
  }

  private async onSimStart(
    payload: { entities?: unknown; port?: number },
    send: SendFn,
    id: string,
  ): Promise<void> {
    const started = await this.deps.sim.start({
      ...(payload.port === undefined ? {} : { port: payload.port }),
    });
    this.broadcastSimStatus();
    send('sim.status', this.simStatus());
    this.ack(send, id, true, { port: started.port });
  }

  private async onRecordStart(
    payload: { sessionDir?: string; overrides?: unknown },
    send: SendFn,
    id: string,
  ): Promise<void> {
    const status = await this.deps.sink.start({
      ...(payload.sessionDir === undefined ? {} : { sessionDir: payload.sessionDir }),
      ...(payload.overrides === undefined
        ? {}
        : { overrides: payload.overrides as RecordingConfigOverrides }),
    });
    send('trace.logfile', status);
    this.ack(send, id, true);
  }

  private onRecordOpenDir(payload: { dir?: string }, send: SendFn, id: string): void {
    const result = this.deps.sink.openDir(payload.dir);
    if (!result.ok) {
      this.replyError(send, id, new AppError('E_IO_EXPORT_FAILED', '打开落盘目录失败'));
      return;
    }
    this.ack(send, id, true, { dir: result.dir });
  }

  /* ─────────────── 后端运行日志（自我排查） ─────────────── */

  private logSink(): FileLogSink {
    return this.deps.logSink ?? getFileLogSink();
  }

  /**
   * 回日志尾部。
   *
   * ★这里刻意**先 flush 再读**（在 FileLogSink.tail 内完成）：否则用户看到的
   *   "最后几行"会缺掉刚发生、还在攒批缓冲里的那几条——而那几条通常正是要看的原因。
   */
  private async onLogTail(payload: { lines?: number }, send: SendFn, id: string): Promise<void> {
    const wanted = payload.lines ?? LOGGING.TAIL_DEFAULT_LINES;
    const sink = this.logSink();
    const result = await sink.tail(wanted);
    send('log.info', {
      status: sink.getStatus(),
      lines: result.lines,
      truncated: result.truncated,
    });
    this.ack(send, id, true);
  }

  private onLogOpenDir(payload: { sub?: string }, send: SendFn, id: string): void {
    const result = this.logSink().openDir(payload.sub);
    if (!result.ok) {
      this.replyError(send, id, new AppError('E_IO_EXPORT_FAILED', '打开日志目录失败'));
      return;
    }
    this.ack(send, id, true, { dir: result.dir });
  }

  private onExport(payload: ExportRequest, send: SendFn, id: string): void {
    const entries = this.deps.store.all();
    const result = runExport(entries, payload);
    // ★导出下载句柄 id（与指令 id 是两个东西，别混用——否则 ack 回显会错）
    const downloadId = `exp-${Date.now().toString(36)}`;
    this.downloads.set(downloadId, {
      buffer: result.buffer,
      filename: result.filename,
      mime: result.mime,
      atMs: Date.now(),
    });
    while (this.downloads.size > DOWNLOAD_KEEP_MAX) {
      const oldest = this.downloads.keys().next();
      if (oldest.done === true) break;
      this.downloads.delete(oldest.value);
    }
    send('export.ready', {
      id: downloadId,
      downloadUrl: `/api/download/${downloadId}`,
      filename: result.filename,
      bytes: result.buffer.length,
    });
    this.ack(send, id, true);
    this.log.info('导出完成', { format: payload.format, count: result.count, bytes: result.buffer.length });
  }

  /* ─────────────── 服务库（T12） ─────────────── */

  private onLibraryUpdate(
    payload: { library: unknown },
    send: SendFn,
    id: string,
  ): void {
    const result = this.deps.library.update(payload.library);
    if (!result.ok) {
      // ★绝不静默：把可定位的 issues 原样回给前端
      send('library.rejected', { issues: result.issues });
      this.replyError(
        send,
        id,
        new AppError('E_LIB_INVALID_JSON', '服务库校验未通过，已拒绝入库', {
          detail: { issues: result.issues },
        }),
      );
      return;
    }
    this.broadcastLibrary();
    this.ack(send, id, true, { issues: result.issues });
    this.log.info('服务库已更新', { warnings: result.issues.length });
  }

  private broadcastLibrary(): void {
    this.deps.broadcast('library.snapshot', this.deps.library.get());
    this.deps.onLibraryChanged?.(this.deps.getVectors());
  }

  /* ─────────────── Key 算法（T14） ─────────────── */

  private onKeyAlgoList(payload: { level?: number }, send: SendFn, id: string): void {
    const level = payload.level ?? null;
    const registered = this.deps.registry.listForLevel(level);
    const fromLibrary: KeyAlgorithmDescriptor[] = [];
    // ★库里定义的 constant/expression/javascript 也能解锁（不只是注册表里的 ported）
    for (const spec of this.deps.library.keyAlgorithms()) {
      if (spec.type === 'ported') continue;
      fromLibrary.push({
        id: spec.id,
        nameZh: spec.name,
        appliesToLevels: [],
        seedLengthBytes: null,
        keyLengthBytes: null,
        origin: 'placeholder',
        verified: false,
        provider: spec.type,
        specId: spec.id,
      });
    }
    // ported 类：展示注册表的真实元信息（含 verified / notes）
    for (const spec of this.deps.library.keyAlgorithms()) {
      if (spec.type !== 'ported') continue;
      const inner = this.deps.registry.get(spec.algorithmId);
      if (inner === undefined) continue;
      fromLibrary.push({ ...this.deps.registry.toMeta(inner), provider: 'ported', specId: spec.id });
    }
    // 去重：注册表里的具名算法为准
    const ids = new Set(registered.map((a) => a.id));
    const algorithms = registered.concat(fromLibrary.filter((a) => !ids.has(a.id)));
    // ★QA 终验缺陷 3：默认算法必须由后端指定（前端不得取 list[0]，那会是占位算法）
    const recommendedId = this.recommendedAlgorithmId(algorithms);
    send('library.algorithms', {
      algorithms,
      vectors: this.deps.getVectors().vectors,
      recommendedId,
    });
    this.ack(send, id, true);
  }

  /**
   * 默认算法的选择口径（顺序即优先级）：
   *  ① 仿真在运行 → 仿真 ECU 期望的那一套（否则一键解锁开箱就吃 NRC 0x35）；
   *  ② 否则取第一个 `verified === true` 的移植算法（真实 ECU 场景）；
   *  ③ 都没有 → null（前端退化为"第一个非占位算法"）。
   */
  private recommendedAlgorithmId(
    algorithms: ReadonlyArray<{ id: string; verified: boolean }>,
  ): string | null {
    if (this.simStatus().running) {
      const hit = algorithms.find((a) => a.id === SIM_KEY_ALGORITHM_ID);
      if (hit !== undefined) return hit.id;
    }
    const verified = algorithms.find((a) => a.verified);
    return verified?.id ?? null;
  }

  private onKeyAlgoTrial(
    payload: { algorithmId: string; level: number; seedHex: string },
    send: SendFn,
    id: string,
  ): void {
    const result: KeyTrialResult = this.deps.security.trial(
      payload.algorithmId,
      payload.level,
      payload.seedHex,
    );
    send('keyAlgo.trial', result);
    if (!result.ok && result.errorCode !== null) {
      this.replyError(send, id, new AppError(result.errorCode, result.messageZh ?? undefined));
      return;
    }
    this.ack(send, id, true);
  }

  private async onSecurityUnlock(
    payload: { level: number; keyAlgorithmId?: string; customKeyHex?: string },
    send: SendFn,
    id: string,
  ): Promise<void> {
    const level = payload.level;
    let algorithmId = payload.keyAlgorithmId;
    if (algorithmId === undefined || this.deps.security.resolveId(algorithmId) === null) {
      const fallback = this.deps.registry.listForLevel(level)[0];
      if (fallback === undefined) {
        this.replyError(
          send,
          id,
          new AppError('E_LIB_KEY_ALGO_NOT_FOUND', `安全等级 ${level} 没有可用算法`),
        );
        return;
      }
      algorithmId = fallback.id;
    }
    if (payload.customKeyHex !== undefined && payload.customKeyHex.trim().length > 0) {
      // 自定义密钥直通（不经过算法）
      const subs = UdsEncoder.securitySubFunctions(level);
      const result: SendUdsResult = await this.deps.uds.sendUdsRequest({
        addressing: 'physical',
        rawHex: formatHex(
          UdsEncoder.securityAccessBytes(subs.sendKey, UdsEncoder.tryParseRawHex(payload.customKeyHex) ?? undefined),
        ),
        tag: '0x27自定义密钥',
        // ★#4：security.unlock 命令本身就是用户显式解锁动作，内部放行
        confirmed: true,
      });
      send('uds.result', result);
      this.ack(send, id, result.ok, { txnId: result.txnId, state: result.state });
      return;
    }
    const result: UnlockResult = await this.deps.security.unlock(level, algorithmId);
    send('security.unlocked', result);
    if (!result.ok && result.errorCode !== null) {
      this.deps.bus.publishError(new AppError(result.errorCode, result.note ?? undefined).toWsError());
    }
    this.ack(send, id, result.ok, { level, algorithmId });
  }

  /* ─────────────── 辅助 ─────────────── */

  private simStatus(): SimStatus {
    return this.deps.sim.getStatus();
  }

  private broadcastSimStatus(): void {
    this.deps.broadcast('sim.status', this.simStatus());
  }

  private pushLogFile(): void {
    this.deps.broadcast('trace.logfile', this.deps.sink.getStatus());
  }

  private ack(send: SendFn, id: string, ok: boolean, extra?: Record<string, unknown>): void {
    send('cmd.ack', { id, ok, ...(extra ?? {}) });
  }

  private replyError(send: SendFn, id: string | null, error: AppError): void {
    const wsError: WsError = errorToWsError(error);
    send('error', wsError);
    if (id !== null) send('cmd.ack', { id, ok: false, error: wsError });
    this.log.warn('指令处理失败', { code: error.code, message: error.message });
  }
}

/** 导出超时守卫（§9.4：10 万条 ≤ 10s；这里给命令一个兜底上限） */
export function exportBudgetMs(): number {
  return getTiming('WS_PUSH_FLUSH_INTERVAL_MS') * LIMITS.WS_MAX_ENTRIES_PER_BATCH;
}

/** 默认绑定地址（★Q11：写死，不提供配置项） */
export function defaultBindHost(): string {
  return BIND_HOST;
}

/** 供 UI 展示的地址字符串 */
export function formatTarget(host: string, port: number): string {
  return `${host}:${port}`;
}
