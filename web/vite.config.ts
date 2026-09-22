import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Vite 配置（T08）。
 *
 * - 后端固定绑定 127.0.0.1（★Q11），开发期用 `/api` 与 `/ws` 代理到后端端口；
 * - 端口默认值与 `shared/protocol/constants.ts` 的 `PORTS.BACKEND_HTTP` 一致；
 *   配置文件在 Node 侧加载（不能 import TS 源码包），故这里保留字面量并可用
 *   `DOIP_BACKEND_PORT` 环境变量覆盖。运行时前端只用同源代理，不直连端口。
 * - `@doip/shared` 指向工作区源码（TS 直出，不走预构建，保证契约单一来源）。
 */

const BACKEND_PORT = Number(process.env['DOIP_BACKEND_PORT'] ?? 8787); // allow-hardcoded（= PORTS.BACKEND_HTTP）
const BIND_HOST = '127.0.0.1'; // ★Q11：只允许本机

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@doip/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  optimizeDeps: {
    exclude: ['@doip/shared'],
  },
  server: {
    port: 5273,
    strictPort: false,
    host: BIND_HOST,
    proxy: {
      '/api': { target: `http://${BIND_HOST}:${BACKEND_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://${BIND_HOST}:${BACKEND_PORT}`, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
});
