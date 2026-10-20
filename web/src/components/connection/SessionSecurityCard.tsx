import { useEffect, useState } from 'react';
import { Box, Chip, FormControlLabel, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material';
import { TIMING } from '@doip/shared';
import { sendCommand } from '../../ws/useWsConnection';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useUiStore } from '../../store/useUiStore';
import { useT } from '../../i18n';

/**
 * 会话与解锁卡片（T11，A 区）：当前 UDS 会话、解锁等级、S3 倒计时、3E 心跳开关与周期。
 * ★US-6：倒计时可视化；周期可配（下界/上界取自 TIMING）。
 */
export function SessionSecurityCard(): JSX.Element {
  const status = useConnectionStore((s) => s.status);
  const periodMs = useUiStore((s) => s.testerPresentPeriodMs);
  const setPeriodMs = useUiStore((s) => s.setTesterPresentPeriodMs);
  const t = useT();

  const [s3Now, setS3Now] = useState<number | null>(status?.s3RemainingMs ?? null);

  // 本地倒计时：后端每秒推 status，这里只做平滑插值（不新增计时源）
  useEffect(() => {
    setS3Now(status?.s3RemainingMs ?? null);
    if (status?.s3RemainingMs === null || status?.s3RemainingMs === undefined) return;
    const timer = window.setInterval(() => {
      setS3Now((prev) => (prev === null ? null : Math.max(0, prev - TIMING.UI_S3_TICK_MS)));
    }, TIMING.UI_S3_TICK_MS);
    return () => window.clearInterval(timer);
  }, [status?.s3RemainingMs]);

  const enabled = status?.testerPresent.enabled ?? false;
  const s3Warn = s3Now !== null && s3Now <= TIMING.S3_WARN_THRESHOLD_MS;

  return (
    <Box>
      <Typography variant="caption" sx={{ fontWeight: 700 }}>
        {t('会话与解锁')}
      </Typography>

      <Stack direction="row" spacing={0.5} alignItems="center" sx={{ my: 0.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('当前会话')}
        </Typography>
        <Chip
          size="small"
          label={status?.udsSession ?? 'DEFAULT'}
          color={status?.udsSession === 'DEFAULT' ? 'default' : 'primary'}
          sx={{ height: 18, fontSize: 11 }}
        />
      </Stack>

      <Stack direction="row" spacing={0.5} alignItems="center">
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {t('解锁等级')}
        </Typography>
        {[1, 2, 3].map((level) => {
          const unlocked = status?.securityLevels.includes(level) ?? false;
          return (
            <Chip
              key={level}
              size="small"
              label={`Lv${level} ${unlocked ? '✓' : '✗'}`}
              color={unlocked ? 'success' : 'default'}
              variant={unlocked ? 'filled' : 'outlined'}
              sx={{ height: 18, fontSize: 11 }}
            />
          );
        })}
      </Stack>

      <Stack direction="row" spacing={2} sx={{ mt: 0.75 }}>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('S3 倒计时')}
          </Typography>
          <Typography
            variant="body2"
            className="mono"
            sx={{ color: s3Warn ? 'warning.main' : 'text.primary', fontWeight: 600 }}
          >
            {s3Now === null ? '-' : `${(s3Now / 1000).toFixed(1)} s`}
          </Typography>
        </Box>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {t('3E 心跳')}
          </Typography>
          <Typography variant="body2" className="mono" sx={{ fontWeight: 600 }}>
            {enabled ? t('▶ {seconds} s', { seconds: (periodMs / 1000).toFixed(1) }) : t('⏸ 已停')}
          </Typography>
        </Box>
      </Stack>

      <FormControlLabel
        sx={{ mt: 0.5 }}
        control={
          <Switch
            size="small"
            checked={enabled}
            onChange={(e) => sendCommand('testerPresent', { enable: e.target.checked, periodMs })}
          />
        }
        label={<Typography variant="caption">{t('自动 TesterPresent')}</Typography>}
      />

      <Tooltip
        title={t('范围 {min}–{max} ms', {
          min: TIMING.TESTER_PRESENT_MIN_PERIOD_MS,
          max: TIMING.TESTER_PRESENT_MAX_PERIOD_MS,
        })}
      >
        <TextField
          label={t('周期 (ms)')}
          size="small"
          value={periodMs}
          onChange={(e) => {
            const next = Number(e.target.value);
            if (!Number.isFinite(next)) return;
            const clamped = Math.min(
              TIMING.TESTER_PRESENT_MAX_PERIOD_MS,
              Math.max(TIMING.TESTER_PRESENT_MIN_PERIOD_MS, next),
            );
            setPeriodMs(clamped);
          }}
          onBlur={() => {
            if (enabled) sendCommand('testerPresent', { enable: true, periodMs });
          }}
          inputProps={{ inputMode: 'numeric', className: 'mono' }}
          sx={{ maxWidth: 140 }}
        />
      </Tooltip>
    </Box>
  );
}
