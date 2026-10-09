import { create } from 'zustand';
import type { DiscoveredEntity, RecordingStatus, SessionStatus, SimStatus, WsError } from '@doip/shared';

/**
 * 连接 / 会话 / 仿真 / 录盘 状态 store（T09）。
 *
 * 全部由后端 `status` / `scan.result` / `sim.status` / `trace.logfile` 事件驱动，
 * 前端不自行推导（避免与后端状态机两套真值）。
 */

/**
 * 连接 / 会话 / 仿真 / 录盘 状态 store（T09）。
 *
 * 全部由后端 `status` / `scan.result` / `sim.status` / `trace.logfile` 事件驱动，
 * 前端不自行推导（避免与后端状态机两套真值）。
 *
 * ★D-03：WS 断开后这些状态**全部作废**。继续显示上一次的成功状态属于"陈旧状态"，
 *   会让用户以为 ECU 还连着、路由还激活着、仿真还在跑。断开即清空并置 `stale=true`，
 *   重连后由后端重新推送的真值自然把 `stale` 翻回 false。
 */
export type WsStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/**
 * ★裁定①状态转中文：断线/重连不能只丢一个英文枚举给用户。
 * 'open' → 不显示附加文案；其余状态配合 `wsDetail`（WsClient 归因）展示。
 */
export const WS_STATUS_LABEL: Record<WsStatus, string> = {
  idle: '未连接',
  connecting: '连接中',
  open: '已连接',
  reconnecting: '自动重连中',
  closed: '已断开',
};

export interface ConnectionState2 {
  wsStatus: WsStatus;
  /**
   * ★裁定①：断线/重连的人话归因（来自 WsClient.describeWsClose + 尝试次数）。
   * null = 无异常（idle/open）。markStale 不清它——它就是"为什么看不到状态"的答案。
   */
  wsDetail: string | null;
  serverVersion: string | null;
  status: SessionStatus | null;
  entities: DiscoveredEntity[];
  scanning: boolean;
  sim: SimStatus | null;
  recording: RecordingStatus | null;
  /** ★D-03：后端断开后置 true —— 上面这些字段此刻不代表真值，UI 必须显示"未知" */
  stale: boolean;
  /** 最近的错误（P0-14：与 Trace 行互跳，linkedSeq 指向具体行） */
  errors: Array<WsError & { at: number }>;
  /** 最后一次 UDS 发送结果（B 区与 D 区共用；M4 扩展示） */
  lastResult: { ok: boolean; hex: string; note: string } | null;

  setWsStatus(wsStatus: WsStatus, detail?: string | null): void;
  setServerVersion(version: string): void;
  setStatus(status: SessionStatus): void;
  setEntities(entities: DiscoveredEntity[]): void;
  setScanning(scanning: boolean): void;
  setSim(sim: SimStatus): void;
  setRecording(recording: RecordingStatus): void;
  pushError(error: WsError): void;
  setLastResult(result: { ok: boolean; hex: string; note: string } | null): void;
  clearErrors(): void;
  /** ★D-03：WS 断开 → 清空全部由后端推送的状态并标记"未知" */
  markStale(): void;
}

export const useConnectionStore = create<ConnectionState2>((set, get) => ({
  wsStatus: 'idle',
  wsDetail: null,
  serverVersion: null,
  status: null,
  entities: [],
  scanning: false,
  sim: null,
  recording: null,
  stale: false,
  errors: [],
  lastResult: null,

  setWsStatus: (wsStatus, detail = null) => set({ wsStatus, wsDetail: detail }),
  setServerVersion: (serverVersion) => set({ serverVersion }),
  // ★后端重新推来真值 → 陈旧标记解除
  setStatus: (status) => set({ status, stale: false }),
  setEntities: (entities) => set({ entities, scanning: false, stale: false }),
  setScanning: (scanning) => set({ scanning }),
  setSim: (sim) => set({ sim, stale: false }),
  setRecording: (recording) => set({ recording, stale: false }),
  pushError: (error) => {
    const errors = get().errors.concat({ ...error, at: Date.now() });
    set({ errors: errors.slice(-100) });
  },
  setLastResult: (lastResult) => set({ lastResult }),
  clearErrors: () => set({ errors: [] }),

  /**
   * ★D-03：断开即作废。
   * 保留 `errors`（那是历史，不是状态）与 `wsStatus`（由 WsClient 管）。
   */
  markStale: () =>
    set({
      status: null,
      entities: [],
      scanning: false,
      sim: null,
      recording: null,
      lastResult: null,
      stale: true,
    }),
}));
