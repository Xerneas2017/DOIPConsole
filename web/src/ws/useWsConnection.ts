import type {
  ClientCommand,
  KeyAlgorithmDescriptor,
  KeyTestVector,
  LogFileStatus,
  ServerEvent,
  StreamEvent,
  TraceEntry,
  UnlockResult,
  WsError,
} from '@doip/shared';
import { WsClient, defaultWsUrl } from './WsClient';
import type { WsClientStatus } from './WsClient';
import { useConnectionStore } from '../store/useConnectionStore';
import { useTraceStore } from '../store/useTraceStore';
import { useLibraryStore } from '../store/useLibraryStore';
import type { LibraryValidationIssue } from '../store/useLibraryStore';
import { useUiStore } from '../store/useUiStore';

/**
 * WS 单例与 React 绑定（T09）。
 *
 * 单例在模块加载时创建（不自动连接），由 `useWsConnection()` 在首个组件挂载时 `connect()`。
 * 事件路由在这里集中：后端事件 → 各 store，组件只读 store，不直接碰 socket。
 */

let client: WsClient | null = null;

function ensureClient(): WsClient {
  if (client !== null) return client;

  const conn = useConnectionStore.getState();
  const trace = useTraceStore.getState();

  client = new WsClient({
    url: defaultWsUrl(),
    onStatus: (status: WsClientStatus, detail?: string) => {
      const store = useConnectionStore.getState();
      // ★裁定①：断线归因（detail）随状态一起入 store，UI 必须能看见"为什么断、是否在自动重连"
      store.setWsStatus(status, detail ?? null);
      // ★D-03：断开/重连中 → 上一轮的连接状态、路由激活码、会话、解锁等级、
      //   仿真运行状态、录盘状态全部作废，UI 必须显示"未知"而不是陈旧的"已激活"。
      if (status === 'closed' || status === 'reconnecting') {
        store.markStale();
        if (status === 'closed' && detail !== undefined) {
          store.pushError({ code: 'E_WS_CLOSED', messageZh: detail, severity: 'warn' });
        }
      }
    },
    onError: (message: string) => {
      useConnectionStore.getState().pushError({
        code: 'E_WS_CONNECTION',
        messageZh: message,
        severity: 'warn',
      });
    },
    onEvent: (event: ServerEvent) => routeServerEvent(event),
    onStream: (event: StreamEvent) => routeStreamEvent(event),
  });

  client.setLastSeqProvider(() => useTraceStore.getState().lastSeq);
  // 首连时把当前 store 快照给客户端（避免闭包过期）
  void conn;
  void trace;
  return client;
}

