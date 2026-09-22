#!/usr/bin/env node
/**
 * ★守门脚本（§8.8）：禁止在源码里写死超时/上限数字。
 *
 * 所有超时与上限必须集中在 `shared/src/protocol/constants.ts`，
 * 业务代码通过 `getTiming()` / `getLimits()` 取值。本脚本扫描
 * `shared/src`、`server/src`、`web/src` 下的 `.ts` 文件，找出"疑似硬编码"。
 *
 * 判定规则（只报可疑行，由人确认）：
 *   1. 直接以字面量调用 setTimeout / setInterval / 定时器相关 API；
 *   2. 形如 `xxxTimeoutMs = <数字>`、`xxxLimit = <数字>`、`delayMs: <数字>` 的赋值；
 *   3. 形如 `wait(<数字>)` / `sleep(<数字>)` 的调用。
 *
 * 白名单（不视为硬编码）：
 *   - 数字为 0 / 1（通常不是超时语义）；
 *   - 位于 `constants.ts` 内部（那里本来就是唯一来源）；
 *   - 位于 `__tests__/` 或 `.test.ts`（测试里允许临时值）；
 *   - 行尾带 `// allow-hardcoded` 注释的显式豁免。
 *
 * 用法：`npm run check:timeouts`，发现可疑项时退出码为 1。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCAN_DIRS = ['shared/src', 'server/src', 'web/src'];

/**
 * ★N-01 补漏：本脚本原先**只扫 `.ts`**，而前端业务代码几乎全在 `.tsx`，
 *   于是 `App.tsx` 里的 `setInterval(..., 15000)` 长期逃逸。
 *   现在 `.ts` / `.tsx` 都扫。
 */
const SCAN_EXTS = ['.ts', '.tsx'];

/** 匹配 `setTimeout(2000, ...)` / `setInterval(fn, 500)` 这类定时器字面量（单行）。 */
const TIMER_CALL = /\b(?:setTimeout|setInterval|setImmediate)\s*\(\s*(?:[^,()]*,\s*)?(\d{2,})\s*[,)]/;
/**
 * ★N-01 补漏 ②：上面的单行正则抓不到"回调整块换行"的写法——
 *   `setInterval(() => {` 在第 55 行、`, 15000)` 在第 57 行。
 *   这条跨行规则对整个文件做一次性匹配（懒匹配最多 400 字符），再由 offset 反推行号。
 */
const TIMER_CALL_MULTILINE =
  /\b(?:window\s*\.\s*)?(?:setTimeout|setInterval|setImmediate)\s*\([\s\S]{0,400}?,\s*(\d{2,})\s*[,)]/g;
/** 匹配 `xxxTimeout(?:Ms)? = 2000` / `maxBufferBytes: 1048576` / `delayMs: 800`。 */
const FIELD_ASSIGN =
  /\b\w*(?:Timeout|TimeoutMs|Limit|LimitBytes|MaxBytes|Delay|DelayMs|Interval|IntervalMs|Window|WindowMs|Ttl|TtlMs)\b\s*[:=]\s*(\d{2,})/;
/** 匹配 `sleep(2000)` / `wait(2000)` / `delay(2000)`。 */
const WAIT_CALL = /\b(?:sleep|wait|delay)\s*\(\s*(\d{2,})\s*\)/;

const RULES = [
  { name: '定时器字面量', re: TIMER_CALL },
  { name: '超时/上限字段赋值', re: FIELD_ASSIGN },
  { name: '等待调用字面量', re: WAIT_CALL },
];

const EXEMPT_FILE_BASENAMES = new Set(['constants.ts']);
const EXEMPT_MARKER = 'allow-hardcoded';

/**
 * 递归收集目录下所有 `.ts` 文件（跳过 node_modules 与声明文件）。
 * @param {string} dir 绝对路径
 * @param {string[]} out 结果收集数组
 * @returns {string[]} 文件绝对路径列表
 */
function collectTsFiles(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectTsFiles(full, out);
    } else if (
      (name.endsWith('.ts') || name.endsWith('.tsx')) &&
      !name.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
let scannedFiles = 0;

for (const rel of SCAN_DIRS) {
  const absDir = join(ROOT, rel);
  const files = collectTsFiles(absDir);
  for (const file of files) {
    const relPath = relative(ROOT, file).split(sep).join('/');
    const base = file.split('/').pop() ?? '';
    if (EXEMPT_FILE_BASENAMES.has(base)) continue;
    if (relPath.includes('/__tests__/') || base.endsWith('.test.ts')) continue;

    const text = readFileSync(file, 'utf8');
    scannedFiles += 1;
    const lines = text.split(/\r?\n/);
    const reported = new Set();

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.includes(EXEMPT_MARKER)) continue;
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
      for (const rule of RULES) {
        const m = rule.re.exec(line);
        if (m && Number(m[1]) >= 10) {
          reported.add(i + 1);
          findings.push({
            file: relPath,
            line: i + 1,
            rule: rule.name,
            value: m[1],
            text: trimmed.slice(0, 120),
          });
          break;
        }
      }
    }

    /* ★跨行定时器字面量（单行规则抓不到回调换行的写法） */
    TIMER_CALL_MULTILINE.lastIndex = 0;
    for (let m = TIMER_CALL_MULTILINE.exec(text); m !== null; m = TIMER_CALL_MULTILINE.exec(text)) {
      const value = Number(m[1]);
      if (value >= 10) {
        const line = text.slice(0, m.index).split('\n').length;
        const startLine = Math.max(0, line - 1);
        const snippet =
          (lines[startLine] ?? '').trim() + ' … ' + (lines[line - 1] ?? '').trim();
        if (!reported.has(line)) {
          reported.add(line);
          findings.push({
            file: relPath,
            line,
            rule: '定时器字面量（跨行）',
            value: m[1],
            text: snippet.slice(0, 120),
          });
        }
      }
    }
  }
}

console.log('════════════════════════════════════════════════════════════════════');
console.log(' 超时/上限硬编码检查（§8.8：所有超时集中在 constants.ts）');
console.log('════════════════════════════════════════════════════════════════════');
console.log(` 扫描文件数：${scannedFiles}`);

if (findings.length === 0) {
  console.log(' 结论：未发现硬编码超时/上限。PASS');
  console.log('════════════════════════════════════════════════════════════════════');
  process.exit(0);
}

console.log(` 发现 ${findings.length} 处可疑硬编码：`);
for (const f of findings) {
  console.log(`  ${f.file}:${f.line} [${f.rule}] 值=${f.value}`);
  console.log(`      ${f.text}`);
}
console.log('════════════════════════════════════════════════════════════════════');
process.exit(1);
