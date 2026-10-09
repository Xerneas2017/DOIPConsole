import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '@doip/shared';
import { buildDisplayRows, mergeGapRows } from './gapMerge';
import type { SeqGap } from './gapMerge';

/**
 * ★D-01 回归：缺口灰条必须插到"它本该在的位置"，且**不会因为后续条目到达而消失**。
 * 这是 QA 在真实浏览器里抓到的：1..4 到、丢 5、6 再到 → 灰条刚出现就没了。
 */

function entry(seq: number): TraceEntry {
  return { seq } as unknown as TraceEntry;
}

function shape(rows: ReturnType<typeof mergeGapRows>): string[] {
  return rows.map((r) =>
    r.kind === 'entry' ? `E${r.seq}` : `G${r.seq}+${r.count - 1}(${r.reason})`,
  );
}

describe('D-01 — 缺口灰条插入', () => {
  it('★真实缺口（1..4 到、丢 5、6 再到）在 4 与 6 之间常驻一条灰条', () => {
    const rows = mergeGapRows([entry(1), entry(2), entry(3), entry(4), entry(6)], []);
    expect(shape(rows)).toEqual(['E1', 'E2', 'E3', 'E4', 'G5+0(local)', 'E6']);
  });

  it('★后续条目继续到达，灰条不会消失（D-01 的核心回归）', () => {
    const before = mergeGapRows([entry(1), entry(2), entry(3), entry(4), entry(6)], []);
    const after = mergeGapRows(
      [entry(1), entry(2), entry(3), entry(4), entry(6), entry(7), entry(8)],
      [],
    );
    expect(after.filter((r) => r.kind === 'gap')).toHaveLength(1);
    expect(shape(after)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'G5+0(local)',
      'E6',
      'E7',
      'E8',
    ]);
    expect(before.filter((r) => r.kind === 'gap')).toHaveLength(1);
  });

  it('多段空洞各自成条，count 正确', () => {
    const rows = mergeGapRows([entry(1), entry(5), entry(9)], []);
    expect(shape(rows)).toEqual(['E1', 'G2+2(local)', 'E5', 'G6+2(local)', 'E9']);
  });

  it('store 登记的缺口与本地顺序缺口合并，同一段绝不插两条', () => {
    const gap: SeqGap = { fromSeq: 5, toSeq: 5, count: 1, reason: 'backpressure' };
    const rows = mergeGapRows([entry(1), entry(2), entry(3), entry(4), entry(6)], [gap]);
    expect(shape(rows)).toEqual(['E1', 'E2', 'E3', 'E4', 'G5+0(backpressure)', 'E6']);
    expect(rows.filter((r) => r.kind === 'gap')).toHaveLength(1);
  });

  it('尾部缺口（后端还没补上）排在最后', () => {
    const gap: SeqGap = { fromSeq: 4, toSeq: 9, count: 6, reason: 'overflow' };
    const rows = mergeGapRows([entry(1), entry(2), entry(3)], [gap]);
    expect(shape(rows)).toEqual(['E1', 'E2', 'E3', 'G4+5(overflow)']);
  });

  it('相邻同因缺口合并成一条', () => {
    const gaps: SeqGap[] = [
      { fromSeq: 2, toSeq: 2, count: 1, reason: 'local' },
      { fromSeq: 3, toSeq: 3, count: 1, reason: 'local' },
    ];
    const rows = mergeGapRows([entry(1), entry(4)], gaps);
    expect(shape(rows)).toEqual(['E1', 'G2+1(local)', 'E4']);
  });

  it('★P0-FE#5 回归：被过滤掉的真实条目绝不造假灰条（旧测试固化过此错误）', () => {
    // 全量 1..6 完整无缺；过滤后只见 3、5、6 —— 不该出现任何灰条
    const full = [entry(1), entry(2), entry(3), entry(4), entry(5), entry(6)];
    const visible = [entry(3), entry(5), entry(6)];
    const rows = buildDisplayRows(full, visible, []);
    expect(shape(rows)).toEqual(['E3', 'E5', 'E6']);
  });

  it('★P0-FE#5 回归：真实缺口在过滤视图里仍显示，且 count 按数据链而非可见行', () => {
    // 全量：1..4 到、丢 5、6..8 到；过滤只剩 2、7 → E2 G5..6? 不对——5 是真缺口、6 被过滤
    const full = [entry(1), entry(2), entry(3), entry(4), entry(6), entry(7), entry(8)];
    const visible = [entry(2), entry(7)];
    const rows = buildDisplayRows(full, visible, []);
    // 可见 2 与 7 之间：真缺口 5（灰条裁剪到 (2,7) 开区间 → 5..5，被过滤的 6 不造假）
    expect(shape(rows)).toEqual(['E2', 'G5+0(local)', 'E7']);
  });

  it('★P0-FE#5 裁剪：store 缺口与真实条目重叠时灰条让位分段，绝不压住可见行', () => {
    const full = [entry(1), entry(5), entry(9)];
    const badGap: SeqGap = { fromSeq: 3, toSeq: 7, count: 5, reason: 'overflow' };
    const rows = buildDisplayRows(full, full, [badGap]);
    // store 谎称缺 3..7，但 5 真实存在 → 让位分段；2/5 之外真实缺失号全覆盖
    expect(shape(rows)).toEqual(['E1', 'G2+2(local)', 'E5', 'G6+1(overflow)', 'G8+0(local)', 'E9']);
    const entrySeqs = rows.filter((r) => r.kind === 'entry').map((r) => (r.kind === 'entry' ? r.seq : -1));
    for (const r of rows) {
      if (r.kind !== 'gap') continue;
      for (let s = r.seq; s < r.seq + r.count; s++) expect(entrySeqs).not.toContain(s);
    }
  });

  it('空表与单条不产生灰条', () => {
    expect(mergeGapRows([], [])).toEqual([]);
    expect(shape(mergeGapRows([entry(7)], []))).toEqual(['E7']);
  });
});
