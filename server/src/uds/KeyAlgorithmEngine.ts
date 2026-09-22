/**
 * Key 算法执行器（§3.9.3 / T14）。
 *
 * 四类 provider：
 *  - `ported`      ★主路径：注册表里的具名移植算法（我们自己的 TS 源码，不进沙箱）
 *  - `constant`    固定密钥（调试/对拍用）
 *  - `expression`  位运算表达式（wordWidth + endian + steps）
 *  - `javascript`  `node:vm` 沙箱：无 require/process/fs，100ms 超时，异常带行号
 *
 * ★恒定纯函数：任何失败都抛 `AppError`，绝不返回"看起来能用"的错误密钥。
 */

import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { TIMING, formatHexCompact, tryParseHex } from '@doip/shared';
import type { KeyAlgorithmSpec, KeyContext, KeyOp } from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import type { KeyAlgorithmRegistry, PortedAlgorithmImpl } from './algorithms/KeyAlgorithmRegistry';

/* ─────────────── 沙箱助手（只给纯计算，不给任何 I/O） ─────────────── */

function toU32(value: number): number {
  return value >>> 0;
}

function toU8(value: number): number {
  return value & 0xff;
}

function xor(value: number, mask: number): number {
  return (value & 0xff) ^ (mask & 0xff);
}

/** 在 width 位内循环左移（★用 >>> 归一，避免符号位污染） */
function rotl(value: number, bits: number, width: number): number {
  const w = Math.max(1, Math.min(32, width));
  const mask = w >= 32 ? 0xffffffff : (1 << w) - 1;
  const v = value >>> 0 & mask;
  const shift = ((bits % w) + w) % w;
  return ((v << shift) | (v >>> (w - shift))) & mask >>> 0;
}

function rotr(value: number, bits: number, width: number): number {
  const w = Math.max(1, Math.min(32, width));
  return rotl(value, w - (((bits % w) + w) % w), w);
}

