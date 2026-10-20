#!/usr/bin/env node
/**
 * doip CLI 启动壳（macOS / Windows / Linux 一致）。
 *
 * 为什么需要这层薄壳：
 *  1. Node 不能直接执行 .ts，实现用 tsx 加载；
 *  2. `#!/usr/bin/env -S node --import tsx` 在 Windows 上不可用（env 不支持 -S），
 *     而 npm 的 bin shim 在 Windows 上生成的是 .cmd → 调 node 执行本文件，
 *     因此这里用纯 JS + spawn(process.execPath) 才能三平台一致；
 *  3. cwd 固定为项目根，保证 tsx 能读到 tsconfig 并解析 workspace 依赖。
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');
const entry = join(here, 'doip-cli.ts');

const child = spawn(process.execPath, ['--import', 'tsx', entry, ...process.argv.slice(2)], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    // CLI 不需要后端运行日志落盘（stdout 只留业务输出）
    DOIP_LOG_FILE: process.env.DOIP_LOG_FILE ?? '0',
  },
});

child.on('error', (err) => {
  console.error(`[FAIL] 无法启动 CLI：${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  // Ctrl-C 等信号终止：按 shell 惯例用 130
  process.exit(signal !== null ? 130 : (code ?? 1));
});
