/**
 * 断线重连补齐（§3.12）。
 *
 * - `lastSeq === 0`（首次）→ `library.snapshot` + `status` + 最近 `TRACE_RESYNC_SNAPSHOT_ENTRIES` 条
 * - `lastSeq >= traceMinSeq` → 补齐 `(lastSeq, traceMaxSeq]` 区间（分包发送，每包 500 条）
 * - `lastSeq < traceMinSeq`（环形缓冲已回绕）→ `trace.gap{reason:'overflow'}` + 现有全部条目，
 *   前端提示"后端缓冲已回绕，较早历史不可恢复"
 * - 补齐结束后**强制补发** status 快照（非 trace 事件不可回放，用快照对齐当前状态）
 */

import type { SessionStatus, StreamEvent, TraceEntry, UdsLibrary } from '@doip/shared';
import { getLogger } from '../logging/logger';
import { getLimits } from '../config/defaults';
import type { TraceStore } from '../trace/TraceStore';

export interface ResyncDeps {
  store: TraceStore;
  /** 立即发送一条服务端事件（绕过批量打包，补齐必须即时） */
  send: (type: string, payload: unknown) => void;
  getStatus: () => SessionStatus | null;
  getLibrary?: () => UdsLibrary | null;
}

export type ResyncMode = 'first' | 'replay' | 'overflow' | 'empty';

export interface ResyncReport {
  mode: ResyncMode;
  replayed: number;
  /** 回绕导致的不可恢复区间（仅 overflow 时有值） */
  gap: { fromSeq: number; toSeq: number; count: number } | null;
}

export class ResyncService {
  private readonly log = getLogger('bridge.resync');
  private readonly deps: ResyncDeps;

  constructor(deps: ResyncDeps) {
    this.deps = deps;
  }

  handleHello(lastSeq: number): ResyncReport {
    const store = this.deps.store;
    const packet = getLimits('RESYNC_PACKET_ENTRIES');

    if (store.size === 0) {
      this.sendStatus();
      return { mode: 'empty', replayed: 0, gap: null };
    }

    if (lastSeq <= 0) {
      // ① 首次连接
      const library = this.deps.getLibrary?.() ?? null;
      if (library !== null) this.deps.send('library.snapshot', library);
      this.sendStatus();
      const snapshot = store.last(getLimits('TRACE_RESYNC_SNAPSHOT_ENTRIES'));
      this.sendInPackets(snapshot, packet);
      this.sendStatus();
      this.log.info('重连补齐：首次连接快照', { replayed: snapshot.length });
      return { mode: 'first', replayed: snapshot.length, gap: null };
    }

    if (lastSeq < store.minSeq) {
      // ② 缓冲已回绕 → 显式告知缺口
      //   ★QA-BUG-05：lastSeq === minSeq-1 表示"一条都没丢"，此时不得报告
      //     fromSeq > toSeq 的倒挂空区间（前端会画出一个负宽度的灰条）
      const gapTo = store.minSeq - 1;
      const gapFrom = lastSeq + 1;
      const gap =
        gapFrom <= gapTo ? { fromSeq: gapFrom, toSeq: gapTo, count: gapTo - gapFrom + 1 } : null;
      if (gap !== null) {
        this.deps.send('trace.gap', { ...gap, reason: 'overflow' });
        this.log.warn('重连补齐：缓冲已回绕，较早历史不可恢复', gap);
      }
      const all = store.all();
      this.sendInPackets(all, packet);
      this.sendStatus();
      return { mode: 'overflow', replayed: all.length, gap };
    }

    // ③ 正常补齐 (lastSeq, maxSeq]
    const missing = store.since(lastSeq);
    this.sendInPackets(missing, packet);
    this.sendStatus();
    if (missing.length > 0) {
      this.log.info('重连补齐完成', { lastSeq, replayed: missing.length });
    }
    return { mode: 'replay', replayed: missing.length, gap: null };
  }

  /* ─────────────── 内部实现 ─────────────── */

  private sendInPackets(entries: readonly TraceEntry[], packetSize: number): void {
    for (let i = 0; i < entries.length; i += packetSize) {
      const slice = entries.slice(i, i + packetSize);
      const events: StreamEvent[] = slice.map((entry) => ({ kind: 'trace.entry', entry }));
      this.deps.send('trace.batch', { events });
    }
  }

  private sendStatus(): void {
    const status = this.deps.getStatus();
    if (status !== null) this.deps.send('status', status);
  }
}
