import { useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { TIMING } from '@doip/shared';
import { useTraceStore } from '../../store/useTraceStore';
import { sendCommand } from '../../ws/useWsConnection';
import { notify } from '../common/SnackHost';

/**
 * T15 — 导出对话框。
 *
 * 四种格式（CSV / JSON / JSONL / HEXDump），三种范围：
 *   全部 / 当前过滤（把过滤栏表达式回传后端重放）/ 指定 seq 区间；
 * 可选「隐藏周期 3E」。
 *
 * ★下载走同源代理 `/api/download/:id`（Q11：后端只绑 127.0.0.1，开发期由 Vite 代理），
 *   收到 `export.ready` 后由 useWsConnection 统一触发浏览器下载。
 */

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
}

const FORMATS: Array<{ id: 'csv' | 'json' | 'jsonl' | 'hexdump'; label: string; hint: string }> = [
  { id: 'csv', label: 'CSV', hint: 'Excel 友好（UTF-8 BOM，26 列）' },
  { id: 'json', label: 'JSON', hint: '数组，逐字保留全部字段' },
  { id: 'jsonl', label: 'JSONL', hint: '与落盘分片同格式，可流式处理' },
  { id: 'hexdump', label: 'HEX', hint: '偏移 + ASCII 侧栏，肉眼比对用' },
];

export function ExportDialog({ open, onClose }: ExportDialogProps): JSX.Element {
  const [format, setFormat] = useState<ExportDialogFormat>('csv');
  const [scope, setScope] = useState<'all' | 'filtered' | 'selected'>('all');
  const [fromSeq, setFromSeq] = useState('');
  const [toSeq, setToSeq] = useState('');
  const [hidePeriodic, setHidePeriodic] = useState(false);
  const [busy, setBusy] = useState(false);

  const filterExpr = useTraceStore((s) => s.filterExpr);
  const firstSeq = useTraceStore((s) => s.firstSeq);
  const lastSeq = useTraceStore((s) => s.lastSeq);
  const entryCount = useTraceStore((s) => s.entries.length);

  const submit = (): void => {
    const trimmedFrom = fromSeq.trim();
    const trimmedTo = toSeq.trim();
    if (scope === 'selected') {
      const from = Number(trimmedFrom);
      const to = Number(trimmedTo);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
        notify('seq 区间非法（需要整数且 from ≤ to）', 'warn');
        return;
      }
    }
    setBusy(true);
    sendCommand('export.request', {
      format,
      scope,
      ...(scope === 'filtered' && filterExpr.trim() !== '' ? { filterExpr } : {}),
      ...(scope === 'selected'
        ? { seqRange: [Number(trimmedFrom), Number(trimmedTo)] as [number, number] }
        : {}),
      includeTags: { hidePeriodicTesterPresent: hidePeriodic },
    });
    // export.ready 到达后由 useWsConnection 触发下载；这里只做兜底解锁
    window.setTimeout(() => setBusy(false), TIMING.UI_EXPORT_UNLOCK_FALLBACK_MS);
    notify(`已请求导出 ${format.toUpperCase()}（${scopeLabel(scope)}）`, 'info');
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontSize: 14, py: 1 }}>导出 Trace（{entryCount} 条在缓冲）</DialogTitle>
      <DialogContent sx={{ px: 1.5 }}>
        <Stack spacing={1.25} sx={{ pt: 0.5 }}>
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
              格式
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={format}
              onChange={(_e, v: ExportDialogFormat | null) => {
                if (v !== null) setFormat(v);
              }}
            >
              {FORMATS.map((f) => (
                <ToggleButton key={f.id} value={f.id} sx={{ fontSize: 12, py: 0.25, px: 1.25 }}>
                  {f.label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.25 }}>
              {FORMATS.find((f) => f.id === format)?.hint}
            </Typography>
          </Box>

          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5 }}>
              范围
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              value={scope}
              onChange={(_e, v: 'all' | 'filtered' | 'selected' | null) => {
                if (v !== null) setScope(v);
              }}
            >
              <ToggleButton value="all" sx={{ fontSize: 12, py: 0.25, px: 1.25 }}>
                全部
              </ToggleButton>
              <ToggleButton value="filtered" sx={{ fontSize: 12, py: 0.25, px: 1.25 }}>
                当前过滤
              </ToggleButton>
              <ToggleButton value="selected" sx={{ fontSize: 12, py: 0.25, px: 1.25 }}>
                seq 区间
              </ToggleButton>
            </ToggleButtonGroup>
            {scope === 'filtered' ? (
              <Typography variant="caption" className="mono" sx={{ display: 'block', mt: 0.25, color: 'text.disabled' }}>
                表达式：{filterExpr.trim() === '' ? '（过滤栏为空 = 全部）' : filterExpr}
              </Typography>
            ) : null}
            {scope === 'selected' ? (
              <Stack direction="row" spacing={1} sx={{ mt: 0.75 }} alignItems="center">
                <TextField
                  size="small"
                  label="起始 seq"
                  placeholder={firstSeq === null ? '1' : String(firstSeq)}
                  value={fromSeq}
                  onChange={(e) => setFromSeq(e.target.value)}
                  sx={{ width: 130 }}
                  inputProps={{ className: 'mono', style: { fontSize: 12 } }}
                />
                <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                  →
                </Typography>
                <TextField
                  size="small"
                  label="结束 seq"
                  placeholder={lastSeq === null ? '' : String(lastSeq)}
                  value={toSeq}
                  onChange={(e) => setToSeq(e.target.value)}
                  sx={{ width: 130 }}
                  inputProps={{ className: 'mono', style: { fontSize: 12 } }}
                />
              </Stack>
            ) : null}
          </Box>

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={hidePeriodic}
                onChange={(e) => setHidePeriodic(e.target.checked)}
              />
            }
            sx={{ fontSize: 12 }}
            title="导出结果中剔除周期 TesterPresent（0x3E 0x80），减少噪音"
            label={<Typography variant="body2">隐藏周期 TesterPresent（0x3E 0x80）</Typography>}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 1.5, pb: 1 }}>
        <Button size="small" onClick={onClose} sx={{ fontSize: 12 }}>
          取消
        </Button>
        <Button size="small" variant="contained" disabled={busy} onClick={submit} sx={{ fontSize: 12 }}>
          {busy ? '导出中…' : '导出并下载'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type ExportDialogFormat = 'csv' | 'json' | 'jsonl' | 'hexdump';

function scopeLabel(scope: 'all' | 'filtered' | 'selected'): string {
  switch (scope) {
    case 'filtered':
      return '当前过滤';
    case 'selected':
      return 'seq 区间';
    default:
      return '全部';
  }
}
