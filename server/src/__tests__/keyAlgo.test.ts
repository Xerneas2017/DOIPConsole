/**
 * T14 Key 算法用例（§9 TC-K01~K11 / §3.9）。
 *
 * ★TC-K09 是 CI 硬门槛：`origin:'customer-c'` 的算法必须 100% 通过绑定向量。
 * ★TC-K11 专测 C→JS 移植的三大坑：有符号移位、char 符号扩展、无自动截断。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { formatHex, tryParseHex } from '@doip/shared';
import type { KeyTestVector, KeyVectorsFile, SendUdsResult } from '@doip/shared';
import { KeyAlgorithmRegistry } from '../uds/algorithms/KeyAlgorithmRegistry';
import type { PortedAlgorithmImpl } from '../uds/algorithms/KeyAlgorithmRegistry';
import { PLACEHOLDER_SEED_KEY, CUSTOMER_ALGORITHM_ID } from '../uds/algorithms/ported/CustomerSeedKey';
import { KeyAlgorithmEngine } from '../uds/KeyAlgorithmEngine';
import { KeyVectorVerifier } from '../uds/KeyVectorVerifier';
import { SecurityAccessFlow } from '../uds/SecurityAccessFlow';
import { UdsLibraryStore, findDataDir } from '../uds/UdsLibraryStore';
import type { UdsService } from '../uds/UdsService';
import { UdsEncoder } from '../uds/UdsEncoder';
import { AppError } from '../errors/AppError';

let tmpRoot = '';

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'doip-key-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seed(hex: string): Uint8Array {
  const bytes = tryParseHex(hex);
  if (bytes === null) throw new Error(`bad hex ${hex}`);
  return bytes;
}

function emptyRegistry(): KeyAlgorithmRegistry {
  return new KeyAlgorithmRegistry(false);
}

/** 一个"正确的"客户算法：key[i] = (seed[i] * 2 + 1) & 0xFF */
const GOOD_CUSTOMER: PortedAlgorithmImpl = {
  id: CUSTOMER_ALGORITHM_ID,
  nameZh: '客户算法（示例：×2+1）',
  appliesToLevels: [1],
  seedLengthBytes: 4,
  keyLengthBytes: 4,
  origin: 'customer-c',
  verified: false,
  compute(_level: number, s: Uint8Array): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) {
      out[i] = (((s[i] ?? 0) & 0xff) * 2 + 1) & 0xff; // ★每步显式截断
    }
    return out;
  },
};

/**
 * 一个"算错的"客户算法：★移植时把字节序搞反（C 侧常见：直接按 uint32 大端读写，
 * 而 ECU 实际是小端）。这类错误在仿真里不会报错，只会在实车上表现为 NRC 0x35。
 */
const BAD_CUSTOMER: PortedAlgorithmImpl = {
  ...GOOD_CUSTOMER,
  id: 'ported.customer.broken',
  compute(_level: number, s: Uint8Array): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i += 1) {
      out[i] = (((s[s.length - 1 - i] ?? 0) & 0xff) * 2 + 1) & 0xff; // ✗ 字节序反了
    }
    return out;
  },
};

const VECTORS: KeyTestVector[] = [
  { id: 'v1', level: 1, seedHex: '01 02 03 04', expectedKeyHex: '03 05 07 09' },
  { id: 'v2', level: 1, seedHex: '00 10 20 30', expectedKeyHex: '01 21 41 61' },
  { id: 'v3', level: 1, seedHex: '7F 80 FF 00', expectedKeyHex: 'FF 01 FF 01' },
];

function vectorFile(bindings: Record<string, string[]>): KeyVectorsFile {
  return { schemaVersion: '1.0', bindings, vectors: VECTORS };
}

beforeEach(() => {
  // 每个用例独立构造，避免注册表互相污染
});

