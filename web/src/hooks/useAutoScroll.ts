import { useEffect, useRef } from 'react';

/**
 * 自动跟随（T10）：新条目到达时滚到底部。
 * 用户手动上滚即自动脱离跟随（由调用方在 onUserScroll 里 setFollow(false)）。
 */
export function useAutoScroll(
  scrollRef: React.RefObject<HTMLElement>,
  deps: { count: number; enabled: boolean },
): void {
  const lastCountRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (!deps.enabled) {
      lastCountRef.current = deps.count;
      return;
    }
    if (deps.count === lastCountRef.current) return;
    lastCountRef.current = deps.count;
    el.scrollTop = el.scrollHeight;
  }, [deps.count, deps.enabled, scrollRef]);
}
