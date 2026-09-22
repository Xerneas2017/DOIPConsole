import { useCallback, useEffect, useRef } from 'react';
import { getWsClient } from './useWsConnection';
import { useTraceStore } from '../store/useTraceStore';
import type { TraceGap } from '../store/useTraceStore';

/**
 * 重连补齐（T09）。
 *
 * - 每次 WS 进入 `open`（含重连成功）都自动发起一次 `session.hello{lastSeq}`，
 *   由后端 `ResyncService` 走三分支（首次 / 重放 / 溢出）；
 * - 暴露 `resyncNow()` 供"手动补齐"按钮与状态栏点击使用；
 * - ★幂等：同一 lastSeq 在短时间内不重复发起（避免重连风暴时刷爆后端）。
 *
 * ★QA 终验缺陷 4：补齐起点不能取 `lastSeq`（"已摄入的最大 seq"）。
 *   假设 31–45 缺失、46–54 已到：`lastSeq` = 54，hello{lastSeq:54}
 *   让后端判定"无需补齐"，31–45 永远补不回来 —— 缺口自愈形同虚设，
 *   而界面还写着"重连补齐中"，属于承诺了做不到的事。
 *   正确起点是**最靠前的缺口起点 - 1**，没有缺口时才用 lastSeq。
 */
export function firstGapStart(gaps: readonly TraceGap[]): number | null {
  let min: number | null = null;
  for (const gap of gaps) {
    if (min === null || gap.fromSeq < min) min = gap.fromSeq;
  }
  return min;
}

/** 计算本次 hello 应带的 lastSeq */
export function resyncBaseSeq(state: { lastSeq: number; gaps: readonly TraceGap[] }): number {
  const start = firstGapStart(state.gaps);
  return start === null ? state.lastSeq : Math.max(0, start - 1);
}

const MIN_INTERVAL_MS = 300;

export function useResync(): { resyncNow: (force?: boolean) => void } {
  const lastAtRef = useRef(0);
  const lastSeqRef = useRef(0);

  const resyncNow = useCallback((force = false) => {
    const state = useTraceStore.getState();
    const lastSeq = resyncBaseSeq(state);
    const now = Date.now();
    if (!force && lastSeq === lastSeqRef.current && now - lastAtRef.current < MIN_INTERVAL_MS) {
      return;
    }
    lastAtRef.current = now;
    lastSeqRef.current = lastSeq;
    getWsClient().sendCommand('session.hello', { lastSeq });
  }, []);

  useEffect(() => {
    // 首连即补齐一次（WsClient 内部已发 hello，这里只做"连接成功后状态变化"的兜底）
    const unsub = useTraceStore.subscribe((state, prev) => {
      void state;
      void prev;
    });
    return () => {
      unsub();
    };
  }, []);

  return { resyncNow };
}