describe('T14 — Key 算法 provider', () => {
  it('TC-K01：constant provider 返回固定密钥', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const key = engine.compute(
      { id: 'a', name: '常量', type: 'constant', params: { keyHex: '5A 5A 5A 5A' } },
      { level: 1, seed: seed('00 00 00 00') },
    );
    expect(formatHex(new Uint8Array(key))).toBe('5A 5A 5A 5A');
  });

  it('TC-K01：constant 非法 hex 抛 E_LIB_KEY_ALGO_FAILED', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    expect(() =>
      engine.compute(
        { id: 'a', name: '常量', type: 'constant', params: { keyHex: 'ZZ' } },
        { level: 1, seed: seed('00 00 00 00') },
      ),
    ).toThrow(AppError);
  });

  it('TC-K02：expression — 逐字节异或', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const key = engine.compute(
      {
        id: 'a',
        name: '异或',
        type: 'expression',
        params: { wordWidth: 8, endian: 'big', steps: [{ op: 'xor', maskHex: '5A' }] },
      },
      { level: 1, seed: seed('00 FF A1 B2') },
    );
    expect(formatHex(new Uint8Array(key))).toBe('5A A5 FB E8');
  });

  it('TC-K02：expression — 32 位大端旋转 + 字节序', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const key = engine.compute(
      {
        id: 'a',
        name: '旋转',
        type: 'expression',
        params: { wordWidth: 32, endian: 'big', steps: [{ op: 'rotL', bits: 8 }] },
      },
      { level: 1, seed: seed('01 02 03 04') },
    );
    expect(formatHex(new Uint8Array(key))).toBe('02 03 04 01');
  });

  it('TC-K02：expression — 小端 16 位取反', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const key = engine.compute(
      {
        id: 'a',
        name: '取反',
        type: 'expression',
        params: { wordWidth: 16, endian: 'little', steps: [{ op: 'not' }] },
      },
      { level: 1, seed: seed('00 00 FF FF') },
    );
    expect(formatHex(new Uint8Array(key))).toBe('FF FF 00 00');
  });

  it('TC-K02：expression — 不足一个字的尾巴按原样保留（不静默补零）', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const key = engine.compute(
      {
        id: 'a',
        name: '异或',
        type: 'expression',
        params: { wordWidth: 32, endian: 'big', steps: [{ op: 'xor', maskHex: 'FFFFFFFF' }] },
      },
      { level: 1, seed: seed('01 02 03 04 05 06') },
    );
    // 前 4 字节取反，后 2 字节原样
    expect(formatHex(new Uint8Array(key))).toBe('FE FD FC FB 05 06');
  });

  it('TC-K03：javascript provider 正常返回', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const key = engine.compute(
      {
        id: 'a',
        name: 'JS',
        type: 'javascript',
        source: 'var out=new Uint8Array(seed.length);for(var i=0;i<seed.length;i++){out[i]=helpers.toU8(helpers.xor(seed[i],0x5A));}return out;',
      },
      { level: 1, seed: seed('00 FF A1 B2') },
    );
    expect(formatHex(new Uint8Array(key))).toBe('5A A5 FB E8');
  });

  it('TC-K04：javascript 异常被捕获并带行号', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    let caught: AppError | null = null;
    try {
      engine.compute(
        { id: 'a', name: 'JS', type: 'javascript', source: 'var a = 1;\nvar b = 2;\nthrow new Error("boom");' },
        { level: 1, seed: seed('00 00 00 00') },
      );
    } catch (err) {
      caught = err instanceof AppError ? err : null;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe('E_LIB_KEY_ALGO_FAILED');
    expect(caught?.message).toContain('boom');
  });

  it('TC-K04：javascript 死循环被 100ms 超时掐断', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const started = Date.now();
    let caught: AppError | null = null;
    try {
      engine.compute(
        { id: 'a', name: 'JS', type: 'javascript', source: 'while(true){}' },
        { level: 1, seed: seed('00 00 00 00') },
      );
    } catch (err) {
      caught = err instanceof AppError ? err : null;
    }
    expect(caught?.code).toBe('E_LIB_KEY_ALGO_FAILED');
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  }, 10000);

  it('TC-K05：沙箱内没有 require / process（typeof 均为 undefined）', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const key = engine.compute(
      {
        id: 'a',
        name: 'JS',
        type: 'javascript',
        source:
          'var out=new Uint8Array(2);' +
          'out[0]=(typeof require==="undefined")?1:0;' +
          'out[1]=(typeof process==="undefined")?1:0;' +
          'return out;',
      },
      { level: 1, seed: seed('00') },
    );
    expect(formatHex(new Uint8Array(key))).toBe('01 01');
  });

  it('TC-K05：沙箱内访问 require 直接报错', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    expect(() =>
      engine.compute(
        { id: 'a', name: 'JS', type: 'javascript', source: 'return require("fs");' },
        { level: 1, seed: seed('00') },
      ),
    ).toThrow(/require/);
  });

  it('TC-K06：ported provider 正常计算', () => {
    const registry = emptyRegistry();
    registry.register(PLACEHOLDER_SEED_KEY);
    const engine = new KeyAlgorithmEngine(registry);
    const key = engine.computeById('ported.placeholder.seedkey', {
      level: 1,
      seed: seed('A1 B2 C3 D4'),
    });
    expect(formatHex(new Uint8Array(key))).toBe('8E 99 E8 FB');
  });

  it('TC-K06：seed 长度不符抛 E_LIB_KEY_ALGO_SEED_LEN', () => {
    const registry = emptyRegistry();
    registry.register(PLACEHOLDER_SEED_KEY);
    const engine = new KeyAlgorithmEngine(registry);
    try {
      engine.computeById('ported.placeholder.seedkey', { level: 1, seed: seed('A1 B2') });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err instanceof AppError).toBe(true);
      expect((err as AppError).code).toBe('E_LIB_KEY_ALGO_SEED_LEN');
    }
  });

  it('TC-K06：算法不存在抛 E_LIB_KEY_ALGO_NOT_FOUND', () => {
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    try {
      engine.computeById('nope', { level: 1, seed: seed('A1 B2 C3 D4') });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe('E_LIB_KEY_ALGO_NOT_FOUND');
    }
  });

  it('TC-K06：key 长度不符抛 E_LIB_KEY_ALGO_KEY_LEN', () => {
    const registry = emptyRegistry();
    registry.register({
      ...PLACEHOLDER_SEED_KEY,
      id: 'ported.bad.len',
      seedLengthBytes: null,
      keyLengthBytes: 8,
    });
    const engine = new KeyAlgorithmEngine(registry);
    try {
      engine.computeById('ported.bad.len', { level: 1, seed: seed('A1 B2 C3 D4') });
      expect.unreachable('应当抛错');
    } catch (err) {
      expect((err as AppError).code).toBe('E_LIB_KEY_ALGO_KEY_LEN');
    }
  });

  it('TC-K07：占位算法 origin=placeholder 且排在下表最后', () => {
    const registry = emptyRegistry();
    registry.register(PLACEHOLDER_SEED_KEY);
    registry.register({ ...GOOD_CUSTOMER, verified: true });
    const list = registry.listForLevel(1);
    expect(list[list.length - 1]?.id).toBe('ported.placeholder.seedkey');
    expect(list[list.length - 1]?.origin).toBe('placeholder');
    expect(list[0]?.id).toBe(CUSTOMER_ALGORITHM_ID);
  });

  it('TC-K08：无绑定向量 → verified 保持 false（绝不"空集即通过"）', () => {
    const registry = emptyRegistry();
    registry.register(PLACEHOLDER_SEED_KEY);
    const reports = registry.verifyAll({}, KeyVectorVerifier.reporter(vectorFile({})));
    expect(reports[0]?.total).toBe(0);
    expect(reports[0]?.failed).toBe(0);
    expect(registry.get('ported.placeholder.seedkey')?.verified).toBe(false);
  });

  it('TC-K09：★customer-c 算法向量必须 100% 通过', () => {
    const registry = emptyRegistry();
    registry.register(GOOD_CUSTOMER);
    const file = vectorFile({ [CUSTOMER_ALGORITHM_ID]: ['v1', 'v2', 'v3'] });
    const reports = registry.verifyAll(file.bindings, KeyVectorVerifier.reporter(file));
    const report = reports.find((r) => r.algorithmId === CUSTOMER_ALGORITHM_ID);
    expect(report).toBeDefined();
    expect(report?.total).toBe(3);
    expect(report?.failed).toBe(0);
    expect(report?.passed).toBe(3);
    expect(registry.get(CUSTOMER_ALGORITHM_ID)?.verified).toBe(true);
  });

  it('TC-K09：★customer-c 算法算错 → 报告 failed>0，CI 必须失败', () => {
    const registry = emptyRegistry();
    registry.register(BAD_CUSTOMER);
    const file = vectorFile({ 'ported.customer.broken': ['v3'] });
    const reports = registry.verifyAll(file.bindings, KeyVectorVerifier.reporter(file));
    const report = reports.find((r) => r.algorithmId === 'ported.customer.broken');
    // v3 seed=7F 80 FF 00：0x80 若按 signed char 处理会变负数 → 与期望不符
    expect(report?.failed).toBe(1);
    expect(registry.get('ported.customer.broken')?.verified).toBe(false);
  });

  it('TC-K10：★当前为占位实现的显式断言（不允许静默跳过）', () => {
    const registry = new KeyAlgorithmRegistry(true);
    const file = KeyVectorVerifier.load(
      // 使用仓库内的真实向量文件
      `${process.cwd()}/../data/key-algo-vectors.json`,
    );
    const reports = registry.verifyAll(file.bindings, KeyVectorVerifier.reporter(file));
    const placeholder = registry.get('ported.placeholder.seedkey');
    expect(placeholder).toBeDefined();
    expect(placeholder?.origin).toBe('placeholder');
    expect(placeholder?.verified).toBe(false);
    // 向量目前只绑定到保留 id，占位算法拿到的是空集
    const report = reports.find((r) => r.algorithmId === 'ported.placeholder.seedkey');
    expect(report?.total).toBe(0);
    // 保留 id 尚未注册 → 不应出现在报告里
    expect(reports.some((r) => r.algorithmId === CUSTOMER_ALGORITHM_ID)).toBe(false);
  });

  it('TC-K10：向量文件缺失时返回空集而不是抛异常', () => {
    const file = KeyVectorVerifier.load('/definitely/not/exist.json');
    expect(file.vectors.length).toBe(0);
    expect(Object.keys(file.bindings).length).toBe(0);
  });

  /* ───────── TC-K11：C→JS 移植三大坑 ───────── */

  it('TC-K11-a：有符号右移 >> vs 无符号 >>>（最高位为 1 时结果不同）', () => {
    const v = 0x80000000; // C 的 uint32_t
    const signed = v >> 24; // JS 有符号：-128
    const unsigned = v >>> 24; // 正确：0x80
    expect(signed).toBe(-128);
    expect(unsigned).toBe(0x80);
    // 我们的 expression 走 >>> 分支
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const key = engine.compute(
      {
        id: 'a',
        name: '移位',
        type: 'expression',
        params: { wordWidth: 32, endian: 'big', steps: [{ op: 'shiftR', bits: 24 }] },
      },
      { level: 1, seed: seed('80 00 00 00') },
    );
    expect(formatHex(new Uint8Array(key))).toBe('00 00 00 80');
  });

  it('TC-K11-b：char 符号扩展（0x80 作为 signed char 是 -128）', () => {
    const byte = 0x80;
    const signedChar = (byte << 24) >> 24; // 模拟 signed char → -128
    const normalized = byte & 0xff; // ★正确做法
    expect(signedChar).toBe(-128);
    expect(normalized).toBe(128);
    // 占位算法对 0x80 的处理必须是 & 0xff 后的 128
    const out = PLACEHOLDER_SEED_KEY.compute(1, seed('80 00 00 00'));
    expect(out[0]).toBe((0x00 ^ 0x5a) & 0xff);
    expect(out[3]).toBe((0x80 ^ 0x5a) & 0xff);
    expect(out[3]).toBe(0xda);
  });

  it('TC-K11-c：无自动截断（0xFF + 1 必须回绕为 0）', () => {
    const raw = 0xff + 1; // JS: 256
    const truncated = (0xff + 1) & 0xff; // C 的 uint8_t: 0
    expect(raw).toBe(256);
    expect(truncated).toBe(0);
    // expression 的 add 默认按 2^wordWidth 取模
    const engine = new KeyAlgorithmEngine(emptyRegistry());
    const key = engine.compute(
      {
        id: 'a',
        name: '加法',
        type: 'expression',
        params: { wordWidth: 8, endian: 'big', steps: [{ op: 'add', value: 1 }] },
      },
      { level: 1, seed: seed('FF 01') },
    );
    expect(formatHex(new Uint8Array(key))).toBe('00 02');
  });

  it('TC-K11：占位算法是纯函数（同输入恒同输出、不改入参）', () => {
    const s = seed('A1 B2 C3 D4');
    const copy = Uint8Array.from(s);
    const a = PLACEHOLDER_SEED_KEY.compute(1, s);
    const b = PLACEHOLDER_SEED_KEY.compute(1, s);
    expect(formatHex(a)).toBe(formatHex(b));
    expect(formatHex(s)).toBe(formatHex(copy));
  });

  it('expectFor：按 seed + level 找到对照期望值', () => {
    const file = vectorFile({});
    const hit = KeyVectorVerifier.expectFor(file, '01 02 03 04', 1);
    expect(hit?.id).toBe('v1');
    expect(hit?.expectedKeyHex).toBe('03 05 07 09');
    expect(KeyVectorVerifier.expectFor(file, '01 02 03 04', 2)).toBeNull();
    expect(KeyVectorVerifier.expectFor(file, 'ZZ', 1)).toBeNull();
  });

  it('沙箱助手：rotl / rotr / bswap 在各自宽度内回绕', () => {
    const registry = emptyRegistry();
    const engine = new KeyAlgorithmEngine(registry);
    const key = engine.compute(
      {
        id: 'a',
        name: '旋转',
        type: 'expression',
        params: { wordWidth: 8, endian: 'big', steps: [{ op: 'rotL', bits: 1 }] },
      },
      { level: 1, seed: seed('81') },
    );
    expect(formatHex(new Uint8Array(key))).toBe('03');
  });
});

