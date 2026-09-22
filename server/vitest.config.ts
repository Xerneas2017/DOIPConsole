import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 后端测试配置（vitest，environment=node）。
 * `@doip/shared` 直接指向源码，保证测试跑的是最新契约（与 tsx 运行时一致）。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@doip/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    globals: false,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
