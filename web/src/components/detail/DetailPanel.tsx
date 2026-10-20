import { useMemo, useState } from 'react';
import { Box, Chip, Divider, Paper, Stack, Tab, Tabs, Typography } from '@mui/material';
import type { TraceEntry } from '@doip/shared';
import { useTraceStore } from '../../store/useTraceStore';
import { EmptyState } from '../common/EmptyState';
import { buildDecodeRows, DecodeTree } from './DecodeTree';
import { HexView } from './HexView';
import { ErrorExplainCard } from './ErrorExplainCard';
import { decodeSummary } from '../../decode/displayStrings';
import { useT } from '../../i18n';

const TXN_ROLE_KEYS: Record<string, '请求' | '响应' | '网关确认' | '网关拒绝' | '主动上报'> = {
  request: '请求',
  response: '响应',
  ack: '网关确认',
  nack: '网关拒绝',
  unsolicited: '主动上报',
};

/**
 * ★D-02：事务摘要条。
 * 之前耗时只存在于内存对象里，界面上没有任何出口 —— 现在 D 区明确显示
 * 事务 ID / 角色 / 耗时(ms) / 网关转发耗时(ms) / 配对行（可点击跳转）。
 */
function TxnSummary({
  entry,
  onJump,
}: {
  entry: TraceEntry;
  onJump: (seq: number) => void;
}): JSX.Element {
  const latency = entry.latencyMs;
  const gw = entry.gatewayForwardLatencyMs;
  const t = useT();
  const roleKey = entry.txnRole === null ? undefined : TXN_ROLE_KEYS[entry.txnRole];

  return (
    <Stack
      direction="row"
      spacing={1.5}
      alignItems="center"
      sx={{ px: 1, py: 0.25, borderBottom: '1px solid', borderColor: 'divider', flexWrap: 'wrap' }}
    >
      <Field label={t('事务')} value={entry.transactionId ?? '—'} />
      {entry.txnRole === null ? null : (
        <Field label={t('角色')} value={roleKey === undefined ? entry.txnRole : t(roleKey)} />
      )}
      <Field
        label={t('耗时(ms)')}
        value={latency === null ? '—' : latency.toFixed(1)}
        color={latency === null ? 'text.secondary' : 'success.main'}
      />
      <Field
        label={t('网关转发(ms)')}
        value={gw === null ? '—' : gw.toFixed(1)}
        color={gw === null ? 'text.secondary' : 'text.primary'}
      />
      {entry.linkedSeq === null ? null : (
        <button
          type="button"
          onClick={() => onJump(entry.linkedSeq ?? 0)}
          style={{
            background: '#1c2433',
            color: '#8ab4f8',
            border: '1px solid #2c3a52',
            borderRadius: 4,
            padding: '1px 6px',
            fontSize: 11,
            cursor: 'pointer',
          }}
          title={t('跳转到配对行')}
        >
          {t('配对行 → seq {seq}', { seq: entry.linkedSeq })}
        </button>
      )}
      {entry.timeout ? (
        <Chip size="small" color="error" label={t('超时')} sx={{ height: 16, fontSize: 10 }} />
      ) : null}
    </Stack>
  );
}

function Field({ label, value, color }: { label: string; value: string; color?: string }): JSX.Element {
  return (
    <Stack direction="row" spacing={0.4} alignItems="baseline">
      <Box component="span" sx={{ color: 'text.secondary', fontSize: 11 }}>
        {label}
      </Box>
      <Box
        component="span"
        className="mono"
        sx={{ color: color ?? 'text.primary', fontWeight: 600, fontSize: 11 }}
      >
        {value}
      </Box>
    </Stack>
  );
}

/**
 * D 区容器（T11）：三层解码树 + hex 双向高亮 + 错误解释卡。
 * 数据来自 C 区选中行（`selectedSeq`），不另起数据源。
 */
