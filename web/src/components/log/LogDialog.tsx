import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import RefreshIcon from '@mui/icons-material/Refresh';
import ArticleIcon from '@mui/icons-material/Article';
import { LOGGING } from '@doip/shared';
import { useUiStore } from '../../store/useUiStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { sendCommand } from '../../ws/useWsConnection';
import { useT } from '../../i18n';

/**
 * 运行日志面板（自我排查）。
 *
 * 存在理由：工具出问题时（例如"目标主动拒绝 TCP 连接"），用户最需要的是
 * **能自己看到后端到底做了什么判断**。终端关掉后就没有留痕了，所以这里
 * 直接把 `~/.doip-console/logs/` 的尾部读进界面，并给出一键打开目录。
 *
 * 关键设计：
 * - 关闭状态下不轮询；打开时按 `LOGGING.FLUSH_INTERVAL_MS` 节流自动刷新。
 * - 「只看警告/错误」在本地过滤，不额外打后端。
 * - status 事件到达不会清空已有内容（在 store 侧处理），避免面板闪空白。
 */
export function LogDialog(): JSX.Element {
  const open = useUiStore((s) => s.logOpen);
  const status = useUiStore((s) => s.logStatus);
  const lines = useUiStore((s) => s.logLines);
  const truncated = useUiStore((s) => s.logTruncated);
  const setLogOpen = useUiStore((s) => s.setLogOpen);
  const wsStatus = useConnectionStore((s) => s.wsStatus);

  const [onlyErrors, setOnlyErrors] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const t = useT();

  // 打开时立即拉一次
  useEffect(() => {
    if (!open) return;
    sendCommand('log.tail', { lines: LOGGING.TAIL_DEFAULT_LINES });
  }, [open]);

  // 打开期间自动刷新（按后端刷盘间隔节流，避免打爆）
  useEffect(() => {
    if (!open || !autoRefresh) return;
    const timer = setInterval(() => {
      sendCommand('log.tail', { lines: LOGGING.TAIL_DEFAULT_LINES });
    }, LOGGING.FLUSH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [open, autoRefresh]);

  const visible = useMemo(
    () =>
      onlyErrors
        ? lines.filter((l) => l.includes('"level":"error"') || l.includes('"level":"warn"'))
        : lines,
    [lines, onlyErrors],
  );

  // 自动跟随到底部（只在自动刷新时跟随，避免用户手动往上翻被拽回）
  useEffect(() => {
    if (!open || !autoRefresh) return;
    const el = boxRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [visible, open, autoRefresh]);

  const refresh = (): void => {
    sendCommand('log.tail', { lines: LOGGING.TAIL_DEFAULT_LINES });
  };

  return (
    <Dialog open={open} onClose={() => setLogOpen(false)} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pb: 1 }}>
        <ArticleIcon fontSize="small" />
        {t('后端运行日志')}
        <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
          {status === null
            ? t('加载中…')
            : t('已记录 {lines} 行 · 当前文件 {bytes} B · 保留 {files} 个文件', {
                lines: status.lines,
                bytes: status.bytes,
                files: status.files.length,
              })}
        </Typography>
      </DialogTitle>

      <DialogContent dividers sx={{ pt: 1.5 }}>
        {status !== null && status.dropped > 0 && (
          <Alert severity="warning" sx={{ mb: 1.5 }}>
            {t('日志有 {count} 行因写入失败被丢弃（磁盘或权限问题），排查时请留意日志不完整。', {
              count: status.dropped,
            })}
          </Alert>
        )}
        {wsStatus !== 'open' && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {t('与后端的连接当前不是打开状态，显示的是上一次拉取的内容。')}
          </Alert>
        )}

        <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <FormControlLabel
            control={
              <Switch size="small" checked={onlyErrors} onChange={(e) => setOnlyErrors(e.target.checked)} />
            }
            label={<Typography variant="caption">{t('只看警告/错误')}</Typography>}
          />
          <FormControlLabel
            control={
              <Switch size="small" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            }
            label={<Typography variant="caption">{t('自动刷新')}</Typography>}
          />
          <Chip
            size="small"
            variant="outlined"
            label={truncated ? t('仅显示最近若干行') : t('已含全部现有日志')}
          />
        </Stack>

        <Box
          ref={boxRef}
          sx={{
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 11,
            lineHeight: 1.55,
            backgroundColor: 'background.default',
            border: '1px solid',
            borderColor: 'divider',
            borderRadius: 1,
            p: 1,
            maxHeight: 420,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {visible.length === 0 ? (
            <Typography variant="caption" color="text.secondary">
              {lines.length === 0 ? t('（暂无日志）') : t('（当前过滤条件下没有匹配行）')}
            </Typography>
          ) : (
            visible.map((line, i) => (
              <Box key={i} component="div" sx={{ color: lineColor(line) }}>
                {line}
              </Box>
            ))
          )}
        </Box>

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          {t('目录：{dir}', { dir: status?.dir ?? '—' })}
        </Typography>
      </DialogContent>

      <DialogActions>
        <Tooltip title={t('在文件管理器里打开日志目录')}>
          <Button
            size="small"
            startIcon={<FolderOpenIcon fontSize="small" />}
            onClick={() => sendCommand('log.openDir', {})}
          >
            {t('打开目录')}
          </Button>
        </Tooltip>
        <Button size="small" startIcon={<RefreshIcon fontSize="small" />} onClick={refresh}>
          {t('刷新')}
        </Button>
        <Button size="small" onClick={() => setLogOpen(false)}>
          {t('关闭')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** 按 level 着色：error 红、warn 橙，其余沿用主题前景色 */
function lineColor(line: string): string {
  if (line.includes('"level":"error"')) return 'error.light';
  if (line.includes('"level":"warn"')) return 'warning.light';
  return 'text.primary';
}
