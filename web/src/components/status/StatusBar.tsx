import type { CSSProperties } from 'react';
import { Box, Chip, Divider, Paper, Stack, Tooltip } from '@mui/material';
import { TIMING } from '@doip/shared';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useTraceStore } from '../../store/useTraceStore';
import { useUiStore } from '../../store/useUiStore';
import { sendCommand } from '../../ws/useWsConnection';
import { stateColor } from '../../decode/displayStrings';

/**
 * E 区状态栏（T11，PRD §6.2）：7 项指标
 *  ① 连接状态灯 + 状态机节点名
 *  ② 路由激活状态与最近响应码
 *  ③ 当前 UDS 会话
 *  ④ 安全解锁等级
 *  ⑤ S3 倒计时 + TesterPresent 心跳开关与周期
 *  ⑥ TX/RX 计数、错误计数、最近 RTT
 *  ⑦ Trace 条数 + 清除/导出/跟随
 */
export function StatusBar(): JSX.Element {
  const status = useConnectionStore((s) => s.status);
  const recording = useConnectionStore((s) => s.recording);
  const entries = useTraceStore((s) => s.entries);
  const clear = useTraceStore((s) => s.clear);
  const follow = useTraceStore((s) => s.follow);
  const setFollow = useTraceStore((s) => s.setFollow);
  const gaps = useTraceStore((s) => s.gaps);
  /** ★D-03：后端断开后置 true —— 此时 status/sim 等字段不代表真值 */
  const stale = useConnectionStore((s) => s.stale);
  const setExportOpen = useUiStore((s) => s.setExportOpen);
  const setLogOpen = useUiStore((s) => s.setLogOpen);

  const connected = !stale && status !== null && status.state === 'ROUTING_ACTIVE';
  const s3 = stale ? null : (status?.s3RemainingMs ?? null);
  const s3Warn = s3 !== null && s3 <= TIMING.S3_WARN_THRESHOLD_MS;
  const tp = stale ? undefined : status?.testerPresent;
  const routingCode = stale ? null : (status?.lastRoutingCode ?? null);

  return (
    <Paper
      square
      elevation={0}
      sx={{
        height: 32,
        px: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        borderTop: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        fontSize: 11,
        overflow: 'hidden',
      }}
    >
      {/* ① 连接状态 */}
      <Stack direction="row" spacing={0.5} alignItems="center">
        <Box
          sx={{
            width: 9,
            height: 9,
            borderRadius: '50%',
            // ★D-03：断开时是"未知"，不是"已连接"也不是"已断开"——用灰色明确区分
            bgcolor: stale ? '#6b7280' : stateColor(status?.state ?? 'DISCONNECTED'),
          }}
        />
        <Box
          component="span"
          className="mono"
          {...(stale ? { sx: { color: 'text.disabled' } } : {})}
        >
          {stale ? '未知' : (status?.state ?? 'DISCONNECTED')}
        </Box>
      </Stack>
      {stale ? (
        <Chip
          size="small"
          color="warning"
          label="后端连接已断开 · 状态未知"
          sx={{ height: 16, fontSize: 10 }}
        />
      ) : null}

      <Divider orientation="vertical" flexItem />

      {/* ② 路由激活 */}
      <Field
        label="路由"
        value={
          routingCode === null || routingCode === undefined
            ? '-'
            : `0x${routingCode.toString(16).toUpperCase().padStart(2, '0')}`
        }
        tooltip={stale ? '后端已断开，路由激活状态未知' : (status?.lastRoutingCodeZh ?? undefined)}
        color={connected ? 'success.main' : 'text.secondary'}
      />

      {/* ③ UDS 会话 */}
      <Field label="会话" value={stale ? '未知' : (status?.udsSession ?? 'DEFAULT')} />

      {/* ④ 解锁等级 */}
      <Stack direction="row" spacing={0.25} alignItems="center">
        <Box component="span" sx={{ color: 'text.secondary' }}>
          解锁
        </Box>
        {[1, 2, 3].map((lv) => (
          <Chip
            key={lv}
            size="small"
            label={`Lv${lv}${status?.securityLevels.includes(lv) ? '✓' : '✗'}`}
            color={status?.securityLevels.includes(lv) ? 'success' : 'default'}
            variant={status?.securityLevels.includes(lv) ? 'filled' : 'outlined'}
            sx={{ height: 16, fontSize: 10 }}
          />
        ))}
      </Stack>

      <Divider orientation="vertical" flexItem />

      {/* ⑤ S3 倒计时 + 3E 心跳 */}
      <Field
        label="S3"
        value={s3 === null ? '-' : `${(s3 / 1000).toFixed(1)} s`}
        color={s3Warn ? 'warning.main' : 'text.primary'}
        tooltip="会话保持剩余时间（< 1 s 变橙预警）"
      />
      <Tooltip title="点击切换自动 TesterPresent">
        <Chip
          size="small"
          label={`3E ${tp?.enabled ? `▶ ${((tp.periodMs ?? TIMING.TESTER_PRESENT_PERIOD_MS) / 1000).toFixed(1)}s` : '⏸'}`}
          color={tp?.enabled ? 'primary' : 'default'}
          variant={tp?.enabled ? 'filled' : 'outlined'}
          onClick={() =>
            sendCommand('testerPresent', {
              enable: !(tp?.enabled ?? false),
              ...(tp?.periodMs === undefined ? {} : { periodMs: tp.periodMs }),
            })
          }
          sx={{ height: 18, fontSize: 10 }}
        />
      </Tooltip>

      <Divider orientation="vertical" flexItem />

      {/* ⑥ 计数与 RTT */}
      <Field label="TX" value={String(status?.counters.tx ?? 0)} />
      <Field label="RX" value={String(status?.counters.rx ?? 0)} />
      <Field
        label="错误"
        value={String(status?.counters.errors ?? 0)}
        color={(status?.counters.errors ?? 0) > 0 ? 'error.main' : 'text.primary'}
      />
      <Field
        label="RTT"
        value={status?.lastRttMs === null || status?.lastRttMs === undefined ? '-' : `${Math.round(status.lastRttMs)} ms`}
      />

      <Divider orientation="vertical" flexItem />

      {/* ⑦ Trace 条数 + 操作 */}
      <Field label="Trace" value={`${entries.length} 条`} />
      {gaps.length > 0 ? (
        <Tooltip title={gaps.map((g) => `seq ${g.fromSeq}–${g.toSeq}（${g.count} 条，${g.reason}）`).join('\n')}>
          <Chip size="small" color="warning" label={`缺口 ${gaps.length}`} sx={{ height: 16, fontSize: 10 }} />
        </Tooltip>
      ) : null}

      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {recording?.state === 'recording' ? (
          <Tooltip title={recording.sessionDir ?? ''}>
            <Chip
              size="small"
              color="error"
              label={`● 录制 ${recording.entriesWritten} 条 / ${(recording.bytesWritten / (1024 * 1024)).toFixed(1)} MB`}
              sx={{ height: 16, fontSize: 10 }}
            />
          </Tooltip>
        ) : null}
        <button
          type="button"
          onClick={() => {
            clear();
            sendCommand('trace.clear', {});
          }}
          style={chipStyle}
        >
          清除
        </button>
        <button type="button" onClick={() => setExportOpen(true)} style={chipStyle}>
          导出…
        </button>
        <Tooltip title="查看后端运行日志（自我排查：连接失败、超时、写盘异常等都有记录）">
          <button type="button" onClick={() => setLogOpen(true)} style={chipStyle}>
            日志
          </button>
        </Tooltip>
        <button type="button" onClick={() => setFollow(!follow)} style={chipStyle}>
          {follow ? '⏸ 跟随中' : '▶ 已脱离'}
        </button>
      </Box>
    </Paper>
  );
}

const chipStyle: CSSProperties = {
  background: '#1c2433',
  color: '#e6e9ef',
  border: '1px solid #2c3a52',
  borderRadius: 4,
  padding: '2px 8px',
  fontSize: 11,
  cursor: 'pointer',
};

function Field({
  label,
  value,
  color,
  tooltip,
}: {
  label: string;
  value: string;
  color?: string | undefined;
  tooltip?: string | undefined;
}): JSX.Element {
  const body = (
    <Stack direction="row" spacing={0.4} alignItems="baseline">
      <Box component="span" sx={{ color: 'text.secondary' }}>
        {label}
      </Box>
      <Box component="span" className="mono" sx={{ color: color ?? 'text.primary', fontWeight: 600 }}>
        {value}
      </Box>
    </Stack>
  );
  return tooltip === undefined ? body : <Tooltip title={tooltip}>{body}</Tooltip>;
}
