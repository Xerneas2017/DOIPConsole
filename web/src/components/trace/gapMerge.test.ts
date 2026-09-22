import { describe, expect, it } from 'vitest';
import type { TraceEntry } from '@doip/shared';
import { mergeGapRows } from './gapMerge';
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

  it('过滤后的 rows 也要正确：缺口按可见行的 seq 推演，不是按全量', () => {
    // 只留偶数 seq（模拟过滤）→ 3 与 5 之间应出现覆盖 4 的灰条
    const rows = mergeGapRows([entry(3), entry(5), entry(5 + 1)], []);
    expect(shape(rows)).toEqual(['E3', 'G4+0(local)', 'E5', 'E6']);
  });

  it('空表与单条不产生灰条', () => {
    expect(mergeGapRows([], [])).toEqual([]);
    expect(shape(mergeGapRows([entry(7)], []))).toEqual(['E7']);
  });
});
