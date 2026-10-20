import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Chip, Divider, IconButton, Menu, MenuItem, Stack, TextField, Tooltip } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { FILTER_PRESETS, isFilterExprValid } from '../../decode/filterExpression';
import { ROW_LEGEND, rowBackground } from '../../decode/colorRules';
import { useTraceStore } from '../../store/useTraceStore';
import { TRACE_COLUMNS, useUiStore } from '../../store/useUiStore';
import { notify } from '../common/SnackHost';
import { useT } from '../../i18n';
import type { TKey } from '../../i18n';

/**
 * 过滤栏（T10）：Wireshark 风格表达式 + 预设 chips + 列设置。
 * 非法表达式即时红框提示，且**不静默丢行**（表格按未过滤显示）。
 */
export function FilterBar(): JSX.Element {
  const filterExpr = useTraceStore((s) => s.filterExpr);
  const setFilterExpr = useTraceStore((s) => s.setFilterExpr);
  const hidePeriodic = useTraceStore((s) => s.hidePeriodicTesterPresent);
  const setHidePeriodic = useTraceStore((s) => s.setHidePeriodic);
  const entries = useTraceStore((s) => s.entries);
  const visibleColumns = useUiStore((s) => s.visibleColumns);
  const toggleColumn = useUiStore((s) => s.toggleColumn);
  const t = useT();

  /**
   * 预设/图例的 label 来自受控常量表（decode/ 下），全部已在字典登记；
   * 这里集中断言一次，避免在每个 map 里散落 as。
   */
  const labelOf = (label: string): string => t(label as TKey);

  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const valid = useMemo(() => isFilterExprValid(filterExpr), [filterExpr]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      sx={{ px: 1, py: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}
    >
      <TextField
        inputRef={inputRef}
        size="small"
        placeholder={t('过滤：doip.type == 0x8001 && uds.sid == 0x22')}
        value={filterExpr}
        onChange={(e) => setFilterExpr(e.target.value)}
        error={!valid}
        helperText={valid ? undefined : t('表达式无法解析（按未过滤显示）')}
        sx={{ flex: 1, maxWidth: 520 }}
        inputProps={{ className: 'mono', spellCheck: false }}
      />

      {FILTER_PRESETS.map((p) => (
        <Chip
          key={p.label}
          size="small"
          label={labelOf(p.label)}
          variant={filterExpr === p.expr ? 'filled' : 'outlined'}
          onClick={() => setFilterExpr(filterExpr === p.expr ? '' : p.expr)}
          sx={{ height: 22, fontSize: 11 }}
        />
      ))}

      <Chip
        size="small"
        label={t('隐藏周期 3E')}
        color={hidePeriodic ? 'primary' : 'default'}
        variant={hidePeriodic ? 'filled' : 'outlined'}
        onClick={() => setHidePeriodic(!hidePeriodic)}
        sx={{ height: 22, fontSize: 11 }}
      />

      <Tooltip title={t('复制当前过滤表达式')}>
        <IconButton
          size="small"
          onClick={() => {
            void navigator.clipboard.writeText(filterExpr);
            notify(t('已复制过滤表达式'), 'info');
          }}
          disabled={filterExpr === ''}
        >
          <ContentCopyIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <TypographyCount total={entries.length} />
        <Divider orientation="vertical" flexItem />
        <Chip
          size="small"
          label={t('列设置')}
          onClick={(e) => setAnchorEl(e.currentTarget)}
          sx={{ height: 22, fontSize: 11 }}
        />
        <Menu anchorEl={anchorEl} open={anchorEl !== null} onClose={() => setAnchorEl(null)}>
          {TRACE_COLUMNS.map((c) => (
            <MenuItem
              key={c.id}
              dense
              onClick={() => toggleColumn(c.id)}
              sx={{ fontSize: 12 }}
            >
              <Box
                sx={{
                  width: 10,
                  height: 10,
                  borderRadius: '2px',
                  mr: 1,
                  border: '1px solid #6b7280',
                  bgcolor: visibleColumns.includes(c.id) ? 'primary.main' : 'transparent',
                }}
              />
              {c.label}
            </MenuItem>
          ))}
          <Divider />
          <Box sx={{ px: 1.5, py: 0.5 }}>
            {ROW_LEGEND.map((l) => (
              <Stack key={l.kind} direction="row" spacing={0.75} alignItems="center" sx={{ py: 0.1 }}>
                <Box
                  sx={{
                    width: 22,
                    height: 10,
                    borderRadius: '2px',
                    bgcolor: rowBackground(l.kind),
                    border: '1px solid #2c3446',
                  }}
                />
                <Box component="span" sx={{ fontSize: 11, color: 'text.secondary' }}>
                  {labelOf(l.label)}
                </Box>
              </Stack>
            ))}
          </Box>
        </Menu>
      </Box>
    </Stack>
  );
}

function TypographyCount({ total }: { total: number }): JSX.Element {
  const t = useT();
  return (
    <Box component="span" sx={{ fontSize: 11, color: 'text.secondary' }} className="mono">
      {t('缓冲 {total}', { total })}
    </Box>
  );
}
