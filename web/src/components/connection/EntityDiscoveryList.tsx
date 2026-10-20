import { Box, Button, Chip, Stack, Tooltip, Typography } from '@mui/material';
import type { DiscoveredEntity } from '@doip/shared';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useUiStore } from '../../store/useUiStore';
import { useT } from '../../i18n';
import { EmptyState } from '../common/EmptyState';

/**
 * 已发现实体列表（T11，A 区）：VIN / EID / GID / LA，点「连」带入 IP 与 TA。
 */
export function EntityDiscoveryList(): JSX.Element {
  const entities = useConnectionStore((s) => s.entities);
  const scanning = useConnectionStore((s) => s.scanning);
  const ui = useUiStore();
  const t = useT();

  if (entities.length === 0) {
    return (
      <EmptyState
        height={120}
        title={scanning ? t('正在扫描…') : t('暂无发现结果')}
        hint={t('点击顶部「车辆发现」发起 UDP 车辆识别请求（0x0001 → 0x0004）')}
      />
    );
  }

  return (
    <Stack spacing={0.5}>
      {entities.map((e: DiscoveredEntity) => (
        <Box
          key={`${e.vin}-${e.logicalAddress}-${e.ip}`}
          sx={{
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            p: 0.75,
            '&:hover': { borderColor: 'primary.main' },
          }}
        >
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography variant="caption" className="mono" sx={{ fontWeight: 700 }}>
              {e.logicalAddress}
            </Typography>
            {e.isSimulated ? <Chip size="small" label={t('仿真')} sx={{ height: 16, fontSize: 10 }} /> : null}
            <Chip
              size="small"
              label={e.nodeType}
              sx={{ height: 16, fontSize: 10 }}
              variant="outlined"
            />
            <Box sx={{ ml: 'auto' }}>
              <Tooltip title={t('带入 {endpoint}', { endpoint: `${e.ip}:${e.port}` })}>
                <Button
                  size="small"
                  variant="outlined"
                  sx={{ minWidth: 32, px: 0.75, py: 0, fontSize: 11 }}
                  onClick={() => ui.setTarget({ host: e.ip, port: e.port, ta: e.logicalAddress })}
                >
                  {t('连')}
                </Button>
              </Tooltip>
            </Box>
          </Stack>
          <Typography variant="caption" className="mono" sx={{ color: 'text.secondary' }}>
            VIN {e.vin}
          </Typography>
          <Typography
            variant="caption"
            className="mono"
            sx={{ color: 'text.secondary', display: 'block', fontSize: 10 }}
          >
            EID {e.eid.slice(0, 12)}… GID {e.gid.slice(0, 12)}…
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}
