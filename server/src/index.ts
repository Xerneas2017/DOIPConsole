/**
 * 后端引导（§6 T07）：装配各服务 → 起 HTTP/WS → 注册路由 → 信号处理。
 *
 * 装配拓扑（★变更 1 的关键一条）：
 *
 *   DoipSession.onFrame → TraceEntryBuilder → EventBus.publishTrace
 *                                                │
 *                          ┌─────────────────────┴──────────────────┐
 *                          ▼                                        ▼
 *                  TraceStore(store.append)                  BatchFlusher
 *                  RollingFileSink(sink.append)  ← 平级订阅者，WS 背压不影响它
 *                  （两者都是平级订阅者，全量）
 *
 * ★B11：全局 `uncaughtException` / `unhandledRejection` 优雅降级——
 *       上报 `E_IMPL_*` 并保持进程存活，不直接退出（工具挂机时长要求）。
 * ★Q11：HTTP/WS 只绑 127.0.0.1，写死。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BIND_HOST, PORTS, RECORDING } from '@doip/shared';
import type { DoipFrame, SessionStatus } from '@doip/shared';
import { AppError, toAppError } from './errors/AppError';
import { getLogger } from './logging/logger';
import { getFileLogSink } from './logging/fileLog';
import { EventBus } from './bridge/EventBus';
import { BatchFlusher } from './bridge/BatchFlusher';
import { ResyncService } from './bridge/ResyncService';
import { WsServer } from './bridge/WsServer';
import { createStaticHandler } from './bridge/staticFiles';
import { RequestRouter } from './bridge/RequestRouter';
import { ConnectionManager } from './session/ConnectionManager';
import type { DoipSessionFrameContext } from './session/DoipSession';
import { SimEcuRuntime } from './sim/SimEcuRuntime';
import { TraceStore } from './trace/TraceStore';
import { TraceEntryBuilder } from './trace/TraceEntryBuilder';
import { RollingFileSink } from './trace/RollingFileSink';
import { TxnTraceLinker } from './txn/TxnTraceLinker';
import { UdsLibraryStore, findDataDir } from './uds/UdsLibraryStore';
import { UdsDecoder } from './uds/UdsDecoder';
import { UdsRepatcher } from './uds/UdsRepatcher';
import { UdsService } from './uds/UdsService';
import { KeyAlgorithmRegistry } from './uds/algorithms/KeyAlgorithmRegistry';
import { KeyAlgorithmEngine } from './uds/KeyAlgorithmEngine';
import { KeyVectorVerifier } from './uds/KeyVectorVerifier';
import { SecurityAccessFlow } from './uds/SecurityAccessFlow';
import type { KeyVectorsFile } from '@doip/shared';

export const SERVER_VERSION = '0.2.0';

export interface AppOptions {
  port?: number;
  /** 关闭自动录盘（测试用） */
  autoRecord?: boolean;
  /** 落盘根目录覆盖（测试用） */
  recordRootDir?: string;
  /** 服务库内置基线路径覆盖（测试用） */
  libraryBuiltinPath?: string;
  /** 服务库用户覆盖文件路径（测试用，指向临时目录避免污染仓库） */
  libraryUserPath?: string;
  /** 关闭服务库文件监听（测试用） */
  libraryWatch?: boolean;
}

export interface App {
  bus: EventBus;
  store: TraceStore;
  sink: RollingFileSink;
  connections: ConnectionManager;
  sim: SimEcuRuntime;
  router: RequestRouter;
  ws: WsServer;
  flusher: BatchFlusher;
  library: UdsLibraryStore;
  registry: KeyAlgorithmRegistry;
  security: SecurityAccessFlow;
  port: number;
  url: string;
  stop: () => Promise<void>;
}

const log = getLogger('bootstrap');

