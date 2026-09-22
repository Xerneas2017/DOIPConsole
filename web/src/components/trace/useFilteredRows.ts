import { useMemo, useRef } from 'react';
import type { TraceEntry } from '@doip/shared';
import { TRACE_COLUMNS } from '../../store/useUiStore';
import { compileFilter } from '../../decode/filterExpression';

/**
 * 过滤视图（T10）。
 *
 * - 表达式编译结果缓存（deps: entries/filterExpr/hidePeriodic）；
 * - ★非法表达式**不静默丢数据**：按"不过滤"处理，由调用方提示用户。
 */

export interface FilterResult {
  rows: TraceEntry[];
  invalidExpr: boolean;
  hiddenCount: number;
}

export function useFilteredRows(
  entries: TraceEntry[],
  filterExpr: string,
  hidePeriodic: boolean,
): FilterResult {
  return useMemo(() => {
    const compiled = compileFilter(filterExpr);
    const invalidExpr = compiled === 'invalid';
    const predicate = typeof compiled === 'function' ? compiled : null;

    let rows = entries;
    if (predicate !== null) {
      rows = rows.filter((e) => predicate(e));
    }
    if (hidePeriodic) {
      rows = rows.filter((e) => !e.tags.includes('周期3E'));
    }
    return { rows, invalidExpr, hiddenCount: entries.length - rows.length };
  }, [entries, filterExpr, hidePeriodic]);
}

/** 列总宽（虚拟表格横向滚动用） */
export function useTotalWidth(visibleColumnIds: readonly string[]): number {
  return useMemo(
    () =>
      TRACE_COLUMNS.filter((c) => visibleColumnIds.includes(c.id)).reduce((sum, c) => sum + c.width, 0),
    [visibleColumnIds],
  );
}

/** 滚动容器 ref 的小工具：脱离自动跟随判定 */
export function useScrollAway(onAway: () => void): {
  ref: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  const lastTopRef = useRef(0);

  const onScroll = (): void => {
    const el = ref.current;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    const goingUp = el.scrollTop < lastTopRef.current;
    lastTopRef.current = el.scrollTop;
    if (goingUp && !atBottom) onAway();
  };

  return { ref, onScroll };
}
