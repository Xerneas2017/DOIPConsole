import { Box, Button, Stack, Tooltip, Typography } from '@mui/material';
import { TIMING } from '@doip/shared';
import { sendCommand } from '../../ws/useWsConnection';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useUiStore } from '../../store/useUiStore';
import { useT } from '../../i18n';

/**
 * 路由激活卡片（T11，A 区）：SA/TA/激活类型/协议版本 + 最近响应码 + [重激活]。
 * ★Q1：不自动重连、不自动重发；「重激活」是唯一允许的手动重发。
 */
export function RoutingActivationCard(): JSX.Element {
  const status = useConnectionStore((s) => s.status);
  const ui = useUiStore();
  const t = useT();

  const active = status?.state === 'ROUTING_ACTIVE';
  const code = status?.lastRoutingCode ?? null;
  const codeZh = status?.lastRoutingCodeZh ?? null;

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="caption" sx={{ fontWeight: 700 }}>
          {t('路由激活')}
        </Typography>
        <Box
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: active ? 'success.main' : 'text.disabled',
          }}
        />
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {status?.state ?? 'DISCONNECTED'}
        </Typography>
      </Stack>

      <Stack spacing={0.25}>
        <Row label="SA" value={status === null ? ui.sa : `0x${status.sa.toString(16).toUpperCase().padStart(4, '0')}`} />
        <Row label="TA" value={status === null ? ui.ta : `0x${status.ta.toString(16).toUpperCase().padStart(4, '0')}`} />
        <Row
          label={t('激活类型')}
          value={status === null ? '-' : `0x${status.activationType.toString(16).toUpperCase().padStart(2, '0')}`}
        />
        <Row label={t('协议版本')} value={status === null ? '-' : `0x0${status.protocolVersion}`} />
        <Row
          label={t('最近响应码')}
          value={code === null ? '-' : `0x${code.toString(16).toUpperCase().padStart(2, '0')} ${codeZh ?? ''}`}
          color={active ? 'success.main' : code === null ? undefined : 'warning.main'}
        />
      </Stack>

      <Stack direction="row" spacing={1} sx={{ mt: 0.75 }}>
        <Tooltip
          title={
            active
              ? t('同一 socket 上重发 0x0005（最小间隔 {ms} ms）', { ms: TIMING.ROUTING_REACTIVATE_MIN_INTERVAL_MS })
              : t('仅在已建立 TCP 连接后可用')
          }
        >
          <span>
            <Button
              size="small"
              variant="outlined"
              disabled={!active}
              onClick={() => sendCommand('routing.reactivate', {})}
            >
              {t('重激活')}
            </Button>
          </span>
        </Tooltip>
      </Stack>
    </Box>
  );
}

function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string | undefined;
}): JSX.Element {
  return (
    <Stack direction="row" justifyContent="space-between">
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
      <Typography variant="caption" className="mono" sx={{ color: color ?? 'text.primary' }}>
        {value}
      </Typography>
    </Stack>
  );
}
