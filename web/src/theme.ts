import type { ThemeOptions } from '@mui/material/styles';

/**
 * 深色主题（T08）。
 *
 * 两套配色必须能共存：
 *  - MUI 负责组件基线（按钮/输入框/表格/弹窗）；
 *  - Tailwind 的 preflight 已关闭，只提供工具类（间距/等宽字体/自定义色 token）。
 *
 * ★Trace 行配色 token 集中在这里，`decode/colorRules.ts` 引用同一份，
 *   避免"表格行色"与"图例色"各写一份而对不上。
 */

export const TRACE_COLORS = {
  request: '#16233a',
  positive: '#12301f',
  nrc: '#451c1c',
  ack: '#122b3d',
  nack: '#4a1414',
  timeout: '#262626',
  periodic: '#1f1f1f',
} as const;

/** 配对左边框：同一 transactionId 用同一色（最多 8 色循环） */
export const PAIR_BORDER_COLORS = [
  '#4f9cf9',
  '#3ddc97',
  '#f7b955',
  '#c678dd',
  '#56b6c2',
  '#e06c75',
  '#98c379',
  '#61afef',
] as const;

export const themeOptions: ThemeOptions = {
  palette: {
    mode: 'dark',
    background: {
      default: '#0f1115',
      paper: '#151922',
    },
    primary: { main: '#4f9cf9' },
    secondary: { main: '#3ddc97' },
    error: { main: '#e06c75' },
    warning: { main: '#f7b955' },
    success: { main: '#3ddc97' },
    info: { main: '#56b6c2' },
    divider: '#262b36',
    text: { primary: '#e6e9ef', secondary: '#9aa4b2' },
  },
  typography: {
    fontFamily: "'Inter', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    fontSize: 13,
    button: { textTransform: 'none', fontWeight: 500 },
  },
  shape: { borderRadius: 6 },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: { overflow: 'hidden' },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: { paddingTop: 2, paddingBottom: 2, borderBottom: '1px solid #1d2330' },
      },
    },
    MuiTooltip: {
      // UI 交互手感，非协议时序；§8.8 守卫的豁免写法（行尾 allow-hardcoded）
      defaultProps: { enterDelay: 400 }, // allow-hardcoded
    },
  },
};
