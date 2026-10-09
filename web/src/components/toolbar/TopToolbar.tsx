import { useEffect, useMemo } from 'react';
import { Box, Paper, ToggleButton, ToggleButtonGroup, Tooltip, Typography } from '@mui/material';
import { TIMING } from '@doip/shared';
import { sendCommand } from '../../ws/useWsConnection';
import { useConnectionStore, WS_STATUS_LABEL } from '../../store/useConnectionStore';
import { useUiStore } from '../../store/useUiStore';

/**
 * 顶部工具栏（T11）：模式切换、目标 IP/端口、连接/断开、发现扫描、服务库。
 * ★Q11：后端只监听 127.0.0.1，仿真模式默认指向本机仿真端口。
 */
export function TopToolbar({ onOpenLibrary }: { onOpenLibrary?: () => void }): JSX.Element {
  const status = useConnectionStore((s) => s.status);
  const wsStatus = useConnectionStore((s) => s.wsStatus);
  /** ★裁定①：断线归因文案（null=无异常） */
  const wsDetail = useConnectionStore((s) => s.wsDetail);
  const scanning = useConnectionStore((s) => s.scanning);
  /** ★仿真是否在跑：决定「连接」要不要先自动启动仿真 */
  const simRunning = useConnectionStore((s) => s.sim?.running ?? false);
  const ui = useUiStore();

  const connected = status !== null && status.state === 'ROUTING_ACTIVE';
  const busy = status !== null && (status.state === 'TCP_CONNECTING' || status.state === 'ROUTING_ACTIVATING');

  const connectLabel = useMemo(() => {
    if (busy) return '连接中…';
    if (connected) return '断开';
    return '连接';
  }, [busy, connected]);

  const handleConnect = (): void => {
    if (connected) {
      sendCommand('disconnect', { reason: 'user-disconnect' });
      return;
    }
    /**
     * ★仿真模式下若仿真 ECU 还没起来，先把它拉起来再连。
     *
     * 为什么必须这么做：实测用户会直接点「连接」（在工具栏里始终可见），而左侧面板的
     * 「启动」按钮在较矮窗口下会被挤到可视区外。结果就是 13401 上没人监听，报
     * `目标主动拒绝 TCP 连接`，用户以为是工具坏了。
     * 用户已明确选「仿真 ECU」并点了连接，意图无歧义 —— 这里自动补上启动这一步，
     * 等仿真真的起来（收到 sim.status.running）再发 connect.request。
     */
    if (ui.mode === 'sim' && !simRunning) {
      const conn = useConnectionStore.getState();
      ui.setAutoConnectPending(true);
      conn.pushError({
        code: 'E_SIM_AUTOSTART',
        messageZh: '仿真 ECU 尚未启动，正在自动启动后再连接…',
        severity: 'info',
      });
      sendCommand('sim.start', {});
      return;
    }
    sendCommand('connect.request', {
      mode: ui.mode,
      host: ui.targetHost,
      port: ui.targetPort,
      sa: ui.sa,
      ta: ui.ta,
    });
  };

  /**
   * 自动连接：仿真就绪后，把挂起的那次连接补发出去。
   *
   * 只在 `autoConnectPending` 为真时触发一次，随后立即清标记，
   * 避免之后每次仿真状态变化都误发连接。
   */
  useEffect(() => {
    if (!ui.autoConnectPending || !simRunning) return;
    ui.setAutoConnectPending(false);
    const conn = useConnectionStore.getState();
    // 仿真可能顺延到别的端口（13401 被占时），用实际端口连，避免又连错端口
    const simPort = conn.sim?.port ?? ui.targetPort;
    if (simPort !== ui.targetPort) ui.setTarget({ port: simPort });
    conn.pushError({
      code: 'E_SIM_AUTOSTART',
      messageZh: `仿真 ECU 已启动（端口 ${simPort}），正在连接…`,
      severity: 'info',
    });
    sendCommand('connect.request', {
      mode: ui.mode,
      host: ui.targetHost,
      port: simPort,
      sa: ui.sa,
      ta: ui.ta,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.autoConnectPending, simRunning]);

  const handleScan = (): void => {
    useConnectionStore.getState().setScanning(true);
    sendCommand('scan.request', { timeoutMs: TIMING.UDP_UNICAST_RESPONSE_TIMEOUT_MS });
  };

  return (
    <Paper
      square
      elevation={0}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 1.5,
        py: 0.75,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Typography variant="subtitle2" sx={{ fontWeight: 700, letterSpacing: 0.3 }}>
        DoIP 诊断控制台
      </Typography>

      <ToggleButtonGroup
        size="small"
        exclusive
        value={ui.mode}
        onChange={(_e, next: 'real' | 'sim' | null) => {
          if (next === null) return;
          ui.setTarget(next === 'sim' ? { mode: next, host: '127.0.0.1' } : { mode: next });
        }}
      >
        <ToggleButton value="real" sx={{ px: 1.25, py: 0.25, fontSize: 12 }}>
          真实 ECU
        </ToggleButton>
        <ToggleButton value="sim" sx={{ px: 1.25, py: 0.25, fontSize: 12 }}>
          仿真 ECU
        </ToggleButton>
      </ToggleButtonGroup>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          目标
        </Typography>
        <input
          className="mono"
          value={ui.targetHost}
          onChange={(e) => ui.setTarget({ host: e.target.value })}
          style={{
            width: 128,
            background: '#0f1115',
            color: '#e6e9ef',
            border: '1px solid #262b36',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 12,
          }}
        />
        <input
          className="mono"
          type="number"
          value={ui.targetPort}
          onChange={(e) => ui.setTarget({ port: Number(e.target.value) })}
          style={{
            width: 72,
            background: '#0f1115',
            color: '#e6e9ef',
            border: '1px solid #262b36',
            borderRadius: 4,
            padding: '2px 6px',
            fontSize: 12,
          }}
        />
      </Box>

      <button
        type="button"
        onClick={handleConnect}
        disabled={wsStatus !== 'open' || busy}
        style={{
          background: connected ? '#4a1414' : '#1f4f8f',
          color: '#e6e9ef',
          border: '1px solid #2c3a52',
          borderRadius: 4,
          padding: '4px 14px',
          fontSize: 12,
          cursor: wsStatus === 'open' && !busy ? 'pointer' : 'not-allowed',
        }}
      >
        {connectLabel}
      </button>

      <button
        type="button"
        onClick={handleScan}
        disabled={wsStatus !== 'open' || scanning}
        style={{
          background: '#1c2433',
          color: '#e6e9ef',
          border: '1px solid #2c3a52',
          borderRadius: 4,
          padding: '4px 12px',
          fontSize: 12,
          cursor: wsStatus === 'open' && !scanning ? 'pointer' : 'not-allowed',
        }}
      >
        {scanning ? '扫描中…' : '车辆发现'}
      </button>

      <button
        type="button"
        onClick={() => onOpenLibrary?.()}
        style={{
          background: '#1c2433',
          color: '#e6e9ef',
          border: '1px solid #2c3a52',
          borderRadius: 4,
          padding: '4px 12px',
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        服务库
      </button>

      {/**
       * ★裁定①：WS 状态 + 断线归因必须显式可见。
       * 自动重连保留（传输层豁免），但"为什么断、第几次尝试、不会补发业务请求"要写在界面上，
       * 让用户始终知道当前数据是否可信。
       */}
      <Tooltip
        title={
          wsDetail === null
            ? `WebSocket：${WS_STATUS_LABEL[wsStatus]}（${wsStatus}）`
            : `WebSocket：${WS_STATUS_LABEL[wsStatus]}（${wsStatus}）\n${wsDetail}`
        }
      >
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              flexShrink: 0,
              bgcolor: wsStatus === 'open' ? 'success.main' : wsStatus === 'closed' ? 'error.main' : 'warning.main',
            }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
            {WS_STATUS_LABEL[wsStatus]}
          </Typography>
          {wsDetail !== null ? (
            <Typography
              variant="caption"
              sx={{ color: wsStatus === 'closed' ? 'error.main' : 'warning.main', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}
            >
              {wsDetail}
            </Typography>
          ) : null}
        </Box>
      </Tooltip>
    </Paper>
  );
}
