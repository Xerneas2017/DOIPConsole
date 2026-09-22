import { create } from 'zustand';
import type { TraceEntry } from '@doip/shared';
import { LIMITS } from '@doip/shared';

/**
 * Trace 缓冲 store（T09）。
 *
 * - 增量摄入：WS 每批 `trace.batch` 直接 `ingest()`，不做全量重建。
 * - 环形上限：`LIMITS.TRACE_RING_MAX_ENTRIES` 条，超出去头部（与后端一致的双限口径，
 *   前端只按条数截断，字节上限由后端负责）。
 * - ★seq 缺口检测：摄入时比对 `lastSeq + 1`，断号即登记 gap（灰条），
 *   与后端主动推的 `trace.gap` 合并到同一数组。
 */

export interface TraceGap {
  fromSeq: number;
  toSeq: number;
  count: number;
  reason: 'backpressure' | 'overflow' | 'local';
}

export interface TraceState {
  entries: TraceEntry[];
  /** 已摄入的最大 seq（重连补齐的起点） */
  lastSeq: number;
  firstSeq: number | null;
  gaps: TraceGap[];
  /** 暂停摄入（工具栏「暂停」）：暂停期间到达的条目只计数不入表 */
  paused: boolean;
  droppedWhilePaused: number;
  /** 自动跟随（滚到底部） */
  follow: boolean;
  filterExpr: string;
  hidePeriodicTesterPresent: boolean;
  selectedSeq: number | null;
  hoveredTxnId: string | null;
  /** 摄入计数（用于状态栏 / 性能观察） */
  ingestedCount: number;

  ingest(entries: TraceEntry[]): void;
  /** ★T12：服务库热更新后的 repatch —— 按 seq 就地替换（这些条目已存在，ingest 会去重跳过） */
  applyRepatch(entries: TraceEntry[]): void;
  addGap(gap: TraceGap): void;
  clear(): void;
  setPaused(paused: boolean): void;
  setFollow(follow: boolean): void;
  setFilterExpr(expr: string): void;
  setHidePeriodic(hide: boolean): void;
  select(seq: number | null): void;
  setHoveredTxn(txnId: string | null): void;
}

const MAX_ENTRIES = LIMITS.TRACE_RING_MAX_ENTRIES;

