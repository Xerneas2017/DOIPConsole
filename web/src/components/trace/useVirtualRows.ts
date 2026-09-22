import { useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * 虚拟滚动封装（T10）—— 基于 `@tanstack/react-virtual`。
 *
 * - 行高固定 `ROW_HEIGHT`，10 000 行只渲染视口内的 ~30 行（≥ 50 fps）；
 * - `overscan` 由 `LIMITS.UI_TRACE_RENDER_WINDOW` 推导，避免首屏长任务；
 * - 暴露 `scrollToIndex` 供"自动跟随 / 跳转到指定 seq"使用。
 */

export const ROW_HEIGHT = 22;

export interface VirtualRows {
  virtualItems: Array<{ index: number; start: number }>;
  totalHeight: number;
  measureElement: (node: Element | null) => void;
  scrollToIndex: (index: number, align?: 'start' | 'center' | 'end' | 'auto') => void;
  scrollToOffset: (offset: number) => void;
}

export function useVirtualRows(
  scrollRef: React.RefObject<HTMLElement | null>,
  itemCount: number,
  overscan = 12,
): VirtualRows {
  const virtualizer = useVirtualizer({
    count: itemCount,
    getScrollElement: () => scrollRef.current ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan,
  });

  const scrollToIndex = useCallback(
    (index: number, align: 'start' | 'center' | 'end' | 'auto' = 'end') => {
      virtualizer.scrollToIndex(index, { align });
    },
    [virtualizer],
  );

  const scrollToOffset = useCallback(
    (offset: number) => {
      virtualizer.scrollToOffset(offset);
    },
    [virtualizer],
  );

  const measureElement = useCallback(
    (node: Element | null) => {
      if (node !== null) virtualizer.measureElement(node);
    },
    [virtualizer],
  );

  return {
    virtualItems: virtualizer.getVirtualItems().map((item) => ({
      index: item.index,
      start: item.start,
    })),
    totalHeight: virtualizer.getTotalSize(),
    measureElement,
    scrollToIndex,
    scrollToOffset,
  };
}
