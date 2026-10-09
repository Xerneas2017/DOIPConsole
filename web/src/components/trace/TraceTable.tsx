import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Menu, MenuItem, Stack, Typography } from '@mui/material';
import { useTraceStore } from '../../store/useTraceStore';
import { TRACE_COLUMNS, useUiStore } from '../../store/useUiStore';
import { useFilteredRows } from './useFilteredRows';
import { useVirtualRows, ROW_HEIGHT } from './useVirtualRows';
import { TraceRow } from './TraceRow';
import { FilterBar } from './FilterBar';
import { TraceToolbar } from './TraceToolbar';
import { EmptyState } from '../common/EmptyState';
import { buildDisplayRows } from './gapMerge';
import type { MergedRow } from './gapMerge';
import { decodeSummary, rawHexDisplay } from '../../decode/displayStrings';
import { notify } from '../common/SnackHost';

/**
 * C 区 Trace 表格（T10）。
 *
 * - 虚拟滚动：`useVirtualRows`（@tanstack/react-virtual），1 万行只渲染视口内 ~30 行；
 * - 缺口灰条：后端 `trace.gap` 与本地断号检测合并显示，seq 链条不断；
 * - 右键菜单：复制行 / hex / 解码串 / 跳转 seq；「以此为模板新建请求」在 T13 前置灰。
 */

/**
 * ★D-04：虚拟滚动容器的最小可视高度（= 6 行）。
 * 父级 `flex:1` 在矮视口下会把容器压成个位数像素，行全被裁掉；
 * 这里用 `minHeight` 兜底，宁可让外层出滚动条，也不能出现"有数据但看不到行"。
 */
const MIN_VIEWPORT_HEIGHT = ROW_HEIGHT * 6;