export const useTraceStore = create<TraceState>((set, get) => ({
  entries: [],
  lastSeq: 0,
  firstSeq: null,
  gaps: [],
  paused: false,
  droppedWhilePaused: 0,
  follow: true,
  filterExpr: '',
  hidePeriodicTesterPresent: false,
  selectedSeq: null,
  hoveredTxnId: null,
  ingestedCount: 0,

  ingest: (incoming) => {
    if (incoming.length === 0) return;
    const state = get();

    if (state.paused) {
      set({ droppedWhilePaused: state.droppedWhilePaused + incoming.length });
      return;
    }

    const sorted = [...incoming].sort((a, b) => a.seq - b.seq);

    /**
     * ① 去重：已存在的 seq 跳过。
     * ★不能用"`seq <= lastSeq` 就丢"的旧写法 —— 补齐回填的条目 seq **小于** lastSeq，
     *   那样写会把辛苦补回来的条目再次丢掉，缺口永远补不齐（QA 终验缺陷 4 的一半根因）。
     * 两个数组都按 seq 升序，双指针一趟即可。
     */
    const additions: TraceEntry[] = [];
    let cursor = 0;
    for (const entry of sorted) {
      const current = state.entries;
      while (cursor < current.length) {
        const at = current[cursor];
        if (at === undefined || at.seq >= entry.seq) break;
        cursor += 1;
      }
      const at = current[cursor];
      if (at !== undefined && at.seq === entry.seq) continue;
      additions.push(entry);
    }
    if (additions.length === 0) return;

    // ② 归并（保持 seq 升序）
    const merged: TraceEntry[] = [];
    let a = 0;
    let b = 0;
    while (a < state.entries.length && b < additions.length) {
      const left = state.entries[a];
      const right = additions[b];
      if (left === undefined) {
        b += 1;
        continue;
      }
      if (right === undefined) {
        a += 1;
        continue;
      }
      if (left.seq <= right.seq) {
        merged.push(left);
        a += 1;
      } else {
        merged.push(right);
        b += 1;
      }
    }
    for (; a < state.entries.length; a += 1) {
      const left = state.entries[a];
      if (left !== undefined) merged.push(left);
    }
    for (; b < additions.length; b += 1) {
      const right = additions[b];
      if (right !== undefined) merged.push(right);
    }

    // ③ 环形上限：去头部
    let firstSeq = merged[0]?.seq ?? null;
    let trimmed = merged;
    if (trimmed.length > MAX_ENTRIES) {
      trimmed = trimmed.slice(trimmed.length - MAX_ENTRIES);
      firstSeq = trimmed[0]?.seq ?? null;
    }

    const lastSeq = trimmed[trimmed.length - 1]?.seq ?? state.lastSeq;

    /**
     * ④ 缺口**重算**（而不是只增不减）：补齐回填后旧缺口必须消失。
     * reason 沿用同起点旧缺口的取值（后端声明的 backpressure / overflow 不降级成 local）。
     */
    const reasonByFrom = new Map<number, TraceGap['reason']>();
    for (const gap of state.gaps) reasonByFrom.set(gap.fromSeq, gap.reason);
    const presentGaps: TraceGap[] = [];
    for (let i = 1; i < trimmed.length; i += 1) {
      const prev = trimmed[i - 1];
      const cur = trimmed[i];
      if (prev === undefined || cur === undefined) continue;
      if (cur.seq <= prev.seq + 1) continue;
      const fromSeq = prev.seq + 1;
      presentGaps.push({
        fromSeq,
        toSeq: cur.seq - 1,
        count: cur.seq - prev.seq - 1,
        reason: reasonByFrom.get(fromSeq) ?? 'local',
      });
    }
    // 尾端缺口（后端已声明、条目尚未到达）：不在 presentGaps 里，必须保留
    const tail = state.gaps.filter((g) => g.fromSeq > lastSeq);
    const gaps = presentGaps.concat(tail).slice(-200);

    set({
      entries: trimmed,
      lastSeq,
      firstSeq,
      ingestedCount: state.ingestedCount + additions.length,
      gaps,
    });
  },

  /**
   * ★T12 repatch：整条替换同 seq 的条目（库改名后 Trace 表就地刷新）。
   * 只改派生字段；seq/ts/rawHex 由后端保证不变。
   */
  applyRepatch: (incoming) => {
    if (incoming.length === 0) return;
    const state = get();
    if (state.entries.length === 0) return;
    const bySeq = new Map<number, TraceEntry>();
    for (const entry of incoming) bySeq.set(entry.seq, entry);
    let touched = 0;
    const next = state.entries.map((entry) => {
      const replacement = bySeq.get(entry.seq);
      if (replacement === undefined) return entry;
      touched += 1;
      return replacement;
    });
    if (touched === 0) return;
    set({ entries: next });
  },

  addGap: (gap) => {
    const state = get();
    set({ gaps: state.gaps.concat(gap).slice(-200) });
  },

  clear: () => {
    set({
      entries: [],
      lastSeq: 0,
      firstSeq: null,
      gaps: [],
      selectedSeq: null,
      droppedWhilePaused: 0,
      ingestedCount: 0,
    });
  },

  setPaused: (paused) => set({ paused }),
  setFollow: (follow) => set({ follow }),
  setFilterExpr: (filterExpr) => set({ filterExpr }),
  setHidePeriodic: (hidePeriodicTesterPresent) => set({ hidePeriodicTesterPresent }),
  select: (selectedSeq) => set({ selectedSeq }),
  setHoveredTxn: (hoveredTxnId) => set({ hoveredTxnId }),
}));
