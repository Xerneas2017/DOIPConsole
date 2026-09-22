import type { Config } from 'tailwindcss';

/**
 * Tailwind 配置（T08）。
 *
 * ★关键：`corePlugins.preflight = false` —— Tailwind 的 preflight 会重置
 * 浏览器默认样式（含 button/table/font），与 MUI 的 CssBaseline 抢方向盘，
 * 导致 MUI 组件基线样式被污染。因此关掉 preflight，只用 Tailwind 的
 * 工具类（间距/flex/等宽字体等），排版基线交给 MUI。
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {
      colors: {
        /* 与 theme.ts 的 Trace 行配色 token 对齐（只做工具类名，非基线） */
        trace: {
          request: '#1e293b',
          positive: '#12351f',
          nrc: '#4a1d1d',
          ack: '#132b3a',
          nack: '#4a1414',
          timeout: '#2a2a2a',
          periodic: '#232323',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', '0.95rem'],
      },
    },
  },
  plugins: [],
};

export default config;
