import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { sendCommand } from '../../ws/useWsConnection';
import { useConnectionStore } from '../../store/useConnectionStore';
import { notify } from '../common/SnackHost';
import { HexInput } from '../common/HexInput';

/**
 * 故障注入弹窗（T11，§3.10）：可让仿真 ECU 返回指定 NRC / NACK / 不响应 / 延迟 / 自定义 hex。
 * 规则结构与后端 `FaultRule` 逐字一致，避免二次映射。
 */

type ActionKind = 'nrc' | 'nack' | 'noResponse' | 'delayMs' | 'customHex' | 'routingCode';

const ACTION_LABELS: Record<ActionKind, string> = {
  nrc: '返回指定 NRC',
  nack: '返回 NACK（网关未转发）',
  noResponse: '不响应（触发 P2 超时）',
  delayMs: '延迟响应（先 7F xx 78）',
  customHex: '原样返回自定义 hex',
  routingCode: '路由激活强制返回码',
};

export function FaultInjectDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element {
  const [enabled, setEnabled] = useState(true);
  const [kind, setKind] = useState<ActionKind>('nrc');
  const [sid, setSid] = useState('0x22');
  const [code, setCode] = useState('0x22');
  const [delayMs, setDelayMs] = useState('800');
  const [customHex, setCustomHex] = useState('7F 22 22');
  const [remaining, setRemaining] = useState('1');

  const handleApply = (): void => {
    const action =
      kind === 'nrc'
        ? { kind: 'nrc' as const, code }
        : kind === 'nack'
          ? { kind: 'nack' as const, code }
          : kind === 'noResponse'
            ? { kind: 'noResponse' as const }
            : kind === 'delayMs'
              ? { kind: 'delayMs' as const, ms: Number(delayMs) }
              : kind === 'customHex'
                ? { kind: 'customHex' as const, hex: customHex }
                : { kind: 'routingCode' as const, code };

    const rule = {
      id: `ui-${Date.now()}`,
      enabled,
      match: sid.trim() === '' ? {} : { sid },
      action,
      remaining: remaining === '' ? null : Number(remaining),
    };
    sendCommand('sim.injectFault', { rules: [rule] as never });
    notify('故障注入规则已下发（下一次匹配的请求生效）', 'info');
    onClose();
  };

  const handleClear = (): void => {
    sendCommand('sim.injectFault', { rules: [] });
    notify('已清除全部故障注入规则', 'info');
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontSize: 15 }}>故障注入（仿真 ECU）</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.5} sx={{ mt: 0.5 }}>
          <FormControlLabel
            control={<Switch checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />}
            label={<Typography variant="body2">启用该规则</Typography>}
          />
          <Box sx={{ display: 'flex', gap: 1 }}>
            <HexInput label="匹配 SID（可空=全部）" value={sid} onChange={setSid} expectedBytes={1} />
            <TextField
              label="生效次数（空=无限）"
              value={remaining}
              onChange={(e) => setRemaining(e.target.value)}
              size="small"
              inputProps={{ inputMode: 'numeric', className: 'mono' }}
            />
          </Box>
          <TextField
            select
            label="注入动作"
            value={kind}
            onChange={(e) => setKind(e.target.value as ActionKind)}
            size="small"
          >
            {(Object.keys(ACTION_LABELS) as ActionKind[]).map((k) => (
              <MenuItem key={k} value={k}>
                {ACTION_LABELS[k]}
              </MenuItem>
            ))}
          </TextField>

          {(kind === 'nrc' || kind === 'nack' || kind === 'routingCode') && (
            <HexInput
              label={kind === 'routingCode' ? '路由激活响应码' : 'NRC / NACK 码'}
              value={code}
              onChange={setCode}
              expectedBytes={1}
            />
          )}
          {kind === 'delayMs' && (
            <TextField
              label="延迟（ms）"
              value={delayMs}
              onChange={(e) => setDelayMs(e.target.value)}
              size="small"
              inputProps={{ inputMode: 'numeric', className: 'mono' }}
            />
          )}
          {kind === 'customHex' && <HexInput label="自定义响应 hex" value={customHex} onChange={setCustomHex} />}

          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {[
              '0x11 服务不支持',
              '0x22 条件不满足',
              '0x31 请求越界',
              '0x33 安全访问拒绝',
              '0x78 待响应',
            ].map((t) => (
              <Chip key={t} size="small" label={t} sx={{ fontSize: 11 }} />
            ))}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button size="small" color="inherit" onClick={handleClear}>
          清除规则
        </Button>
        <Button size="small" variant="contained" onClick={handleApply}>
          下发
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** 仿真启停（A 区底部） */
export function SimEcuControl(): JSX.Element {
  const sim = useConnectionStore((s) => s.sim);
  const [dialogOpen, setDialogOpen] = useState(false);
  const running = sim?.running ?? false;

  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button
          size="small"
          variant="contained"
          disabled={running}
          onClick={() => sendCommand('sim.start', {})}
        >
          启动
        </Button>
        <Button size="small" color="inherit" disabled={!running} onClick={() => sendCommand('sim.stop', {})}>
          停止
        </Button>
        <Button size="small" color="inherit" onClick={() => setDialogOpen(true)}>
          故障注入…
        </Button>
      </Stack>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {running
          ? `仿真运行中，端口 ${sim?.port ?? '-'}，实体 ${sim?.entities.length ?? 0} 个${sim?.isolatedProcess ? '（独立子进程）' : ''}`
          : '仿真未启动'}
      </Typography>
      <FaultInjectDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </Box>
  );
}
