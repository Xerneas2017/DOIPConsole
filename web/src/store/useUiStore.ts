import { create } from 'zustand';
import { TIMING } from '@doip/shared';
import type { LogFileStatus } from '@doip/shared';
import { useTraceStore } from './useTraceStore';

/**
 * UI 偏好 store（T09）—— 列显隐 / 自动跟随 / 时间戳时区 / 分区折叠。
 * 持久化到 localStorage（`usePersistedState` 同源口径）。
 */

export type TraceColumnId =
  | 'seq'
  | 'ts'
  | 'rel'
  | 'transport'
  | 'dir'
  | 'pt'
  | 'addr'
  | 'len'
  | 'decode'
  | 'raw'
  | 'latency'
  | 'tags';

export interface ColumnDef {
  id: TraceColumnId;
  label: string;
  width: number;
  defaultVisible: boolean;
}

export const TRACE_COLUMNS: readonly ColumnDef[] = [
  { id: 'seq', label: 'No.', width: 64, defaultVisible: true },
  { id: 'ts', label: '时间戳(μs)', width: 132, defaultVisible: true },
  { id: 'rel', label: '相对时间', width: 92, defaultVisible: true },
  { id: 'transport', label: '传输层', width: 62, defaultVisible: false },
  { id: 'dir', label: '方向', width: 52, defaultVisible: true },
  { id: 'pt', label: 'PayloadType', width: 128, defaultVisible: true },
  { id: 'addr', label: 'SA→TA', width: 118, defaultVisible: true },
  { id: 'len', label: '长度', width: 58, defaultVisible: true },
  { id: 'decode', label: 'UDS 解码 / 原始数据', width: 380, defaultVisible: true },
  { id: 'raw', label: '原始 hex', width: 260, defaultVisible: false },
  { id: 'latency', label: '耗时(ms)', width: 82, defaultVisible: true },
  { id: 'tags', label: '标签', width: 84, defaultVisible: true },
];

export interface UiState {
  visibleColumns: TraceColumnId[];
  useUtc: boolean;
  autoFollow: boolean;
  leftCollapsed: boolean;
  bottomCollapsed: boolean;
  detailHeight: number;
  leftWidth: number;
  testerPresentPeriodMs: number;
  targetHost: string;
  targetPort: number;
  mode: 'real' | 'sim';
  sa: string;
  ta: string;
  /**
   * ★导出对话框开关放在 store 里（而不是各入口各自 `useState`）。
   * 状态栏与 C 区工具栏都有「导出…」入口，若各自持有一份 state，
   * 就会同时挂出两个对话框实例（DOM 里出现两个「导出并下载」按钮，
   * 自动化/批量点击会真的导出两次）。全局一份开关 = 全局一个实例。
   */
  exportOpen: boolean;
  /** 运行日志面板开关（同为全局单实例，避免多处入口挂出两份） */
  logOpen: boolean;
  /** 最近一次拉取到的日志尾部内容 */
  logLines: string[];
  /** 日志尾部是否被截断（只拿到最近 N 行） */
  logTruncated: boolean;
  /** 后端日志状态（目录/文件/行数/丢弃数） */
  logStatus: LogFileStatus | null;
  /**
   * 「连接」时发现仿真未启动 → 先自动启动仿真，等它就绪后再发 connect.request。
   *
   * 存在理由：实测用户会直接点顶部工具栏的「连接」而不去启动仿真（尤其在窗口较矮、
   * 看不到左侧面板里「启动」按钮时），拿到 `ECONNREFUSED` 后以为是工具坏了。
   * 用户已经明确选择了「仿真 ECU」模式并点了连接，意图无歧义，自动把仿真拉起来是合理的。
   */
  autoConnectPending: boolean;

  toggleColumn(id: TraceColumnId): void;
  setUseUtc(useUtc: boolean): void;
  setAutoFollow(autoFollow: boolean): void;
  setLeftCollapsed(collapsed: boolean): void;
  setBottomCollapsed(collapsed: boolean): void;
  setDetailHeight(height: number): void;
  setLeftWidth(width: number): void;
  setTesterPresentPeriodMs(ms: number): void;
  setTarget(target: { host?: string; port?: number; mode?: 'real' | 'sim'; sa?: string; ta?: string }): void;
  setExportOpen(open: boolean): void;
  setLogOpen(open: boolean): void;
  setLogData(status: LogFileStatus, lines?: string[], truncated?: boolean): void;
  setAutoConnectPending(pending: boolean): void;
}

const DEFAULT_VISIBLE: TraceColumnId[] = TRACE_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.id);

export const useUiStore = create<UiState>((set, get) => ({
  visibleColumns: DEFAULT_VISIBLE,
  useUtc: false,
  autoFollow: true,
  leftCollapsed: false,
  bottomCollapsed: false,
  detailHeight: 240,
  leftWidth: 320,
  testerPresentPeriodMs: TIMING.TESTER_PRESENT_PERIOD_MS,
  targetHost: '127.0.0.1',
  targetPort: 13401,
  mode: 'sim',
  sa: '0x0E00',
  ta: '0x1000',
  exportOpen: false,
  logOpen: false,
  logLines: [],
  logTruncated: false,
  logStatus: null,
  autoConnectPending: false,

  toggleColumn: (id) => {
    const current = get().visibleColumns;
    const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
    // 保持列顺序与 TRACE_COLUMNS 一致
    const ordered = TRACE_COLUMNS.map((c) => c.id).filter((c) => next.includes(c));
    set({ visibleColumns: ordered });
  },
  setUseUtc: (useUtc) => set({ useUtc }),
  setAutoFollow: (autoFollow) => {
    set({ autoFollow });
    useTraceStore.getState().setFollow(autoFollow);
  },
  setLeftCollapsed: (leftCollapsed) => set({ leftCollapsed }),
  setBottomCollapsed: (bottomCollapsed) => set({ bottomCollapsed }),
  setDetailHeight: (detailHeight) => set({ detailHeight }),
  setLeftWidth: (leftWidth) => set({ leftWidth }),
  setTesterPresentPeriodMs: (testerPresentPeriodMs) => set({ testerPresentPeriodMs }),
  setTarget: (target) => {
    const s = get();
    set({
      targetHost: target.host ?? s.targetHost,
      targetPort: target.port ?? s.targetPort,
      mode: target.mode ?? s.mode,
      sa: target.sa ?? s.sa,
      ta: target.ta ?? s.ta,
    });
  },
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setLogOpen: (logOpen) => set({ logOpen }),
  setAutoConnectPending: (autoConnectPending) => set({ autoConnectPending }),
  setLogData: (logStatus, lines, truncated) =>
    set({
      logStatus,
      // 只回 status（不带 lines）时不要清空已有内容，避免面板闪成空白
      ...(lines === undefined ? {} : { logLines: lines, logTruncated: truncated ?? false }),
    }),
}));
