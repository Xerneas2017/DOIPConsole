/**
 * Trace 环形缓冲（§3.11 / §9.4）。
 *
 * ★双上限淘汰：条数（`TRACE_RING_MAX_ENTRIES`）与字节（`TRACE_RING_MAX_BYTES`）**先到者生效**。
 *   只做条数上限时，若全是 4 KB 大帧，100 k 条 ≈ 420 MB 会直接把进程拖垮；
 *   字节上限是"挂机一晚崩不崩"的真正兜底。
 *
 * ★seq 由 EventBus 统一分配（§3.12：唯一 seq 分配点），本类只做存储与淘汰，
 *   不产号、不改号，因此缓冲内的 seq 永远与已推送给前端的流一致。
 */

import type { TraceEntry } from '@doip/shared';
import { getLogger } from '../logging/logger';
import { getLimits } from '../config/defaults';

export interface TraceStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
}

/**
 * ★D-02：允许就地回填的事务派生字段。
 * 刻意**不含** seq / ts / rawHex / doip / uds 等事实字段——那些是"报文是什么"，
 * 只能由解码链路决定，事务层无权改写。
 */
export interface TraceEntryPatch {
  transactionId?: string | null;
  txnRole?: TraceEntry['txnRole'];
  linkedSeq?: number | null;
  latencyMs?: number | null;
  gatewayForwardLatencyMs?: number | null;
  timeout?: boolean;
}

export interface TraceStoreStats {
  size: number;
  bytes: number;
  minSeq: number;
  maxSeq: number;
  maxEntries: number;
  maxBytes: number;
  /** 累计淘汰条数（用于判断"缓冲是否已回绕"） */
  evicted: number;
}

/** 单条条目除 rawHex 外的对象开销估算（§9.4：~450 B） */
function entryOverheadBytes(): number {
  return getLimits('TRACE_ENTRY_OVERHEAD_BYTES');
}

/** rawHex 为 UTF-16 字符串，每字符 2 字节 */
export function estimateEntryBytes(entry: TraceEntry): number {
  return entryOverheadBytes() + entry.rawHex.length * 2;
}

export class TraceStore {
  private readonly log = getLogger('trace.store');
  private readonly buffer: TraceEntry[] = [];
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private byteTotal = 0;
  private evictedCount = 0;
  private droppedRanges = 0;

  constructor(options: TraceStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? getLimits('TRACE_RING_MAX_ENTRIES');
    this.maxBytes = options.maxBytes ?? getLimits('TRACE_RING_MAX_BYTES');
  }

  /** 追加一条（seq 由 EventBus 分配）；返回被淘汰的条目数 */
  append(entry: TraceEntry): number {
    this.buffer.push(entry);
    this.byteTotal += estimateEntryBytes(entry);
    return this.evictIfNeeded();
  }

  get size(): number {
    return this.buffer.length;
  }

  get bytes(): number {
    return this.byteTotal;
  }

  /** 当前最老条目的 seq；空缓冲返回 0 */
  get minSeq(): number {
    return this.buffer.length === 0 ? 0 : (this.buffer[0]?.seq ?? 0);
  }

  /** 当前最新条目的 seq；空缓冲返回 0 */
  get maxSeq(): number {
    return this.buffer.length === 0 ? 0 : (this.buffer[this.buffer.length - 1]?.seq ?? 0);
  }

  get evicted(): number {
    return this.evictedCount;
  }

  all(): TraceEntry[] {
    return this.buffer.slice();
  }

  /** 取 (fromSeq, maxSeq] 区间（断线补齐用） */
  since(fromSeq: number): TraceEntry[] {
    const out: TraceEntry[] = [];
    for (const entry of this.buffer) {
      if (entry.seq > fromSeq) out.push(entry);
    }
    return out;
  }

  /** 取闭区间 [fromSeq, toSeq] */
  range(fromSeq: number, toSeq: number): TraceEntry[] {
    const out: TraceEntry[] = [];
    for (const entry of this.buffer) {
      if (entry.seq >= fromSeq && entry.seq <= toSeq) out.push(entry);
    }
    return out;
  }