/** 装配全部服务（不启动监听；便于单测直接调用） */
export async function bootstrap(options: AppOptions = {}): Promise<App> {
  const bus = new EventBus();
  const store = new TraceStore();
  const sim = new SimEcuRuntime();
  /** WS 实例后置赋值（落盘状态与补齐都要广播）；非 null 断言由 bootstrap 顺序保证 */
  let ws: WsServer | null = null;

  /* ── 服务库 / 解码器 / Key 算法（T12 + T14） ── */
  const library = new UdsLibraryStore({
    ...(options.libraryBuiltinPath === undefined ? {} : { builtinPath: options.libraryBuiltinPath }),
    ...(options.libraryUserPath === undefined ? {} : { userPath: options.libraryUserPath }),
    watch: options.libraryWatch ?? false,
    onReload: () => {
      // ★P0-10 验收 ②：热更新后对最近 N 条 repatch 并推送
      const changed = repatcher.repatch(store.all());
      if (changed.length > 0) ws?.broadcast('trace.repatch', { entries: changed });
      ws?.broadcast('library.snapshot', library.get());
    },
  });
  const decoder = new UdsDecoder(library);
  const repatcher = new UdsRepatcher(library, decoder);
  const builder = new TraceEntryBuilder(Date.now(), { decoder, store: library });

  const registry = new KeyAlgorithmRegistry();
  const engine = new KeyAlgorithmEngine(registry);
  const vectorsPath = join(findDataDir(), 'key-algo-vectors.json');
  let vectors: KeyVectorsFile = KeyVectorVerifier.load(vectorsPath);
  const reports = registry.verifyAll(vectors.bindings, KeyVectorVerifier.reporter(vectors));
  for (const report of reports) {
    if (report.total === 0 || report.failed > 0) {
      log.warn('Key 算法未通过向量校验（不阻止启动）', {
        algorithmId: report.algorithmId,
        total: report.total,
        failed: report.failed,
      });
      bus.publishError(new AppError('E_LIB_KEY_ALGO_UNVERIFIED', undefined, {
        detail: { algorithmId: report.algorithmId, total: report.total, failed: report.failed },
      }).toWsError());
    }
  }

  /* ── 落盘：EventBus 的平级订阅者（★绝不经 BatchFlusher） ── */
  const sink = new RollingFileSink({
    ...(options.recordRootDir === undefined ? {} : { rootDir: options.recordRootDir }),
    onStatus: (status) => ws?.broadcast('trace.logfile', status),
    onError: (err) => bus.publishError(err.toWsError()),
  });
  bus.subscribeEntries((entry) => {
    store.append(entry);
  });
  bus.subscribeEntries((entry) => {
    sink.append(entry);
  });

  /* ── ★D-02：事务结果 → Trace 回填（耗时 / 配对 / 角色） ── */
  const txnLinker = new TxnTraceLinker({
    store,
    publish: (entries) => bus.publishRepatch(entries),
  });

  /* ── 会话层：每帧 → TraceEntry → EventBus ── */
  const connections = new ConnectionManager({
    seqSource: { next: () => bus.nextSeq() },
    onFrame: (frame: DoipFrame, ctx: DoipSessionFrameContext): number => {
      const entry = builder.build(frame, ctx);
      /**
       * ★标签只认"发送方主动标注"的（`SendUdsRequest.tag`）。
       * 旧实现按 `uds.serviceId === 0x3e` 一刀切，于是**手动发一条 3E 00 也被算作"周期 3E"**，
       * 与"周期发送行打 tag"的语义不符，导出时还会被"隐藏周期 TesterPresent"误过滤掉。
       */
      if (ctx.tag !== undefined && ctx.tag !== null && ctx.tag !== '') entry.tags.push(ctx.tag);
      // ★返回 EventBus 分配的 seq，回传给会话层（事务记录引用真实条目）
      return bus.publishTrace(entry).seq;
    },
    onStatus: (status: SessionStatus) => bus.publishStatus(status),
    onError: (err: AppError) => bus.publishError(err.toWsError()),
    // ★事务推进（ACK / UDS 响应 / 超时 / NACK）→ 回填已有 Trace 条目
    onTxnEvent: (event) => txnLinker.handle(event),
  });

  /* ── UDS 服务与 0x27 解锁（★P0-06 唯一入口） ── */
  const udsService = new UdsService(connections);
  const security = new SecurityAccessFlow({
    uds: udsService,
    registry,
    engine,
    library,
    getVectors: () => vectors,
  });

  const resync = new ResyncService({
    store,
    send: (type, payload) => ws?.broadcast(type, payload),
    getStatus: () => connections.statusOf(),
  });

  /* ── WS 桥接 ── */
  const flusher = new BatchFlusher({
    getBufferedAmount: () => (ws === null ? 0 : ws.bufferedAmount),
    send: (envelope) => {
      if (ws === null) return;
      ws.broadcast(envelope.type, envelope.payload);
    },
    onGap: (gap) => ws?.broadcast('trace.gap', gap),
  });
  bus.setStreamSink((event) => flusher.enqueue(event));

  const router = new RequestRouter({
    bus,
    store,
    connections,
    sim,
    sink,
    resync,
    library,
    registry,
    engine,
    security,
    uds: udsService,
    serverVersion: SERVER_VERSION,
    broadcast: (type, payload) => ws?.broadcast(type, payload),
    getStatus: () => connections.statusOf(),
    getVectors: () => vectors,
    onLibraryChanged: (nextVectors) => {
      vectors = nextVectors;
      const reps = registry.verifyAll(vectors.bindings, KeyVectorVerifier.reporter(vectors));
      for (const rep of reps) {
        if (rep.total === 0 || rep.failed > 0) {
          bus.publishError(new AppError('E_LIB_KEY_ALGO_UNVERIFIED', undefined, {
            detail: { algorithmId: rep.algorithmId, total: rep.total, failed: rep.failed },
          }).toWsError());
        }
      }
    },
  });

  ws = new WsServer({
    ...(options.port === undefined ? {} : { port: options.port }),
    onMessage: (text, send) => router.handle(text, send),
    onHttpRequest: (req: IncomingMessage, res: ServerResponse) => handleHttp(router, req, res),
  });

  const port = await ws.start();

  if (options.autoRecord !== false && RECORDING.AUTO_START) {
    await sink.start({ meta: { toolVersion: SERVER_VERSION } });
    log.info('自动录盘已开启', { dir: sink.getStatus().sessionDir });
  }

  const app: App = {
    bus,
    store,
    sink,
    connections,
    sim,
    router,
    ws,
    flusher,
    library,
    registry,
    security,
    port,
    url: `http://${BIND_HOST}:${port}`,
    stop: async () => {
      flusher.dispose();
      connections.dispose();
      library.dispose();
      await sim.stop();
      await sink.stop();
      sink.dispose();
      await ws?.stop();
      // 运行日志收尾：把攒批缓冲刷盘，否则最后几行（往往正是崩因）会丢
      await getFileLogSink().dispose();
      log.info('后端已停止', { port });
    },
  };
  return app;
}

