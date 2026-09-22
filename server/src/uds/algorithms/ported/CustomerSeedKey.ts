/**
 * 移植算法：客户 Seed/Key（§3.9 / T14）。
 *
 * ★★当前为 **占位实现**（`origin:'placeholder'`）：客户 代码/公式尚未提供。
 *    替换步骤：把 `compute()` 换成客户算法的逐行 TS 翻译，
 *    把 `origin` 改成 `'customer-c'`，并在 `data/key-algo-vectors.json`
 *    里把 `ported.customer.seedkey-l1` 的向量绑定好 —— TC-K09 会强制 100% 通过。
 *
 * ★C → JS 移植三大坑（见 §3.9.1 表格，本文件的实现刻意逐条规避）：
 *   1. 有符号移位：C 的 `uint32_t` 右移是无符号的，JS 的 `>>` 带符号 → 一律用 `>>>`。
 *   2. char 符号扩展：C 的 `char` 可能是 signed，取到 0x80 以上会变负数 → 取值后先 `& 0xFF`。
 *   3. 无自动截断：C 的 `uint8_t/uint32_t` 溢出自动回绕，JS 不会 → 每步显式 `& 0xFF` / `>>> 0`。
 */

import type { PortedAlgorithmImpl } from '../KeyAlgorithmRegistry';

const XOR_MASK = 0x5a;

/**
 * 占位算法：把 seed 按字节逆序后逐字节异或 0x5A。
 *
 * 对应的 C 伪码（客户代码到位后替换本函数体即可）：
 *
 *   uint32_t key = 0;
 *   for (int i = 0; i < 4; i++) {
 *       uint8_t b = (uint8_t)seed[3 - i];   // char 可能是 signed，必须显式转 uint8_t
 *       key = (key << 8) | (uint32_t)(b ^ 0x5A);  // uint32_t 溢出自动截断
 *   }
 */
function computePlaceholder(_level: number, seed: Uint8Array): Uint8Array {
  const out = new Uint8Array(seed.length);
  for (let i = 0; i < seed.length; i += 1) {
    // ★坑 2：先 & 0xFF，等价于 C 的 (uint8_t) 强转，避免 char 符号扩展成负数
    const byte = (seed[seed.length - 1 - i] ?? 0) & 0xff;
    // ★坑 3：再 & 0xFF，等价于 C 的 uint8_t 自动截断
    out[i] = (byte ^ XOR_MASK) & 0xff;
  }
  return out;
}

export const PLACEHOLDER_SEED_KEY: PortedAlgorithmImpl = {
  id: 'ported.placeholder.seedkey',
  nameZh: '占位算法（待替换为客户 代码）',
  appliesToLevels: [1, 2, 3, 4, 5],
  seedLengthBytes: 4,
  keyLengthBytes: 4,
  origin: 'placeholder',
  verified: false,
  notes:
    '★占位实现：seed 逆序后逐字节异或 0x5A，与客户真实算法无关。' +
    '替换时请逐行翻译客户 代码，并注意三处：① JS 的 >> 带符号，无符号右移必须用 >>>；' +
    '② C 的 char 可能是 signed，取字节后先 & 0xFF；③ JS 不自动截断，每步算术后显式 & 0xFF 或 >>> 0。',
  compute: computePlaceholder,
};

/** 保留 id：客户 代码到位后的正式算法（向量已绑定到此 id） */
export const CUSTOMER_ALGORITHM_ID = 'ported.customer.seedkey-l1' as const;
