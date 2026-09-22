import { Box, IconButton, Paper, Stack, Tooltip, Typography } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useUiStore } from '../../store/useUiStore';
import { ErrorBoundary } from '../common/ErrorBoundary';

/**
 * 五分区栅格骨架（T08，PRD §6.1）：
 *
 *   ┌─────────────────── 顶部工具栏 ───────────────────┐
 *   │ A 连接/ECU │  B 服务请求（T13 占位）              │
 *   │            ├──────────────────────────────────── │
 *   │            │  C Trace 表格                       │
 *   │            ├──────────────────────────────────── │
 *   │            │  D 详情 / 解码树                     │
 *   ├────────────┴─────────────────────────────────────┤
 *   │ E 状态栏                                          │
 *   └──────────────────────────────────────────────────┘
 *
 * 左栏与下栏可折叠；折叠状态在 `useUiStore`。
 */

export function AppShell({
  toolbar,
  panelA,
  panelB,
  panelC,
  panelD,
  statusBar,
}: {
  toolbar: JSX.Element;
  panelA: JSX.Element;
  panelB: JSX.Element;
  panelC: JSX.Element;
  panelD: JSX.Element;
  statusBar: JSX.Element;
}): JSX.Element {
  const leftCollapsed = useUiStore((s) => s.leftCollapsed);
  const bottomCollapsed = useUiStore((s) => s.bottomCollapsed);
  const leftWidth = useUiStore((s) => s.leftWidth);
  const detailHeight = useUiStore((s) => s.detailHeight);
  const setLeftCollapsed = useUiStore((s) => s.setLeftCollapsed);
  const setBottomCollapsed = useUiStore((s) => s.setBottomCollapsed);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      {toolbar}

      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* A 区 */}
        <Box sx={{ width: leftCollapsed ? 32 : leftWidth, flexShrink: 0, position: 'relative' }}>
          {leftCollapsed ? (
            <Stack alignItems="center" sx={{ pt: 1 }}>
              <Tooltip title="展开连接面板">
                <IconButton size="small" onClick={() => setLeftCollapsed(false)}>
                  <ChevronRightIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Typography
                variant="caption"
                sx={{ writingMode: 'vertical-rl', mt: 1, color: 'text.secondary' }}
              >
                A 连接
              </Typography>
            </Stack>
          ) : (
            <Box sx={{ height: '100%', position: 'relative' }}>
              <ErrorBoundary zone="A 区连接面板">{panelA}</ErrorBoundary>
              <Tooltip title="折叠">
                <IconButton
                  size="small"
                  onClick={() => setLeftCollapsed(true)}
                  sx={{ position: 'absolute', top: 4, right: 4, zIndex: 2 }}
                >
                  <ChevronLeftIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>

        {/* 中右列：B / C / D */}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/*
            ★B 区高度不能低于 ~190px。
            曾写死 132px：扣掉 Tabs(32) + 工具栏(37) + 预览行(28) 后表单区只剩 ~60px，
            一个字段都放不下 → 用户看到的是「diagnosticSessionType 标签和下拉框被预览行拦腰裁掉」，
            原始 hex 输入框也同样被裁，看起来就像"不能自己输入报文"。
          */}
          <Box sx={{ height: 200, flexShrink: 0, borderBottom: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
            <ErrorBoundary zone="B 区服务请求">{panelB}</ErrorBoundary>
          </Box>

          <Box sx={{ flex: 1, minHeight: 0 }}>
            <ErrorBoundary zone="C 区 Trace">{panelC}</ErrorBoundary>
          </Box>

          <Box
            sx={{
              height: bottomCollapsed ? 30 : detailHeight,
              flexShrink: 0,
              borderTop: '1px solid',
              borderColor: 'divider',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <Paper
              square
              elevation={0}
              sx={{
                height: 26,
                px: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                bgcolor: 'background.paper',
                borderBottom: bottomCollapsed ? undefined : '1px solid',
                borderColor: 'divider',
              }}
            >
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                D 详情 / 响应解码树
              </Typography>
              <Box sx={{ ml: 'auto' }}>
                <Tooltip title={bottomCollapsed ? '展开' : '折叠'}>
                  <IconButton size="small" onClick={() => setBottomCollapsed(!bottomCollapsed)}>
                    {bottomCollapsed ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
                  </IconButton>
                </Tooltip>
              </Box>
            </Paper>
            {bottomCollapsed ? null : (
              <Box sx={{ flex: 1, minHeight: 0 }}>
                <ErrorBoundary zone="D 区详情">{panelD}</ErrorBoundary>
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      {/* E 区 */}
      <ErrorBoundary zone="E 区状态栏">{statusBar}</ErrorBoundary>
    </Box>
  );
}