/**
 * 前端产物目录（`web/dist`）。
 *
 * ★让后端「单进程、单端口」提供界面：`npm run build` 之后直接开
 *   http://127.0.0.1:8787 即可，不必再并行起 Vite、也不存在代理指错后端的问题。
 * `DOIP_WEB_DIST` 可覆盖（测试用临时目录，或自定义部署）。
 */
const STATIC_ROOT =
  process.env['DOIP_WEB_DIST'] ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
const serveStatic = createStaticHandler(STATIC_ROOT);

/** 极简 HTTP：健康检查 + 导出下载 + 前端静态资源（刻意不引入 express/fastify，§7.2） */
function handleHttp(router: RequestRouter, req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? '/';
  if (url === '/api/health') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true, version: SERVER_VERSION, bindHost: BIND_HOST }));
    return true;
  }
  const match = /^\/api\/download\/([A-Za-z0-9_-]+)$/.exec(url);
  if (match !== null) {
    const id = match[1] ?? '';
    const item = router.getDownload(id);
    if (item === undefined) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not-found' }));
      return true;
    }
    res.setHeader('content-type', item.mime);
    res.setHeader('content-disposition', `attachment; filename="${item.filename}"`);
    res.end(item.buffer);
    return true;
  }
  // 其余交给静态托管（内含 SPA 回退；/api/* 已被上面拦住不会被吞）
  if (serveStatic(req, res)) return true;
  return false;
}

/** ★B11：全局异常兜底——上报后继续存活，绝不直接退出 */
export function installGlobalHandlers(bus: EventBus | null = null): void {
  process.on('uncaughtException', (err: Error) => {
    const appErr = toAppError(err, 'E_IMPL_UNEXPECTED');
    getLogger('process').error('未捕获异常（进程继续存活）', {
      code: appErr.code,
      message: appErr.message,
      stack: err.stack ?? null,
    });
    bus?.publishError(appErr.toWsError());
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const appErr = toAppError(reason, 'E_IMPL_UNEXPECTED');
    getLogger('process').error('未处理的 Promise 拒绝（进程继续存活）', {
      code: appErr.code,
      message: appErr.message,
    });
    bus?.publishError(appErr.toWsError());
  });
}

async function main(): Promise<void> {
  installGlobalHandlers();
  const app = await bootstrap({ port: PORTS.BACKEND_HTTP });
  const logDir = getFileLogSink().getStatus().dir;
  const webReady = existsSync(join(STATIC_ROOT, 'index.html'));
  log.info('DoIP 诊断控制台后端已就绪', {
    url: app.url,
    ws: `ws://${BIND_HOST}:${app.port}`,
    recording: app.sink.getStatus().state,
    logDir,
    webUi: webReady ? '已托管' : '未构建',
  });
  console.log(`后端已启动：${app.url}  （WS: ws://${BIND_HOST}:${app.port}）`);
  console.log(`界面地址：${webReady ? app.url : '未构建，先执行 npm run build'}`);
  console.log(`运行日志：${logDir}`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('收到退出信号，开始优雅关闭', { signal });
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

const isDirectRun = process.argv[1] !== undefined && /(^|[\\/])index\.ts$/.test(process.argv[1]);
if (isDirectRun) {
  void main();
}