export function TraceTable(): JSX.Element {
  const entries = useTraceStore((s) => s.entries);
  const gaps = useTraceStore((s) => s.gaps);
  const filterExpr = useTraceStore((s) => s.filterExpr);
  const hidePeriodic = useTraceStore((s) => s.hidePeriodicTesterPresent);
  const selectedSeq = useTraceStore((s) => s.selectedSeq);
  const hoveredTxnId = useTraceStore((s) => s.hoveredTxnId);
  const select = useTraceStore((s) => s.select);
  const setHoveredTxn = useTraceStore((s) => s.setHoveredTxn);
  const follow = useTraceStore((s) => s.follow);
  const setFollow = useTraceStore((s) => s.setFollow);
  const paused = useTraceStore((s) => s.paused);

  const visibleColumns = useUiStore((s) => s.visibleColumns);
  const useUtc = useUiStore((s) => s.useUtc);

  const { rows, invalidExpr } = useFilteredRows(entries, filterExpr, hidePeriodic);

  /* ★D-01 / ★P0-FE#5：缺口对全量行推演（过滤行不再造假灰条），按可见 seq 裁剪渲染 */
  const merged: MergedRow[] = useMemo(
    () => buildDisplayRows(entries, rows, gaps),
    [entries, rows, gaps],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtual = useVirtualRows(scrollRef, merged.length);

  // 自动跟随：新行到达滚到底；暂停时停手
  useEffect(() => {
    if (!follow || paused) return;
    if (merged.length === 0) return;
    virtual.scrollToIndex(merged.length - 1, 'end');
  }, [merged.length, follow, paused, virtual]);

  const handleScrollAway = useCallback(() => {
    setFollow(false);
  }, [setFollow]);

  /* ── 右键菜单 ── */
  const [menu, setMenu] = useState<{ x: number; y: number; seq: number } | null>(null);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, seq: number) => {
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, seq });
    },
    [],
  );

  const closeMenu = (): void => setMenu(null);

  const entryOf = (seq: number) => entries.find((e) => e.seq === seq) ?? null;

  const copy = async (text: string, what: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`已复制${what}`, 'info');
    } catch {
      notify('复制失败（浏览器剪贴板不可用）', 'warn');
    }
  };

  if (entries.length === 0) {
    return (
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <FilterBar />
        <Box sx={{ px: 1, py: 0.5 }}>
          <TraceToolbar />
        </Box>
        <EmptyState
          title="暂无报文"
          hint="启动仿真 ECU → 车辆发现 → 连接 → 路由激活后，Trace 会实时显示（含 UDP 发现与 TCP 诊断报文）"
        />
      </Box>
    );
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <FilterBar />
      <Box sx={{ px: 1, py: 0.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <TraceToolbar />
        {invalidExpr ? (
          <Typography variant="caption" sx={{ color: 'error.main' }}>
            过滤表达式无法解析，当前按未过滤显示（不会静默丢行）
          </Typography>
        ) : null}
      </Box>

      {/* 表头 */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          height: 24,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
          fontSize: 11,
          color: 'text.secondary',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        {visibleColumns.map((id) => {
          const col = TRACE_COLUMNS.find((c) => c.id === id);
          return (
            <Box
              key={id}
              className="px-1"
              sx={{ fontWeight: 600, width: col?.width ?? 100, minWidth: col?.width ?? 100, flex: `0 0 ${col?.width ?? 100}px` }}
            >
              {col?.label ?? id}
            </Box>
          );
        })}
      </Box>

      {/* 虚拟滚动区 */}
      <Box
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el === null) return;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (!atBottom && follow) handleScrollAway();
        }}
        sx={{
          flex: 1,
          overflow: 'auto',
          position: 'relative',
          // ★D-04：矮视口（如 1280×577）下 flex:1 会被压成 7px，虚拟列表等于"空表"。
          //   给一个至少 6 行高的兜底，保证任何视口下都能看到行。
          minHeight: MIN_VIEWPORT_HEIGHT,
        }}
      >
        <Box sx={{ height: virtual.totalHeight, position: 'relative' }}>
          {virtual.virtualItems.map((item) => {
            const row = merged[item.index];
            if (row === undefined) return null;
            return (
              <Box
                key={row.kind === 'gap' ? `gap-${row.seq}` : row.seq}
                sx={{ position: 'absolute', top: 0, left: 0, transform: `translateY(${item.start}px)`, width: '100%' }}
                onContextMenu={(e) => {
                  if (row.kind === 'entry') handleContextMenu(e, row.seq);
                }}
              >
                {row.kind === 'gap' ? (
                  <Box
                    sx={{
                      height: ROW_HEIGHT,
                      display: 'flex',
                      alignItems: 'center',
                      px: 1,
                      bgcolor: '#2b2f3a',
                      color: 'text.secondary',
                      fontSize: 11,
                      borderTop: '1px dashed #4b5563',
                      borderBottom: '1px dashed #4b5563',
                    }}
                    title={
                      `seq ${row.seq} 起缺失 ${row.count} 条（${GAP_REASON_ZH[row.reason] ?? row.reason}）` +
                      '\n会自动按 seq 顺序向后端请求补齐；若后端环形缓冲已回绕覆盖该段，则不可恢复。'
                    }
                  >
                    ⋯ 缺口：seq {row.seq} 起缺失 {row.count} 条（{GAP_REASON_ZH[row.reason] ?? row.reason}）
                  </Box>
                ) : (
                  <TraceRow
                    entry={row.entry}
                    columns={visibleColumns}
                    selected={selectedSeq === row.seq}
                    groupHighlight={
                      hoveredTxnId !== null && row.entry.transactionId === hoveredTxnId
                    }
                    useUtc={useUtc}
                    onSelect={select}
                    onHoverTxn={setHoveredTxn}
                  />
                )}
              </Box>
            );
          })}
        </Box>
      </Box>

      {menu === null ? null : (
        <Menu
          open
          onClose={closeMenu}
          anchorReference="anchorPosition"
          anchorPosition={{ top: menu.y, left: menu.x }}
        >
          <MenuItem
          dense
          sx={{ fontSize: 12 }}
          onClick={() => {
            const e = menu === null ? null : entryOf(menu.seq);
            if (e !== null) void copy(JSON.stringify(e), `第 ${e.seq} 行 JSON`);
            closeMenu();
          }}
        >
          复制行（JSON）
        </MenuItem>
        <MenuItem
          dense
          sx={{ fontSize: 12 }}
          onClick={() => {
            const e = menu === null ? null : entryOf(menu.seq);
            if (e !== null) void copy(rawHexDisplay(e), `第 ${e.seq} 行 hex`);
            closeMenu();
          }}
        >
          复制 hex
        </MenuItem>
        <MenuItem
          dense
          sx={{ fontSize: 12 }}
          onClick={() => {
            const e = menu === null ? null : entryOf(menu.seq);
            if (e !== null) void copy(decodeSummary(e), `第 ${e.seq} 行解码串`);
            closeMenu();
          }}
        >
          复制解码串
        </MenuItem>
        <MenuItem
          dense
          sx={{ fontSize: 12 }}
          onClick={() => {
            if (menu !== null) select(menu.seq);
            closeMenu();
          }}
        >
          在 D 区详情中查看
        </MenuItem>
        <MenuItem dense disabled sx={{ fontSize: 12 }} title="B 区请求编排将在 M4/T13 提供">
          以此为模板新建请求（T13）
        </MenuItem>
        </Menu>
      )}

      <Stack direction="row" spacing={2} sx={{ px: 1, py: 0.25, borderTop: '1px solid', borderColor: 'divider' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          显示 {rows.length} / {entries.length} 条
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          缺口 {gaps.length} 段
        </Typography>
        {gaps.length > 0 ? (
          <Typography variant="caption" sx={{ color: 'warning.main' }}>
            存在 seq 缺口（背压或缓冲溢出），seq 链条仍连续可审计
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}

const GAP_REASON_ZH: Record<string, string> = {
  backpressure: 'WS 背压降级',
  overflow: '缓冲溢出淘汰',
  // ★不承诺「补齐中」：后端环形缓冲若已回绕覆盖该段，永远补不回来（QA 终验缺陷 4 的文案问题）
  local: '本地断号',
};
