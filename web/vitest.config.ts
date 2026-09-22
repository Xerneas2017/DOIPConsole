import { defineConfig } from 'vitest/config';

/**
 * 前端单测（T08–T11）：只测纯逻辑（解码/过滤/store/配色），
 * 组件渲染留给 QA 与后续 M4 的 jsdom/RTL 环境。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
