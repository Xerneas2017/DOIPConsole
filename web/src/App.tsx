import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import { TIMING } from '@doip/shared';
import { AppShell } from './components/layout/AppShell';
import { TopToolbar } from './components/toolbar/TopToolbar';
import { ConnectionPanel } from './components/connection/ConnectionPanel';
import { TraceTable } from './components/trace/TraceTable';
import { DetailPanel } from './components/detail/DetailPanel';
import { StatusBar } from './components/status/StatusBar';
import { SnackHost } from './components/common/SnackHost';
import { ServiceRequestPanel } from './components/request/ServiceRequestPanel';
import { SecurityAccessPanel } from './components/request/SecurityAccessPanel';
import { LibraryDialog } from './components/library/LibraryDialog';
import { ExportDialog } from './components/export/ExportDialog';
import { LogDialog } from './components/log/LogDialog';
import { getWsClient, sendCommand } from './ws/useWsConnection';
import { useResync } from './ws/useResync';
import { useHotkeys } from './hooks/useHotkeys';
import { useTraceStore } from './store/useTraceStore';
import { useUiStore } from './store/useUiStore';
import { useConnectionStore } from './store/useConnectionStore';
import { useLibraryStore } from './store/useLibraryStore';

/**
 * 应用根组件（T08 + T13/T14 装配）：五分区 + WebSocket + 全局快捷键。
 *
 * B 区 = 服务请求 / 安全解锁（双页签）；F 区 = 服务库编辑器（由工具栏按钮打开）。
 */
export function App(): JSX.Element {
  const { resyncNow } = useResync();
  const setPaused = useTraceStore((s) => s.setPaused);
  const clear = useTraceStore((s) => s.clear);
  const setFollow = useTraceStore((s) => s.setFollow);
  const autoFollow = useUiStore((s) => s.autoFollow);
  const openEditor = useLibraryStore((s) => s.openEditor);
  const simRunning = useConnectionStore((s) => s.sim?.running ?? false);
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  const exportOpen = useUiStore((s) => s.exportOpen);
  const setExportOpen = useUiStore((s) => s.setExportOpen);

  const [requestTab, setRequestTab] = useState<'request' | 'security'>('request');

  // 建立 WS 连接（单例，重连由 WsClient 内部负责）
  useEffect(() => {
    const client = getWsClient();
    client.connect();
    return () => {
      // ★热更新/卸载时不主动断开：整页卸载浏览器会自己关，避免 StrictMode 双挂载抖动
    };
  }, []);

  /**
   * ★QA 终验缺陷 3：`recommendedId` 取决于"仿真是否在跑"，
   *   所以仿真状态变化后必须重拉一次算法清单，否则默认仍是首连时（仿真未启动）算出的那个。
   */
  useEffect(() => {
    if (wsStatus !== 'open') return;
    sendCommand('keyAlgo.list', { level: 1 });
  }, [simRunning, wsStatus]);

  // 首连后拉一次服务库与算法清单（后端是唯一真源）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      sendCommand('library.get', {});
      sendCommand('keyAlgo.list', { level: 1 });
    }, TIMING.UI_BOOTSTRAP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  /**
   * ★N-01 缺口自愈轮询：周期取自 `TIMING.UI_RESYNC_POLL_INTERVAL_MS`（禁止裸写数字）。
   *
   * ★是否必要每轮都发 `session.hello`？**不必要**。
   *   hello 的语义是"从 lastSeq 之后补齐"，没有缺口时它没有可补的东西，
   *   却要让后端 ResyncService 每次都走一遍三分支判定（还会回一包 status 快照）。
   *   所以这里只在 `gaps.length > 0`（确实断过号）时才真正发起，
   *   平时这个定时器是空转的一次数组读——代价可以忽略。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (useTraceStore.getState().gaps.length === 0) return;
      resyncNow(true);
    }, TIMING.UI_RESYNC_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [resyncNow]);

  const hotkeys = useMemo(
    () => [
      { combo: 'space', handler: () => setPaused(!useTraceStore.getState().paused) },
      {
        combo: 'ctrl+l',
        handler: () => {
          clear();
        },
      },
      { combo: 'f', handler: () => setFollow(!useTraceStore.getState().follow) },
    ],
    [clear, setFollow, setPaused],
  );
  useHotkeys(hotkeys);

  useEffect(() => {
    setFollow(autoFollow);
  }, [autoFollow, setFollow]);

  const panelB = useMemo(
    () => (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Tabs
          value={requestTab}
          onChange={(_e, next: 'request' | 'security') => setRequestTab(next)}
          sx={{ minHeight: 32, borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab value="request" label="服务请求" sx={{ minHeight: 32, py: 0, fontSize: 12 }} />
          <Tab value="security" label="安全解锁 0x27" sx={{ minHeight: 32, py: 0, fontSize: 12 }} />
        </Tabs>
        <Box sx={{ flex: 1, minHeight: 0 }}>
          {requestTab === 'request' ? <ServiceRequestPanel /> : <SecurityAccessPanel />}
        </Box>
      </Box>
    ),
    [requestTab],
  );

  const onOpenLibrary = useCallback(() => {
    openEditor();
  }, [openEditor]);

  return (
    <>
      <AppShell
        toolbar={<TopToolbar onOpenLibrary={onOpenLibrary} />}
        panelA={<ConnectionPanel />}
        panelB={panelB}
        panelC={<TraceTable />}
        panelD={<DetailPanel />}
        statusBar={<StatusBar />}
      />
      <LibraryDialog />
      {/* ★T15：导出对话框全局只挂一份（状态栏与 C 区工具栏共用同一开关） */}
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      {/* 运行日志面板：全局单实例，任何入口（状态栏 / 工具栏 / 快捷键）都开这一个 */}
      <LogDialog />
      <SnackHost />
    </>
  );
}
