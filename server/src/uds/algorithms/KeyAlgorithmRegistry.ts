/**
 * 移植算法注册表（§3.9.1 / T14）。
 *
 * ★主路径：把客户 算法逐行翻译成 TS，作为**具名算法**注册进来。
 *   通用兜底（constant / expression / javascript）仍在，但不是主路径。
 * ★`ported` 算法走正常模块加载，不进 vm 沙箱。
 */

import type { PortedAlgorithm, VerifyReport } from '@doip/shared';
import { getLogger } from '../../logging/logger';
import { PLACEHOLDER_SEED_KEY } from './ported/CustomerSeedKey';

/** 注册项 = 元数据 + 纯函数实现 */
export interface PortedAlgorithmImpl extends PortedAlgorithm {
  /**
   * 纯函数：同样输入恒定同样输出，无副作用 / 无 I/O。
   * ★移植三个坑：有符号移位（用 `>>>`）、char 符号扩展（先 `& 0xFF`）、
   *   JS 不自动截断（每步后显式 `& 0xFF` / `>>> 0`）。
   */
  compute(level: number, seed: Uint8Array): Uint8Array;
}

/** 排序权重：ported 在前、placeholder 最后 */
function sortKey(a: PortedAlgorithm): number {
  if (a.origin === 'placeholder') return 2;
  if (!a.verified) return 1;
  return 0;
}

export class KeyAlgorithmRegistry {
  private readonly log = getLogger('uds.keyRegistry');
  private readonly byId = new Map<string, PortedAlgorithmImpl>();

  constructor(registerBuiltin = true) {
    if (registerBuiltin) {
      this.register(PLACEHOLDER_SEED_KEY);
    }
  }

  register(algorithm: PortedAlgorithmImpl): void {
    if (this.byId.has(algorithm.id)) {
      this.log.warn('算法重复注册，已覆盖', { id: algorithm.id });
    }
    this.byId.set(algorithm.id, algorithm);
    this.log.info('Key 算法已注册', {
      id: algorithm.id,
      origin: algorithm.origin,
      levels: algorithm.appliesToLevels,
    });
  }

  unregister(id: string): void {
    this.byId.delete(id);
  }

  get(id: string): PortedAlgorithmImpl | undefined {
    return this.byId.get(id);
  }

  list(): PortedAlgorithm[] {
    return this.listForLevel(null);
  }

  /**
   * UI 下拉数据源：ported 在前、placeholder 最后。
   * @param level 传 null 表示不过滤等级
   */
  listForLevel(level: number | null): PortedAlgorithm[] {
    const out: PortedAlgorithmImpl[] = [];
    for (const algorithm of this.byId.values()) {
      if (level !== null && !algorithm.appliesToLevels.includes(level)) continue;
      out.push(algorithm);
    }
    out.sort((a, b) => sortKey(a) - sortKey(b) || a.id.localeCompare(b.id));
    return out.map((a) => this.toMeta(a));
  }

  /** 脱敏后的元数据（不含 compute，可安全下发前端） */
  toMeta(algorithm: PortedAlgorithmImpl): PortedAlgorithm {
    return {
      id: algorithm.id,
      nameZh: algorithm.nameZh,
      appliesToLevels: [...algorithm.appliesToLevels],
      seedLengthBytes: algorithm.seedLengthBytes,
      keyLengthBytes: algorithm.keyLengthBytes,
      origin: algorithm.origin,
      verified: algorithm.verified,
      ...(algorithm.notes === undefined ? {} : { notes: algorithm.notes }),
    };
  }

  setVerified(id: string, verified: boolean): void {
    const algorithm = this.byId.get(id);
    if (algorithm === undefined) return;
    algorithm.verified = verified;
  }

  /**
   * 对所有已注册算法跑一遍向量校验，并按结果回写 `verified`。
   *
   * ★返回**每个算法一份**报告（设计稿写的是单个 VerifyReport，
   *   但 N 个算法无法用一份报告表达，这里按算法返回数组，语义更严格）。
   * ★`total === 0`（无绑定向量）视为**未通过**——防止占位算法"空集即通过"蒙混过关。
   *
   * @param vectorsOf 算法 id → 绑定的向量 id 列表
   * @param reportOf  真正的比对逻辑（由 `KeyVectorVerifier` 注入，避免注册表依赖文件 I/O）
   */
  verifyAll(
    vectorsOf: Record<string, string[]>,
    reportOf: (algorithm: PortedAlgorithmImpl, vectorIds: string[]) => VerifyReport,
  ): VerifyReport[] {
    const reports: VerifyReport[] = [];
    for (const algorithm of this.byId.values()) {
      const ids = vectorsOf[algorithm.id];
      const list = Array.isArray(ids) ? ids : [];
      const report = reportOf(algorithm, list);
      reports.push(report);
      const passed = report.total > 0 && report.failed === 0;
      algorithm.verified = passed;
      if (!passed) {
        this.log.warn('Key 算法未通过向量校验', {
          id: algorithm.id,
          origin: algorithm.origin,
          total: report.total,
          failed: report.failed,
        });
      }
    }
    return reports;
  }
}