function bswap(value: number, width: number): number {
  const w = Math.max(1, Math.min(32, width));
  const mask = w >= 32 ? 0xffffffff : (1 << w) - 1;
  const v = value >>> 0 & mask;
  if (w === 8) return v;
  if (w === 16) return (((v & 0xff) << 8) | (v >>> 8)) & 0xffff;
  return (
    (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0
  );
}

function fromU32(value: number): Uint8Array {
  const v = value >>> 0;
  return Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function hex(bytes: ArrayLike<number> | string): string {
  if (typeof bytes === 'string') return bytes;
  return formatHexCompact(Uint8Array.from(bytes as ArrayLike<number>));
}

const SANDBOX_HELPERS = { toU32, toU8, xor, rotl, rotr, bswap, fromU32, hex };

/* ─────────────── 执行器 ─────────────── */

export class KeyAlgorithmEngine {
  private readonly log = getLogger('uds.keyEngine');
  private readonly scriptCache = new Map<string, vm.Script>();

  constructor(private readonly registry: KeyAlgorithmRegistry) {}

  /** 恒定纯函数；失败抛 AppError */
  compute(spec: KeyAlgorithmSpec, ctx: KeyContext): Buffer {
    switch (spec.type) {
      case 'ported':
        return this.computePorted(spec.algorithmId, ctx);
      case 'constant':
        return this.computeConstant(spec.params.keyHex, ctx);
      case 'expression':
        return this.computeExpression(spec.params, ctx);
      case 'javascript':
        return this.computeJavascript(spec.source, ctx);
      default:
        throw new AppError('E_LIB_KEY_ALGO_FAILED', `未知的算法类型：${JSON.stringify(spec)}`);
    }
  }

  /** 直接用注册表里的具名算法（UI「试算」走这条） */
  computeById(algorithmId: string, ctx: KeyContext): Buffer {
    return this.computePorted(algorithmId, ctx);
  }

  /* ── ported ── */

  private computePorted(algorithmId: string, ctx: KeyContext): Buffer {
    const algorithm = this.registry.get(algorithmId);
    if (algorithm === undefined) {
      throw new AppError('E_LIB_KEY_ALGO_NOT_FOUND', `未找到 Key 算法：${algorithmId}`, {
        detail: { algorithmId },
      });
    }
    const seed = Uint8Array.from(ctx.seed);
    if (algorithm.seedLengthBytes !== null && seed.length !== algorithm.seedLengthBytes) {
      throw new AppError('E_LIB_KEY_ALGO_SEED_LEN', 'Seed 长度与算法要求不符', {
        hintZh: `算法 ${algorithm.id} 要求 seed 为 ${algorithm.seedLengthBytes} 字节，实际 ${seed.length} 字节`,
        detail: { expect: algorithm.seedLengthBytes, actual: seed.length },
      });
    }
    const key = algorithm.compute(ctx.level, seed);
    const bytes = Uint8Array.from(key);
    if (algorithm.keyLengthBytes !== null && bytes.length !== algorithm.keyLengthBytes) {
      throw new AppError('E_LIB_KEY_ALGO_KEY_LEN', '算法产出的 Key 长度不符', {
        hintZh: `算法 ${algorithm.id} 应产出 ${algorithm.keyLengthBytes} 字节，实际 ${bytes.length} 字节`,
        detail: { expect: algorithm.keyLengthBytes, actual: bytes.length },
      });
    }
    return Buffer.from(bytes);
  }

  /* ── constant ── */

  private computeConstant(keyHex: string, ctx: KeyContext): Buffer {
    const bytes = tryParseHex(keyHex);
    if (bytes === null || bytes.length === 0) {
      throw new AppError('E_LIB_KEY_ALGO_FAILED', `常量密钥非法 hex："${keyHex}"`);
    }
    // 与 seed 等长时按 seed 长度截断/补齐（常量场景允许短密钥左对齐补 0）
    if (bytes.length === ctx.seed.length) return Buffer.from(bytes);
    const out = new Uint8Array(Math.max(bytes.length, ctx.seed.length));
    out.set(bytes.subarray(0, Math.min(bytes.length, out.length)), 0);
    return Buffer.from(out);
  }

  /* ── expression（位运算） ── */

  private computeExpression(
    params: Extract<KeyAlgorithmSpec, { type: 'expression' }>['params'],
    ctx: KeyContext,
  ): Buffer {
    const { wordWidth, endian, steps } = params;
    const wordBytes = wordWidth / 8;
    const mask = wordWidth >= 32 ? 0xffffffff : (1 << wordWidth) - 1;
    const seed = Uint8Array.from(ctx.seed);
    const out = new Uint8Array(seed.length);

    for (let offset = 0; offset + wordBytes <= seed.length; offset += wordBytes) {
      const slice = seed.subarray(offset, offset + wordBytes);
      let value = 0;
      if (endian === 'big') {
        for (const b of slice) value = ((value << 8) | (b & 0xff)) >>> 0;
      } else {
        let shift = 0;
        for (const b of slice) {
          value = (value | ((b & 0xff) << shift)) >>> 0;
          shift += 8;
        }
      }
      value = this.applySteps(value & mask, steps, wordWidth, mask);

      const bytes = new Uint8Array(wordBytes);
      if (endian === 'big') {
        for (let i = 0; i < wordBytes; i += 1) {
          bytes[i] = (value >>> (8 * (wordBytes - 1 - i))) & 0xff;
        }
      } else {
        for (let i = 0; i < wordBytes; i += 1) {
          bytes[i] = (value >>> (8 * i)) & 0xff;
        }
      }
      out.set(bytes, offset);
    }

    // ★不足一个字的尾巴按字节原样保留（不静默补零）
    const tail = seed.length % wordBytes;
    if (tail !== 0) {
      out.set(seed.subarray(seed.length - tail), seed.length - tail);
    }
    return Buffer.from(out);
  }

  private applySteps(value: number, steps: KeyOp[], wordWidth: number, mask: number): number {
    let v = value >>> 0;
    for (const step of steps) {
      switch (step.op) {
        case 'xor': {
          const maskBytes = tryParseHex(step.maskHex);
          if (maskBytes === null || maskBytes.length === 0) {
            throw new AppError('E_LIB_KEY_ALGO_FAILED', `表达式中的 maskHex 非法："${step.maskHex}"`);
          }
          let m = 0;
          for (const b of maskBytes) m = ((m << 8) | (b & 0xff)) >>> 0;
          v = (v ^ m) & mask >>> 0;
          break;
        }
        case 'not':
          v = ~v & mask >>> 0;
          break;
        case 'add': {
          const mod = step.modulo ?? 1 << wordWidth;
          v = (((v + step.value) % mod) + mod) % mod & mask >>> 0;
          break;
        }
        case 'sub': {
          const mod = step.modulo ?? 1 << wordWidth;
          v = (((v - step.value) % mod) + mod) % mod & mask >>> 0;
          break;
        }
        case 'shiftL':
          v = (v << (step.bits & 31)) & mask >>> 0;
          break;
        case 'shiftR':
          // ★坑 1：一律无符号右移
          v = (v >>> (step.bits & 31)) & mask >>> 0;
          break;
        case 'rotL':
          v = rotl(v, step.bits, wordWidth);
          break;
        case 'rotR':
          v = rotr(v, step.bits, wordWidth);
          break;
        case 'swapEndian':
        case 'reverseBytes':
          v = bswap(v, wordWidth);
          break;
        case 'bswap16':
          v = bswap(v, 16);
          break;
        case 'bswap32':
          v = bswap(v, 32);
          break;
        default:
          throw new AppError('E_LIB_KEY_ALGO_FAILED', `未知位运算步骤：${JSON.stringify(step)}`);
      }
    }
    return v >>> 0;
  }

  /* ── javascript（vm 沙箱） ── */

  private computeJavascript(source: string, ctx: KeyContext): Buffer {
    const cacheKey = createHash('sha1').update(source).digest('hex');
    let script = this.scriptCache.get(cacheKey);
    if (script === undefined) {
      // ★把调用也包进脚本里：这样 `timeout` 才能真正管住用户源码里的死循环
      script = new vm.Script(
        `result = (function(level, seed, params, helpers){\n${source}\n})(level, seed, params, helpers);`,
      );
      this.scriptCache.set(cacheKey, script);
    }

    // ★沙箱内不注入 require / process / fs / net / globalThis 的宿主引用
    const sandbox: Record<string, unknown> = {
      helpers: SANDBOX_HELPERS,
      level: ctx.level,
      seed: Array.from(ctx.seed),
      params: ctx.params ?? {},
      result: null,
    };
    const context = vm.createContext(sandbox);

    try {
      script.runInContext(context, {
        timeout: TIMING.KEY_ALGO_TIMEOUT_MS,
        displayErrors: true,
      });
    } catch (err) {
      throw this.wrapSandboxError(err, source);
    }

    const bytes = KeyAlgorithmEngine.toBytes(sandbox['result']);
    if (bytes === null) {
      throw new AppError('E_LIB_KEY_ALGO_FAILED', 'JS 算法未返回字节序列（应返回 Uint8Array 或数字数组）');
    }
    return Buffer.from(bytes);
  }

  /** 跨 vm 上下文的返回值可能是"外来"Uint8Array，必须鸭子类型识别并重建 */
  private static toBytes(raw: unknown): Uint8Array | null {
    if (typeof raw === 'string') return tryParseHex(raw);
    if (typeof raw !== 'object' || raw === null) return null;
    const like = raw as { length?: number; [index: number]: number };
    if (typeof like.length !== 'number' || like.length <= 0) return null;
    const out = new Uint8Array(like.length);
    for (let i = 0; i < like.length; i += 1) {
      const v = like[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      out[i] = v & 0xff; // ★坑 3：显式截断
    }
    return out;
  }

  private wrapSandboxError(err: unknown, source: string): AppError {
    const message = err instanceof Error ? err.message : String(err);
    const line = KeyAlgorithmEngine.errorLine(err, source);
    this.log.warn('JS Key 算法执行失败', { message, line });
    return new AppError('E_LIB_KEY_ALGO_FAILED', `Key 算法执行失败：${message}`, {
      hintZh: line === null ? '检查算法源码与超时设置' : `检查源码第 ${line} 行附近（沙箱超时 ${TIMING.KEY_ALGO_TIMEOUT_MS}ms，无 require/process/fs 能力）`,
      detail: { line, source: source.slice(0, 512) },
    });
  }

  /** 从 vm 的 stack 里抽行号（形如 `evalmachine.<anonymous>:3`） */
  private static errorLine(err: unknown, source: string): number | null {
    const stack = err instanceof Error ? (err.stack ?? '') : '';
    const matched = /:(\d+)(?::\d+)?/.exec(stack);
    if (matched === null || matched[1] === undefined) return null;
    const raw = Number.parseInt(matched[1], 10);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    // vm 包装多了一行 `(function(...){`，减掉后对齐用户源码行号
    const line = raw - 1;
    return line >= 1 && line <= source.split('\n').length + 1 ? line : null;
  }
}

/** 供 UI 展示：算法是否处于「待替换」状态 */
export function isPlaceholderAlgorithm(algorithm: PortedAlgorithmImpl | undefined): boolean {
  return algorithm !== undefined && algorithm.origin === 'placeholder';
}