export function DetailPanel(): JSX.Element {
  const selectedSeq = useTraceStore((s) => s.selectedSeq);
  const entries = useTraceStore((s) => s.entries);
  const select = useTraceStore((s) => s.select);
  const [tab, setTab] = useState(0);
  const [highlight, setHighlight] = useState<[number, number] | null>(null);
  const [pickedOffset, setPickedOffset] = useState<number | null>(null);
  const t = useT();

  const entry = useMemo(
    () => (selectedSeq === null ? null : entries.find((e) => e.seq === selectedSeq) ?? null),
    [entries, selectedSeq],
  );

  const { rows } = useMemo(
    () => (entry === null ? { rows: [], udsBase: 0 } : buildDecodeRows(entry)),
    [entry],
  );

  /** hex 字节 → 反查字段（取覆盖该偏移的最深层节点） */
  const pickedRow = useMemo(() => {
    if (pickedOffset === null) return null;
    let best: (typeof rows)[number] | null = null;
    for (const r of rows) {
      if (pickedOffset >= r.offset && pickedOffset < r.offset + Math.max(1, r.length)) {
        if (best === null || r.depth >= best.depth) best = r;
      }
    }
    return best;
  }, [pickedOffset, rows]);

  if (entry === null) {
    return (
      <Paper square elevation={0} sx={{ height: '100%', bgcolor: 'background.paper' }}>
        <EmptyState
          title={t('未选择报文')}
          hint={t('在 C 区点击任意一行，这里显示三层解码、原始 hex 与错误解释')}
        />
      </Paper>
    );
  }

  return (
    <Paper square elevation={0} sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.paper' }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ px: 1, py: 0.25 }}>
        <Chip size="small" label={`seq ${entry.seq}`} sx={{ height: 18, fontSize: 11 }} />
        <Chip size="small" label={entry.direction} sx={{ height: 18, fontSize: 11 }} variant="outlined" />
        <Typography variant="caption" className="mono" sx={{ color: 'text.secondary' }}>
          {entry.doip.payloadTypeNameZh}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.primary', fontWeight: 600 }}>
          {decodeSummary(entry)}
        </Typography>
        {entry.transactionId === null ? null : (
          <Chip size="small" label={entry.transactionId} sx={{ height: 18, fontSize: 11 }} variant="outlined" />
        )}
      </Stack>

      {/* ★D-02：事务摘要 —— 耗时(ms) 必须在这里看得见（浏览器验收项） */}
      <TxnSummary entry={entry} onJump={select} />

      <Tabs
        value={tab}
        onChange={(_e, next: number) => setTab(next)}
        sx={{ minHeight: 28, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <Tab label={t('解码树')} sx={{ minHeight: 28, fontSize: 12, py: 0 }} />
        <Tab label="Hex" sx={{ minHeight: 28, fontSize: 12, py: 0 }} />
        <Tab label={t('错误解释')} sx={{ minHeight: 28, fontSize: 12, py: 0 }} />
      </Tabs>

      <Box sx={{ flex: 1, overflow: 'auto', p: 0.75, minHeight: 0 }}>
        {tab === 0 ? (
          <DecodeTree rows={rows} highlight={highlight} onHoverRange={(range) => setHighlight(range)} />
        ) : tab === 1 ? (
          <Stack spacing={0.5}>
            <HexView hex={entry.rawHex} highlight={highlight} onPickByte={setPickedOffset} />
            <Divider />
            {pickedRow === null ? (
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                {t('点击任意字节可反向定位到字段')}
              </Typography>
            ) : (
              <Typography variant="caption" className="mono">
                {t('偏移 {offset} → {field}（{hex}）{name}', {
                  offset: pickedOffset ?? 0,
                  field: pickedRow.field,
                  hex: pickedRow.valueHex,
                  name: pickedRow.nameZh ?? '',
                })}
              </Typography>
            )}
          </Stack>
        ) : (
          <ErrorExplainCard entry={entry} />
        )}
      </Box>
    </Paper>
  );
}
