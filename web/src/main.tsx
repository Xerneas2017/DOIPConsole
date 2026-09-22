import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { App } from './App';
import { themeOptions } from './theme';
import './index.css';

/**
 * 入口（T08）：MUI 深色主题 + Tailwind（preflight 已关闭）。
 *
 * ★不使用 `StrictMode` 的双挂载会重复建立 WebSocket —— 这里仍启用 StrictMode，
 *   但 `App` 中连接用单例 + 幂等 `connect()`（WsClient 内部有 readyState 守卫），
 *   双挂载不会建立两条连接。
 */

const theme = createTheme(themeOptions);

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root 容器缺失');
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
);