/** 服务端事件 → store */
function routeServerEvent(event: ServerEvent): void {
  const conn = useConnectionStore.getState();
  const trace = useTraceStore.getState();

  switch (event.type) {
    case 'hello': {
      const p = event.payload as {
        serverVersion: string;
        seqNow: number;
        traceMinSeq: number;
        traceMaxSeq: number;
      };
      conn.setServerVersion(p.serverVersion);
      break;
    }
    case 'status':
      conn.setStatus(event.payload as never);
      break;
    case 'scan.result': {
      const p = event.payload as { entities: never[]; partial: boolean };
      conn.setEntities(p.entities as never);
      conn.setScanning(false);
      break;
    }
    case 'sim.status':
      conn.setSim(event.payload as never);
      break;
    case 'aliveCheck.result': {
      const p = event.payload as { sourceAddress: number; latencyMs: number };
      conn.setAliveCheck(p);
      break;
    }
    case 'entityStatus.result': {
      conn.setEntityStatus(event.payload as never);
      break;
    }
    case 'powerMode.result': {
      conn.setPowerMode(event.payload as never);
      break;
    }
    case 'trace.logfile':
      conn.setRecording(event.payload as never);
      break;
    case 'trace.gap': {
      const p = event.payload as { fromSeq: number; toSeq: number; count: number; reason: 'backpressure' | 'overflow' };
      // ★后端显式告知的缺口（背压/溢出）→ 插入灰条，seq 链条不断
      trace.addGap({ fromSeq: p.fromSeq, toSeq: p.toSeq, count: p.count, reason: p.reason });
      break;
    }
    case 'trace.repatch': {
      const p = event.payload as { entries: TraceEntry[] };
      // ★库热更新：这些条目已存在，必须按 seq 就地替换（ingest 会因去重而跳过）
      trace.applyRepatch(p.entries);
      break;
    }
    case 'library.snapshot':
      useLibraryStore.getState().setLibrary(event.payload as never);
      break;
    case 'library.rejected': {
      const p = event.payload as { issues: LibraryValidationIssue[] };
      useLibraryStore.getState().setIssues(p.issues);
      conn.pushError({
        code: 'E_LIB_INVALID_JSON',
        messageZh: `服务库有 ${p.issues.length} 处问题，已拒绝入库`,
        severity: 'error',
        detail: p.issues,
      });
      break;
    }
    case 'library.algorithms': {
      const p = event.payload as {
        algorithms: KeyAlgorithmDescriptor[];
        recommendedId?: string | null;
        vectors: KeyTestVector[];
      };
      useLibraryStore.getState().setAlgorithms(p.algorithms, p.vectors, p.recommendedId ?? null);
      break;
    }
    case 'keyAlgo.trial':
      useLibraryStore.getState().setTrial(event.payload as never);
      break;
    case 'security.unlocked': {
      const p = event.payload as UnlockResult;
      useLibraryStore.getState().setUnlock(p);
      if (!p.ok) {
        conn.pushError({
          code: p.errorCode ?? 'E_SEC_INVALID_KEY',
          messageZh: p.note ?? '解锁失败',
          severity: 'error',
        });
      }
      break;
    }
    case 'uds.result': {
      const p = event.payload as { ok: boolean; responseHex?: string; note?: string };
      conn.setLastResult({ ok: p.ok, hex: p.responseHex ?? '', note: p.note ?? '' });
      break;
    }
    case 'export.ready': {
      // ★T15：导出完成后由浏览器直接下载（同源 /api 代理，Q11 后端只绑 127.0.0.1）
      const p = event.payload as { downloadUrl: string; filename: string; bytes: number };
      const a = document.createElement('a');
      a.href = p.downloadUrl;
      a.download = p.filename;
      document.body.append(a);
      a.click();
      a.remove();
      conn.pushError({
        code: 'E_IO_EXPORT_OK',
        messageZh: `导出完成：${p.filename}（${(p.bytes / 1024).toFixed(1)} KB），已开始下载`,
        severity: 'info',
      });
      break;
    }
    case 'log.info': {
      // 后端运行日志（自我排查）：status 必带，lines 仅在 log.tail 时才有
      const p = event.payload as { status: LogFileStatus; lines?: string[]; truncated?: boolean };
      useUiStore.getState().setLogData(p.status, p.lines, p.truncated);
      break;
    }
    case 'error':
      conn.pushError(event.payload as WsError);
      break;
    default:
      break;
  }
}

/** 流事件（trace.entry / status / error）→ store */
function routeStreamEvent(event: StreamEvent): void {
  const trace = useTraceStore.getState();
  const conn = useConnectionStore.getState();
  switch (event.kind) {
    case 'trace.entry':
      trace.ingest([event.entry]);
      break;
    case 'trace.repatch':
      // ★D-02：事务字段回填（耗时/配对/角色）走同一条队列，保证"先条目后回填"的顺序
      trace.applyRepatch(event.entries);
      break;
    case 'status':
      conn.setStatus(event.status);
      break;
    case 'error':
      conn.pushError(event.error);
      break;
    default:
      break;
  }
}

/** 取单例（不会自动连接） */
export function getWsClient(): WsClient {
  return ensureClient();
}

/**
 * 发送指令（组件侧唯一出口）。
 * 泛型保证 payload 与 type 匹配；WsClient 内部按信封统一序列化。
 */
export function sendCommand<T extends ClientCommand['type']>(
  type: T,
  payload: Extract<ClientCommand, { type: T }>['payload'],
): string {
  return getWsClient().sendCommand(type, payload as unknown);
}

export type { WsClientStatus };
