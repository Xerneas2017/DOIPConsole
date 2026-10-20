import { Box, Button, Stack, Tooltip, Typography } from '@mui/material';
import { TIMING } from '@doip/shared';
import { sendCommand } from '../../ws/useWsConnection';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useT } from '../../i18n';

/**
 * ★协议完整度补齐：DoIP 传输层诊断卡片（A 区，路由激活卡片下方）。
 *
 * 覆盖 ISO 13400-2 三条此前只在仿真侧实现、tester 侧无入口的管理报文：
 *  - Alive Check（TCP 0x0007 → 0x0008）：验证当前 socket 与路由是否存活；
 *  - 实体状态（UDP 0x4001 → 0x4002）：节点类型 / 并发容量 / 当前连接数 / 最大数据长度；
 *  - 电源模式（UDP 0x4003 → 0x4004）：ECU 是否就绪。
 *
 * ★Q1：所有操作均不自动重试，失败只回错误与处置建议。
 */
export function TransportDiagCard(): JSX.Element {
  const status = useConnectionStore((s) => s.status);
  const aliveCheck = useConnectionStore((s) => s.aliveCheck);
  const entityStatus = useConnectionStore((s) => s.entityStatus);
  const powerMode = useConnectionStore((s) => s.powerMode);
  const diagBusy = useConnectionStore((s) => s.diagBusy);
  const t = useT();

  const connected = status !== null && status.state === 'ROUTING_ACTIVE';

  const handleAliveCheck = (): void => {
    useConnectionStore.getState().setDiagBusy(true);
    sendCommand('aliveCheck.request', {});
  };

  const handleEntityStatus = (): void => {
    useConnectionStore.getState().setDiagBusy(true);
    sendCommand('entityStatus.request', {});
  };

  const handlePowerMode = (): void => {
    useConnectionStore.getState().setDiagBusy(true);
    sendCommand('powerMode.request', {});
  };

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="caption" sx={{ fontWeight: 700 }}>
          {t('传输层诊断')}
        </Typography>
        <Tooltip title={t('Alive Check 走当前 TCP 连接；实体状态与电源模式走 UDP（缺省问当前连接目标）')}>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            0x0007 / 0x4001 / 0x4003
          </Typography>
        </Tooltip>
      </Stack>

      <Stack direction="row" spacing={1} sx={{ mb: 0.5 }}>
        <Tooltip
          title={
            connected
              ? t('发送 0x0007 并等待 0x0008（超时 {ms} ms，不自动重试）', { ms: TIMING.ALIVE_CHECK_TIMEOUT_MS })
              : t('需先连接并激活路由')
          }
        >
          <span>
            <Button size="small" variant="outlined" disabled={!connected || diagBusy} onClick={handleAliveCheck}>
              Alive Check
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={t('UDP 询问实体状态（0x4001 → 0x4002）：节点类型 / 并发容量 / 当前连接数')}>
          <span>
            <Button size="small" variant="outlined" disabled={diagBusy} onClick={handleEntityStatus}>
              {t('实体状态')}
            </Button>
          </span>
        </Tooltip>
        <Tooltip title={t('UDP 询问电源模式（0x4003 → 0x4004）：ECU 是否就绪')}>
          <span>
            <Button size="small" variant="outlined" disabled={diagBusy} onClick={handlePowerMode}>
              {t('电源模式')}
            </Button>
          </span>
        </Tooltip>
      </Stack>

      <Stack spacing={0.25}>
        <Row
          label="Alive Check"
          value={
            aliveCheck === null
              ? '-'
              : t('存活 SA=0x{sa}（{ms} ms）', {
                  sa: aliveCheck.sourceAddress.toString(16).toUpperCase().padStart(4, '0'),
                  ms: aliveCheck.latencyMs,
                })
          }
          ok={aliveCheck !== null}
        />
        <Row
          label={t('实体状态')}
          value={
            entityStatus === null
              ? '-'
              : t('{nodeType} 当前 {open}/{max} 连接', {
                  nodeType: entityStatus.nodeTypeNameZh,
                  open: entityStatus.currentlyOpenSockets,
                  max: entityStatus.maxConcurrentSockets,
                })
          }
          ok={entityStatus !== null}
        />
        <Row
          label={t('电源模式')}
          value={powerMode === null ? '-' : powerMode.powerModeNameZh}
          ok={powerMode !== null && powerMode.powerMode === 0x02}
        />
      </Stack>
    </Box>
  );
}

function Row({ label, value, ok }: { label: string; value: string; ok: boolean }): JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between">
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography
        variant="caption"
        className="mono"
        sx={{ color: ok ? 'success.main' : 'text.primary' }}
      >
        {value}
      </Typography>
    </Stack>
  );
}