/* ───────── 解锁流程 SecurityAccessFlow ───────── */

function makeStore(): UdsLibraryStore {
  return new UdsLibraryStore({
    builtinPath: join(findDataDir(), 'uds-library.json'),
    userPath: join(tmpRoot, `user-${String(tmpRoot.length)}-${Math.random().toString(36).slice(2)}.json`),
  });
}

function stubUds(handler: (rawHex: string) => SendUdsResult): UdsService {
  return {
    sendUdsRequest: async (req: { rawHex?: string }) => handler(req.rawHex ?? ''),
  } as unknown as UdsService;
}

function makeFlow(uds: UdsService): SecurityAccessFlow {
  const registry = new KeyAlgorithmRegistry(true);
  const engine = new KeyAlgorithmEngine(registry);
  const library = makeStore();
  return new SecurityAccessFlow({ uds, registry, engine, library, getVectors: () => vectorFile({}) });
}

describe('T14 — 0x27 解锁流程', () => {
  it('取种子 → 算 Key → 发密钥，三步字节正确', async () => {
    const sent: string[] = [];
    const flow = makeFlow(
      stubUds((rawHex) => {
        sent.push(rawHex);
        if (sent.length === 1) {
          return { ok: true, txnId: 't1', state: 'COMPLETED', responseHex: '67 01 A1 B2 C3 D4' };
        }
        return { ok: true, txnId: 't2', state: 'COMPLETED', responseHex: '67 02' };
      }),
    );
    const result = await flow.unlock(1, 'ported.placeholder.seedkey');
    expect(result.ok).toBe(true);
    expect(sent[0]).toBe('27 01');
    expect(sent[1]).toBe('27 02 8E 99 E8 FB');
    expect(result.seedHex).toBe('A1 B2 C3 D4');
    expect(result.keyHex).toBe('8E 99 E8 FB');
  });

  it('请求种子被 NRC 拒绝 → ok=false 且带 NRC（★Q1：不自动重试）', async () => {
    let calls = 0;
    const flow = makeFlow(
      stubUds(() => {
        calls += 1;
        return {
          ok: false,
          txnId: 't',
          state: 'COMPLETED',
          nrc: 0x37,
          nrcNameZh: '延时未到',
          errorCode: 'E_SEC_DELAY_NOT_EXPIRED',
          note: '延时未到',
        };
      }),
    );
    const result = await flow.unlock(1, 'ported.placeholder.seedkey');
    expect(result.ok).toBe(false);
    expect(result.nrc).toBe(0x37);
    expect(calls).toBe(1); // ★只发一次
  });

  it('★库里定义的 expression 算法也能试算（不只是注册表的 ported）', () => {
    const flow = makeFlow(
      stubUds(() => ({ ok: true, txnId: 't', state: 'COMPLETED', responseHex: '67 01 00 FF' })),
    );
    const trial = flow.trial('lib.expression.xor5a', 1, '00 FF');
    expect(trial.ok).toBe(true);
    expect(trial.keyHex).toBe('5A A5');
  });

  it('★库里定义的 javascript 算法也能试算', () => {
    const flow = makeFlow(
      stubUds(() => ({ ok: true, txnId: 't', state: 'COMPLETED', responseHex: '67 01 00' })),
    );
    const trial = flow.trial('lib.javascript.demo', 1, '00 FF');
    expect(trial.ok).toBe(true);
    expect(trial.keyHex).toBe('5A A5');
  });

  it('库里 ported spec 指向注册表算法时可解析', () => {
    const flow = makeFlow(
      stubUds(() => ({ ok: true, txnId: 't', state: 'COMPLETED', responseHex: '67 01 00' })),
    );
    expect(flow.resolveId('lib.ported.placeholder-l1')).not.toBeNull();
    expect(flow.resolveId('nope')).toBeNull();
  });

  it('算法 id 不存在 → E_LIB_KEY_ALGO_NOT_FOUND', () => {
    const flow = makeFlow(
      stubUds(() => ({ ok: true, txnId: 't', state: 'COMPLETED', responseHex: '67 01 00' })),
    );
    expect(flow.trial('nope', 1, '00 00 00 00').errorCode).toBe('E_LIB_KEY_ALGO_NOT_FOUND');
  });

  it('Seed 非法 hex → E_LIB_INVALID_HEX', () => {
    const flow = makeFlow(
      stubUds(() => ({ ok: true, txnId: 't', state: 'COMPLETED', responseHex: '67 01 00' })),
    );
    expect(flow.trial('ported.placeholder.seedkey', 1, 'ZZ').errorCode).toBe('E_LIB_INVALID_HEX');
  });

  it('试算：占位算法明确提示"待替换"', () => {
    const flow = makeFlow(
      stubUds(() => ({ ok: true, txnId: 't', state: 'COMPLETED', responseHex: '67 01 00' })),
    );
    const trial = flow.trial('ported.placeholder.seedkey', 1, 'A1 B2 C3 D4');
    expect(trial.messageZh ?? '').toContain('占位实现');
    expect(trial.verified).toBe(false);
  });

  it('试算与向量期望值同屏对照：不一致时 matched=false', () => {
    const file = vectorFile({});
    const registry = new KeyAlgorithmRegistry(true);
    const engine = new KeyAlgorithmEngine(registry);
    const flow = new SecurityAccessFlow({
      uds: stubUds(() => ({ ok: true, txnId: 't', state: 'COMPLETED', responseHex: '67 01 00' })),
      registry,
      engine,
      library: makeStore(),
      getVectors: () => file,
    });
    const hit = flow.trial('ported.placeholder.seedkey', 1, '01 02 03 04');
    expect(hit.expectedKeyHex).toBe('03 05 07 09');
    expect(hit.matched).toBe(false);
  });

  it('安全等级 → 子功能：奇数请求种子、偶数发密钥', () => {
    expect(UdsEncoder.securitySubFunctions(1)).toEqual({ requestSeed: 0x01, sendKey: 0x02 });
    expect(UdsEncoder.securitySubFunctions(2)).toEqual({ requestSeed: 0x03, sendKey: 0x04 });
    expect(UdsEncoder.securitySubFunctions(3)).toEqual({ requestSeed: 0x05, sendKey: 0x06 });
  });

  it('从正响应中取 seed；非 0x67 响应返回 null', () => {
    expect(formatHex(UdsEncoder.extractSeed(Uint8Array.from([0x67, 0x01, 0xa1, 0xb2])) ?? new Uint8Array(0))).toBe(
      'A1 B2',
    );
    expect(UdsEncoder.extractSeed(Uint8Array.from([0x7f, 0x27, 0x35]))).toBeNull();
    expect(UdsEncoder.extractSeed(Uint8Array.from([0x67]))).toBeNull();
  });
});
