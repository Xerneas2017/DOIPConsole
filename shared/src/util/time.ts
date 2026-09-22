/**
 * 时间工具 —— §8.5：
 *  - 绝对时间：ISO 8601 UTC，6 位小数（μs）
 *  - 超时判定一律用 nowMonoMs()（performance 基准），不用 Date.now()
 */

/** 单调时钟（ms，小数）。用于所有超时/延迟计算，免疫系统时钟跳变。 */
export function nowMonoMs(): number {
  return performance.now();
}

/** 墙上时钟（ms）。仅用于展示与落盘时间戳。 */
export function nowEpochMs(): number {
  return Date.now();
}

/** 相对某个单调时刻已经过去多少 ms */
export function elapsedMs(sinceMonoMs: number): number {
  return nowMonoMs() - sinceMonoMs;
}

/**
 * ISO 8601 UTC，6 位小数（μs）：'2026-09-21T10:00:00.123456Z'
 * 实现：Date 提供 ms 精度，performance 的小数部分补到 μs。
 */
export function isoMicroNow(): string {
  const t = performance.timeOrigin + performance.now();
  const wholeMs = Math.floor(t);
  const micros = Math.floor((t - wholeMs) * 1000);
  const base = new Date(wholeMs).toISOString(); // '....T10:00:00.123Z'
  return `${base.slice(0, 23)}${String(micros).padStart(3, '0')}Z`;
}

/** 把 epoch ms + 额外 μs 格式化为 6 位小数的 ISO 串 */
export function formatIsoMicro(epochMs: number, extraMicros = 0): string {
  const wholeMs = Math.floor(epochMs);
  const micros = Math.floor((epochMs - wholeMs) * 1000) + extraMicros;
  const base = new Date(wholeMs).toISOString();
  return `${base.slice(0, 23)}${String(Math.min(micros, 999)).padStart(3, '0')}Z`;
}

/** Promise 版 sleep（仅测试与脚本使用） */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 人类可读时长：'1.234 s' / '200 ms' */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '-';
  if (Math.abs(ms) >= 1000) return `${(ms / 1000).toFixed(3)} s`;
  return `${Math.round(ms)} ms`;
}