  /** 最近 n 条（重连快照用） */
  last(n: number): TraceEntry[] {
    if (n <= 0) return [];
    return this.buffer.slice(Math.max(0, this.buffer.length - n));
  }

  bySeq(seq: number): TraceEntry | null {
    const idx = this.indexOfSeq(seq);
    return idx < 0 ? null : (this.buffer[idx] ?? null);
  }

  /**
   * ★D-02 事务字段回填：按 seq 就地改写**已存在**的条目。
   *
   * 只改"事务派生字段"（transactionId / txnRole / linkedSeq / latencyMs /
   * gatewayForwardLatencyMs / timeout），绝不改 seq / ts / rawHex 等事实字段。
   *
   * @returns 真正被改写的条目；seq 不存在（已淘汰或尚未发布）时返回 null
   */
  patch(seq: number, patch: TraceEntryPatch): TraceEntry | null {
    const idx = this.indexOfSeq(seq);
    if (idx < 0) return null;
    const entry = this.buffer[idx];
    if (entry === undefined) return null;
    let changed = false;
    const target = entry as unknown as Record<string, unknown>;
    for (const key of Object.keys(patch) as Array<keyof TraceEntryPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      if (target[key] === value) continue;
      target[key] = value;
      changed = true;
    }
    return changed ? entry : null;
  }

  /** 批量回填；只返回真正被改写的条目（避免无谓推送） */
  patchMany(patches: ReadonlyArray<{ seq: number; patch: TraceEntryPatch }>): TraceEntry[] {
    const changed: TraceEntry[] = [];
    for (const item of patches) {
      if (item.seq <= 0) continue;
      const entry = this.patch(item.seq, item.patch);
      if (entry !== null) changed.push(entry);
    }
    return changed;
  }

  /**
   * seq 升序（EventBus 分配即追加，缓冲内必然有序）→ 二分查找。
   * ★不用线性扫描：10 万条缓冲下，每个事务要回填 3~4 个 seq，线性扫描会拖垮热路径。
   */
  private indexOfSeq(seq: number): number {
    let lo = 0;
    let hi = this.buffer.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const current = this.buffer[mid]?.seq ?? 0;
      if (current === seq) return mid;
      if (current < seq) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  clear(): void {
    this.buffer.length = 0;
    this.byteTotal = 0;
    this.evictedCount = 0;
    this.droppedRanges = 0;
  }

  stats(): TraceStoreStats {
    return {
      size: this.buffer.length,
      bytes: this.byteTotal,
      minSeq: this.minSeq,
      maxSeq: this.maxSeq,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      evicted: this.evictedCount,
    };
  }

  /** 已发生过的"回绕丢区间"次数（供 UI 提示"较早历史不可恢复"） */
  get overflowRanges(): number {
    return this.droppedRanges;
  }

  /* ─────────────── 内部实现 ─────────────── */

  private evictIfNeeded(): number {
    let evicted = 0;
    // ① 条数上限
    while (this.buffer.length > this.maxEntries) {
      const dropped = this.buffer.shift();
      if (dropped === undefined) break;
      this.byteTotal -= estimateEntryBytes(dropped);
      evicted += 1;
    }
    // ② 字节上限（先到者生效；与条数上限独立判定）
    while (this.byteTotal > this.maxBytes && this.buffer.length > 0) {
      const dropped = this.buffer.shift();
      if (dropped === undefined) break;
      this.byteTotal -= estimateEntryBytes(dropped);
      evicted += 1;
    }
    if (evicted > 0) {
      this.evictedCount += evicted;
      this.droppedRanges += 1;
      if (this.byteTotal < 0) this.byteTotal = 0;
      this.log.debug('环形缓冲已淘汰旧条目', {
        evicted,
        size: this.buffer.length,
        bytes: this.byteTotal,
      });
    }
    return evicted;
  }
}
