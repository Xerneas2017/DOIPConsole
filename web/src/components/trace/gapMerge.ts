import type { TraceEntry } from '@doip/shared';

/**
 * ★D-01 / ★P0-FE#5：seq 缺口灰条——「全量推演、可见裁剪」。
 *
 * 历史错误链：
 *   ① 原版把灰条插错位置（gap.fromSeq 永不等真实 seq、尾部条件刚出现即消失）→ D-01 已修；
 *   ② D-01 版直接在**过滤后的行**上推演断号：被过滤掉的正常条目会被误报成"缺口灰条"，
 *      过滤越狠假缺口越多；该错误行为还被旧单测固化（"按可见行推演"断言）。
 *
 * 正确语义（本文件）：
 *   · 缺口是对**数据链**的事实陈述：只由全量 rows 的断号 + store 登记缺口推导（scanTrueGaps）；
 *   · 渲染只发生在可见序列里：灰条区间按相邻可见条目裁剪，绝不与任何可见行重叠（buildDisplayRows）；
 *   · 无过滤调用方保持旧行为：mergeGapRows(rows, gaps) === buildDisplayRows(rows, rows, gaps)。
 */

export type GapReason = 'backpressure' | 'overflow' | 'local';

export interface SeqGap {
  fromSeq: number;
  toSeq: number;
  count: number;
  reason: GapReason;
}

export type MergedRow =
  | { kind: 'entry'; seq: number; entry: TraceEntry }
  | { kind: 'gap'; seq: number; count: number; reason: string };

/**
 * 由全量行推导真实缺口区间：本地断号（相邻条目空洞）与 store 登记缺口求并集，
 * 再扣除所有真实存在的 seq（脏数据里 store 缺口压住真实条目时自动让位、分段），
 * 相邻同因区间合并，结果升序且互不重叠；起点低于首条目 seq 的历史未知区间丢弃。
 * 同起点区间：store 登记优先于 local（保留后端 reason 语义）。
 *
 * @param fullRows 全量条目（未经过滤），按 seq 升序
 * @param gaps     已知缺口，顺序任意
 */
export function scanTrueGaps(fullRows: readonly TraceEntry[], gaps: readonly SeqGap[]): SeqGap[] {
  const seqs: number[] = [];
  for (const r of fullRows) seqs.push(r.seq);
  type Raw = { from: number; to: number; reason: GapReason; store: boolean };
  const raw: Raw[] = [];
  for (let i = 0; i + 1 < seqs.length; i++) {
    const cur = seqs[i] ?? 0;
    const nxt = seqs[i + 1] ?? 0;
    if (nxt > cur + 1) raw.push({ from: cur + 1, to: nxt - 1, reason: 'local', store: false });
  }
  for (const g of gaps) raw.push({ from: g.fromSeq, to: g.toSeq, reason: g.reason, store: true });
  raw.sort((a, b) => a.from - b.from || Number(b.store) - Number(a.store) || a.to - b.to);

  const out: SeqGap[] = [];
  const push = (from: number, to: number, reason: GapReason): void => {
    if (to < from) return;
    const last = out.at(-1);
    if (last !== undefined && last.reason === reason && last.toSeq + 1 === from) {
      last.toSeq = to;
      last.count = last.toSeq - last.fromSeq + 1;
      return;
    }
    out.push({ fromSeq: from, toSeq: to, count: to - from + 1, reason });
  };

  const lower = seqs[0] ?? Number.NEGATIVE_INFINITY;
  let si = 0;
  let emitted = Number.NEGATIVE_INFINITY; // 全局单调游标：区间重叠时不重复计量
  for (const iv of raw) {
    let cur = Math.max(iv.from, lower, emitted + 1);
    for (;;) {
      const s = seqs[si];
      if (s === undefined || s >= cur) break;
      si += 1;
    }
    while (cur <= iv.to) {
      const next = seqs[si] ?? Number.POSITIVE_INFINITY;
      const stop = Math.min(iv.to, next - 1);
      if (cur <= stop) push(cur, stop, iv.reason);
      if (next > iv.to) break;
      cur = next + 1;
      si += 1;
    }
    emitted = Math.max(emitted, iv.to, cur - 1);
  }
  return out;
}

/**
 * 渲染：可见条目序列 + 真缺口区间按可见 seq 裁剪插位。
 * 灰条永不与可见行重叠（store 数据不一致时缺口与真实行相交 → 自动让位、分段）。
 *
 * @param fullRows    全量条目（升序），仅用于缺口推演
 * @param visibleRows 过滤后的可见条目（升序），参与渲染
 * @param gaps        store 登记缺口
 */
export function buildDisplayRows(
  fullRows: readonly TraceEntry[],
  visibleRows: readonly TraceEntry[],
  gaps: readonly SeqGap[],
): MergedRow[] {
  const trueGaps = scanTrueGaps(fullRows, gaps);
  const out: MergedRow[] = [];

  const pushGap = (from: number, to: number, reason: string): void => {
    if (to < from) return;
    const last = out.at(-1);
    if (last !== undefined && last.kind === 'gap' && last.reason === reason && last.seq + last.count === from) {
      last.count += to - from + 1;
      return;
    }
    out.push({ kind: 'gap', seq: from, count: to - from + 1, reason });
  };

  let prev = Number.NEGATIVE_INFINITY;
  let gi = 0;
  for (const entry of visibleRows) {
    for (;;) {
      const g = trueGaps[gi];
      if (g === undefined) break;
      if (g.toSeq <= prev) {
        gi += 1;
        continue;
      }
      if (g.fromSeq < entry.seq) {
        pushGap(Math.max(g.fromSeq, prev + 1), Math.min(g.toSeq, entry.seq - 1), g.reason);
        if (g.toSeq < entry.seq) {
          gi += 1;
          continue;
        }
      }
      break; // 未开始（或跨过本条目的异常数据）：本条目落位后续显
    }
    out.push({ kind: 'entry', seq: entry.seq, entry });
    prev = entry.seq;
  }
  for (; gi < trueGaps.length; gi += 1) {
    const g = trueGaps[gi];
    if (g === undefined) continue;
    pushGap(Math.max(g.fromSeq, prev + 1), g.toSeq, g.reason);
  }
  return out;
}

/**
 * 兼容入口：全量即可见（无过滤）场景。
 * @param rows 按 seq 升序的条目
 * @param gaps 已知缺口，顺序任意
 */
export function mergeGapRows(rows: readonly TraceEntry[], gaps: readonly SeqGap[]): MergedRow[] {
  return buildDisplayRows(rows, rows, gaps);
}
