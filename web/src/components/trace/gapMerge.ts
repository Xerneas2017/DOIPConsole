import type { TraceEntry } from '@doip/shared';

/**
 * ★D-01：把 seq 缺口插到"它本该在的位置"。
 *
 * 背景（为什么原来的写法是错的）：
 *   ① `gap.fromSeq === 某条目.seq` —— 缺口的定义就是"那些 seq **不存在**"，
 *      所以缺口起点几乎不可能等于某个存在条目的 seq，真实缺口永远插不进去；
 *   ② `gap.fromSeq > lastSeq` —— 一旦后续条目到达（6 到了），这个尾部条件也不成立，
 *      于是"1..4 到、丢 5、6 再到"的灰条**刚出现就消失**。
 *
 * 正确做法：按 seq 顺序走一遍，维护"期望的下一个 seq"，
 * 遇到 `entry.seq > expected` 就在此处插入覆盖 `[expected, entry.seq-1]` 的灰条；
 * 与 store 里登记的 gaps 合并（用 gap 推进 expected，避免同一段插两条）。
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
 * @param rows 已过滤、按 seq 升序的条目
 * @param gaps 已知缺口（后端 `trace.gap` + 前端本地断号检测），顺序任意
 */
export function mergeGapRows(rows: readonly TraceEntry[], gaps: readonly SeqGap[]): MergedRow[] {
  const out: MergedRow[] = [];
  const sorted = [...gaps].sort((a, b) => a.fromSeq - b.fromSeq);
  let gi = 0;
  /** 期望的下一个 seq；null = 还没有基准（rows 为空） */
  let expected: number | null = rows.length > 0 ? (rows[0]?.seq ?? null) : null;

  const pushGap = (from: number, to: number, reason: string): void => {
    if (to < from) return;
    const last = out.at(-1);
    // 相邻且同因 → 合并，避免刷出一串"缺 1 条"的灰条
    if (
      last !== undefined &&
      last.kind === 'gap' &&
      last.reason === reason &&
      last.seq + last.count === from
    ) {
      last.count += to - from + 1;
      return;
    }
    out.push({ kind: 'gap', seq: from, count: to - from + 1, reason });
  };

  for (const entry of rows) {
    // ① 先落地 store 里登记过的缺口（起点 < 本条 seq 的）
    while (gi < sorted.length && (sorted[gi]?.fromSeq ?? Number.POSITIVE_INFINITY) < entry.seq) {
      const gap = sorted[gi];
      gi += 1;
      if (gap === undefined) continue;
      const from = Math.max(gap.fromSeq, expected ?? gap.fromSeq);
      if (from <= gap.toSeq) {
        pushGap(from, gap.toSeq, gap.reason);
        expected = Math.max(expected ?? 0, gap.toSeq + 1);
      }
    }
    // ② 本地顺序缺口：期望号与实到号之间的空洞
    if (expected !== null && entry.seq > expected) {
      pushGap(expected, entry.seq - 1, 'local');
    }
    out.push({ kind: 'entry', seq: entry.seq, entry });
    expected = entry.seq + 1;
  }

  // ③ 尾部缺口（后端还没补上 / 缓冲回绕）
  while (gi < sorted.length) {
    const gap = sorted[gi];
    gi += 1;
    if (gap === undefined) continue;
    const from = Math.max(gap.fromSeq, expected ?? gap.fromSeq);
    if (from > gap.toSeq) continue;
    pushGap(from, gap.toSeq, gap.reason);
    expected = Math.max(expected ?? 0, gap.toSeq + 1);
  }

  return out;
}
