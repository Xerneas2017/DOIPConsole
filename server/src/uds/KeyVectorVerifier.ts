/**
 * Key 算法测试向量校验（§3.9.2 / T14）。
 *
 * ★CI 硬门槛（TC-K09）：任何 `origin:'customer-c'` 的算法，
 *   其绑定的向量必须 **100% 通过**，否则测试失败。
 * ★TC-K10：向量为空 / 只绑到未注册算法时，不静默跳过 ——
 *   `total === 0` 视为未通过（`verified=false`），占位算法不得蒙混过关。
 */

import { existsSync, readFileSync } from 'node:fs';
import { formatHex, tryParseHex } from '@doip/shared';
import type { KeyTestVector, KeyVectorsFile, VerifyReport } from '@doip/shared';
import { getLogger } from '../logging/logger';
import type { PortedAlgorithmImpl } from './algorithms/KeyAlgorithmRegistry';

export const EMPTY_VECTORS: KeyVectorsFile = {
  schemaVersion: '1.0',
  bindings: {},
  vectors: [],
};

export class KeyVectorVerifier {
  private static readonly log = getLogger('uds.keyVectors');

  /** 读取向量文件；缺失或非法时返回空集（不抛异常，启动不能因此失败） */
  static load(path: string): KeyVectorsFile {
    if (!existsSync(path)) {
      this.log.warn('测试向量文件不存在，所有算法视为未校验', { path });
      return EMPTY_VECTORS;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return this.normalize(parsed);
    } catch (err) {
      this.log.error('测试向量文件解析失败，所有算法视为未校验', {
        path,
        message: err instanceof Error ? err.message : String(err),
      });
      return EMPTY_VECTORS;
    }
  }

  private static normalize(input: unknown): KeyVectorsFile {
    if (typeof input !== 'object' || input === null) return EMPTY_VECTORS;
    const raw = input as { bindings?: unknown; vectors?: unknown };
    const vectors: KeyTestVector[] = [];
    if (Array.isArray(raw.vectors)) {
      for (const item of raw.vectors) {
        const v = item as Partial<KeyTestVector>;
        if (typeof v.id !== 'string' || typeof v.seedHex !== 'string' || typeof v.expectedKeyHex !== 'string') {
          continue;
        }
        vectors.push({
          id: v.id,
          level: typeof v.level === 'number' ? v.level : 1,
          seedHex: v.seedHex,
          expectedKeyHex: v.expectedKeyHex,
          ...(typeof v.source === 'string' ? { source: v.source } : {}),
          ...(typeof v.note === 'string' ? { note: v.note } : {}),
        });
      }
    }
    const bindings: Record<string, string[]> = {};
    if (typeof raw.bindings === 'object' && raw.bindings !== null) {
      for (const [key, value] of Object.entries(raw.bindings as Record<string, unknown>)) {
        if (Array.isArray(value)) bindings[key] = value.filter((v): v is string => typeof v === 'string');
      }
    }
    return { schemaVersion: '1.0', bindings, vectors };
  }

  /** 对单个算法 + 一组向量做比对 */
  static verify(algorithm: PortedAlgorithmImpl, vectors: KeyTestVector[]): VerifyReport {
    const failures: VerifyReport['failures'] = [];
    let passed = 0;
    for (const vector of vectors) {
      const seed = tryParseHex(vector.seedHex);
      const expected = tryParseHex(vector.expectedKeyHex);
      if (seed === null || expected === null) {
        failures.push({
          vectorId: vector.id,
          expectedKeyHex: vector.expectedKeyHex,
          actualKeyHex: '<向量 hex 非法>',
        });
        continue;
      }
      let actualHex = '<执行失败>';
      try {
        const key = algorithm.compute(vector.level, seed);
        actualHex = formatHex(Uint8Array.from(key));
      } catch (err) {
        actualHex = `<执行失败：${err instanceof Error ? err.message : String(err)}>`;
      }
      const expectedHex = formatHex(expected);
      if (actualHex === expectedHex) passed += 1;
      else failures.push({ vectorId: vector.id, expectedKeyHex: expectedHex, actualKeyHex: actualHex });
    }
    return {
      algorithmId: algorithm.id,
      total: vectors.length,
      passed,
      failed: failures.length,
      failures,
    };
  }

  /** 按 id 列表取向量（找不到就跳过，并在日志里点名） */
  static pick(file: KeyVectorsFile, ids: string[]): KeyTestVector[] {
    const byId = new Map(file.vectors.map((v) => [v.id, v]));
    const out: KeyTestVector[] = [];
    for (const id of ids) {
      const vector = byId.get(id);
      if (vector === undefined) {
        this.log.warn('向量 id 不存在', { id });
        continue;
      }
      out.push(vector);
    }
    return out;
  }

  /** 生成注册表 `verifyAll` 需要的比对回调 */
  static reporter(file: KeyVectorsFile): (a: PortedAlgorithmImpl, ids: string[]) => VerifyReport {
    return (algorithm, ids) => this.verify(algorithm, this.pick(file, ids));
  }

  /** 找出同 seed 的期望值（UI 试算同屏对照） */
  static expectFor(file: KeyVectorsFile, seedHex: string, level: number): KeyTestVector | null {
    const seed = tryParseHex(seedHex);
    if (seed === null) return null;
    const wanted = formatHex(seed);
    for (const vector of file.vectors) {
      const candidate = tryParseHex(vector.seedHex);
      if (candidate === null) continue;
      if (formatHex(candidate) !== wanted) continue;
      if (vector.level !== level) continue;
      return vector;
    }
    return null;
  }
}
