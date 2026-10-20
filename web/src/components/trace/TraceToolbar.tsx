import { Box, Button, Chip, Divider, Stack, Tooltip } from '@mui/material';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { sendCommand } from '../../ws/useWsConnection';
import { useTraceStore } from '../../store/useTraceStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { useUiStore } from '../../store/useUiStore';
import { notify } from '../common/SnackHost';
import { useT } from '../../i18n';
import type { RecordingStatus } from '@doip/shared';

/**
 * C 区工具栏（T10 + T15/T17）：暂停/继续、自动跟随、清除、录盘开关、导出对话框。
 */
export function TraceToolbar(): JSX.Element {
  const paused = useTraceStore((s) => s.paused);
  const setPaused = useTraceStore((s) => s.setPaused);
  const follow = useTraceStore((s) => s.follow);
  const setFollow = useTraceStore((s) => s.setFollow);
  const dropped = useTraceStore((s) => s.droppedWhilePaused);
  const clear = useTraceStore((s) => s.clear);
  const recording = useConnectionStore((s) => s.recording);
  const setExportOpen = useUiStore((s) => s.setExportOpen);
  const t = useT();

  const recordingOn = recording?.state === 'recording';

  return (
    <Stack direction="row" spacing={0.75} alignItems="center">
      <Tooltip title={paused ? t('继续摄入（Space）') : t('暂停摄入（Space）')}>
        <Button
          size="small"
          variant={paused ? 'contained' : 'outlined'}
          startIcon={paused ? <PlayArrowIcon fontSize="small" /> : <PauseIcon fontSize="small" />}
          onClick={() => setPaused(!paused)}
          sx={{ fontSize: 11, py: 0 }}
        >
          {paused ? t('继续') : t('暂停')}
        </Button>
      </Tooltip>

      <Tooltip title={t('自动滚动到最新行（上滚会临时脱离）')}>
        <Button
          size="small"
          variant={follow ? 'contained' : 'outlined'}
          startIcon={<VerticalAlignBottomIcon fontSize="small" />}
          onClick={() => setFollow(!follow)}
          sx={{ fontSize: 11, py: 0 }}
        >
          {t('跟随')}
        </Button>
      </Tooltip>

      <Tooltip title={t('清空前端缓冲（后端 trace.clear 同步执行）')}>
        <Button
          size="small"
          color="inherit"
          startIcon={<DeleteOutlineIcon fontSize="small" />}
          onClick={() => {
            clear();
            sendCommand('trace.clear', {});
          }}
          sx={{ fontSize: 11, py: 0 }}
        >
          {t('清除')}
        </Button>
      </Tooltip>

      <Divider orientation="vertical" flexItem />

      {/* ★T17：长挂机滚动落盘 —— 状态 / 开关 / 分片数 / 丢弃数一眼可见 */}
      <Tooltip
        title={
          recordingOn
            ? t('点击停止录制\n会话目录：{dir}\n当前分片：{file}\n分片数：{files}', {
                dir: recording?.sessionDir ?? '-',
                file: recording?.currentFile ?? '-',
                files: recording?.files.length ?? 0,
              })
            : t('点击开始录制（后端 RollingFileSink，WS 背压不影响落盘完整性）')
        }
      >
        <Chip
          size="small"
          label={recordingLabel(recording, t)}
          color={recording?.state === 'error' ? 'warning' : recordingOn ? 'error' : 'default'}
          variant={recordingOn ? 'filled' : 'outlined'}
          onClick={() => sendCommand(recordingOn ? 'record.stop' : 'record.start', {})}
          sx={{ height: 22, fontSize: 11 }}
        />
      </Tooltip>

      <Tooltip title={recording?.sessionDir ?? t('尚无落盘目录')}>
        <Button
          size="small"
          color="inherit"
          startIcon={<FolderOpenIcon fontSize="small" />}
          onClick={() => {
            if (recording?.sessionDir === null || recording?.sessionDir === undefined) {
              notify(t('尚无落盘目录（先开始录制）'), 'warn');
              return;
            }
            sendCommand('record.openDir', { dir: recording.sessionDir });
          }}
          sx={{ fontSize: 11, py: 0 }}
        >
          {t('打开目录')}
        </Button>
      </Tooltip>

      <Divider orientation="vertical" flexItem />

      <Tooltip title={t('导出 CSV / JSON / JSONL / HEX（可按过滤或 seq 区间）')}>
        <Button size="small" variant="outlined" onClick={() => setExportOpen(true)} sx={{ fontSize: 11, py: 0 }}>
          {t('导出…')}
        </Button>
      </Tooltip>


      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
        {(recording?.droppedCount ?? 0) > 0 ? (
          <Box component="span" sx={{ fontSize: 11, color: 'error.main' }} className="mono">
            {t('落盘丢弃 {count}', { count: recording?.droppedCount ?? 0 })}
          </Box>
        ) : null}
        {paused && dropped > 0 ? (
          <Box component="span" sx={{ fontSize: 11, color: 'warning.main' }} className="mono">
            {t('暂停期间丢弃 {count} 条', { count: dropped })}
          </Box>
        ) : null}
      </Box>
    </Stack>
  );
}

/** ★T17：录盘状态一行说清 —— 状态 / 条数 / 体积 / 分片数（/ 当前分片名） */
function recordingLabel(rec: RecordingStatus | null, t: ReturnType<typeof useT>): string {
  if (rec === null) return t('○ 未录制（未知）');
  const mb = rec.bytesWritten / (1024 * 1024);
  switch (rec.state) {
    case 'recording':
      return t('● 录制中 {entries} 条 / {mb} MB / {files} 片', {
        entries: rec.entriesWritten,
        mb: mb.toFixed(1),
        files: rec.files.length,
      });
    case 'stopped':
      return t('■ 已停止 {entries} 条 / {mb} MB / {files} 片', {
        entries: rec.entriesWritten,
        mb: mb.toFixed(1),
        files: rec.files.length,
      });
    case 'error':
      return t('⚠ 录制异常 {code}（已写 {entries} 条）', {
        code: rec.errorCode ?? '',
        entries: rec.entriesWritten,
      });
    default:
      return t('○ 未录制');
  }
}
