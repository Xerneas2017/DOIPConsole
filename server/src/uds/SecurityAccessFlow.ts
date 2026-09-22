/**
 * 0x27 安全访问流程（§3.9 / T14）：请求种子 → 算 Key → 发密钥。
 *
 * ★Q1：失败后**不自动重试**，只把 NRC 与处置建议回给前端，由用户决定是否再来一次。
 * ★发送一律走 `UdsService.sendUdsRequest()`（P0-06 唯一入口）。
 */

import { formatHex, tryParseHex } from '@doip/shared';
import type { KeyAlgorithmSpec, KeyTrialResult, UnlockResult } from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { KeyAlgorithmEngine } from './KeyAlgorithmEngine';
import type { KeyAlgorithmRegistry, PortedAlgorithmImpl } from './algorithms/KeyAlgorithmRegistry';
import type { KeyVectorsFile } from '@doip/shared';
import { KeyVectorVerifier } from './KeyVectorVerifier';
import { UdsEncoder } from './UdsEncoder';
import type { UdsLibraryStore } from './UdsLibraryStore';
import type { UdsService } from './UdsService';

export interface SecurityAccessFlowDeps {
  uds: UdsService;
  registry: KeyAlgorithmRegistry;
  engine: KeyAlgorithmEngine;
  /** 服务库：解析库里定义的 constant / expression / javascript 兜底算法 */
  library: UdsLibraryStore;
  getVectors: () => KeyVectorsFile;
}

/** 算法来源解析结果 */
type ResolvedAlgorithm =
  | { kind: 'ported'; algorithm: PortedAlgorithmImpl }
  | { kind: 'spec'; spec: KeyAlgorithmSpec };

export class SecurityAccessFlow {
  private readonly log = getLogger('uds.security');

  constructor(private readonly deps: SecurityAccessFlowDeps) {}

  /** 一键解锁 */
  async unlock(level: number, algorithmId: string): Promise<UnlockResult> {
    const { requestSeed, sendKey } = UdsEncoder.securitySubFunctions(level);
    const resolved = this.resolve(algorithmId);
    if (resolved === null) {
      return {
        ok: false,
        level,
        algorithmId,
        seedHex: null,
        keyHex: null,
        nrc: null,
        nrcNameZh: null,
        errorCode: 'E_LIB_KEY_ALGO_NOT_FOUND',
        note: `未找到 Key 算法：${algorithmId}`,
      };
    }

    /* ① 请求种子 */
    const seedReq = await this.deps.uds.sendUdsRequest({
      addressing: 'physical',
      rawHex: formatHex(UdsEncoder.securityAccessBytes(requestSeed)),
      tag: '0x27请求种子',
    });
    if (!seedReq.ok || seedReq.responseHex === undefined) {
      return {
        ok: false,
        level,
        algorithmId,
        seedHex: null,
        keyHex: null,
        nrc: seedReq.nrc ?? null,
        nrcNameZh: seedReq.nrcNameZh ?? null,
        errorCode: seedReq.errorCode ?? 'E_SEC_NO_SEED',
        note: seedReq.note ?? '请求种子失败',
      };
    }
    const responseBytes = tryParseHex(seedReq.responseHex) ?? new Uint8Array(0);
    if ((responseBytes[0] ?? 0) === 0x7f) {
      return {
        ok: false,
        level,
        algorithmId,
        seedHex: null,
        keyHex: null,
        nrc: seedReq.nrc ?? (responseBytes[2] ?? null),
        nrcNameZh: seedReq.nrcNameZh ?? null,
        errorCode: 'E_SEC_NO_SEED',
        note: `请求种子被拒绝（NRC ${seedReq.nrc ?? responseBytes[2] ?? '?'}）`,
      };
    }
    const seed = UdsEncoder.extractSeed(responseBytes);
    if (seed === null || seed.length === 0) {
      return {
        ok: false,
        level,
        algorithmId,
        seedHex: null,
        keyHex: null,
        nrc: null,
        nrcNameZh: null,
        errorCode: 'E_SEC_NO_SEED',
        note: '响应中没有取到 seed',
      };
    }
    const seedHex = formatHex(seed);

    /* ② 算 Key */
    let keyHex: string;
    try {
      keyHex = formatHex(new Uint8Array(this.computeKey(resolved, level, seed)));
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError('E_LIB_KEY_ALGO_FAILED', String(err));
      this.log.warn('Key 计算失败', { algorithmId, code: appErr.code, message: appErr.message });
      return {
        ok: false,
        level,
        algorithmId,
        seedHex,
        keyHex: null,
        nrc: null,
        nrcNameZh: null,
        errorCode: appErr.code,
        note: appErr.message,
      };
    }

    /* ③ 发密钥 */
    const keyBytes = tryParseHex(keyHex) ?? new Uint8Array(0);
    const keyReq = await this.deps.uds.sendUdsRequest({
      addressing: 'physical',
      rawHex: formatHex(UdsEncoder.securityAccessBytes(sendKey, keyBytes)),
      tag: '0x27发送密钥',
    });
    if (!keyReq.ok) {
      return {
        ok: false,
        level,
        algorithmId,
        seedHex,
        keyHex,
        nrc: keyReq.nrc ?? null,
        nrcNameZh: keyReq.nrcNameZh ?? null,
        errorCode: keyReq.errorCode ?? 'E_SEC_SEND_KEY_FAILED',
        note: keyReq.note ?? '发送密钥失败',
      };
    }
    this.log.info('安全访问已解锁', { level, algorithmId });
    const placeholder =
      resolved.kind === 'ported' && resolved.algorithm.origin === 'placeholder';
    return {
      ok: true,
      level,
      algorithmId,
      seedHex,
      keyHex,
      nrc: null,
      nrcNameZh: null,
      errorCode: null,
      note: placeholder ? '★当前为占位算法，能与真实 ECU 对上属意外之喜' : null,
    };
  }

  /** 试算（不发报文）：输入 Seed → 显示 Key，并与向量期望值同屏对照 */
  trial(algorithmId: string, level: number, seedHex: string): KeyTrialResult {
    const seed = tryParseHex(seedHex);
    const base: KeyTrialResult = {
      ok: false,
      algorithmId,
      level,
      seedHex,
      keyHex: null,
      expectedKeyHex: null,
      matched: null,
      verified: false,
      errorCode: null,
      messageZh: null,
    };
    const resolved = this.resolve(algorithmId);
    if (resolved === null) {
      return { ...base, errorCode: 'E_LIB_KEY_ALGO_NOT_FOUND', messageZh: `未找到 Key 算法：${algorithmId}` };
    }
    if (seed === null || seed.length === 0) {
      return { ...base, errorCode: 'E_LIB_INVALID_HEX', messageZh: `Seed 非法："${seedHex}"` };
    }
    let keyHex: string;
    try {
      keyHex = formatHex(new Uint8Array(this.computeKey(resolved, level, seed)));
    } catch (err) {
      const appErr = err instanceof AppError ? err : new AppError('E_LIB_KEY_ALGO_FAILED', String(err));
      return {
        ...base,
        verified: resolved.kind === 'ported' && resolved.algorithm.verified,
        errorCode: appErr.code,
        messageZh: appErr.message,
      };
    }
    const vector = KeyVectorVerifier.expectFor(this.deps.getVectors(), seedHex, level);
    const expectedKeyHex = vector?.expectedKeyHex ?? null;
    const matched = expectedKeyHex === null ? null : keyHex === expectedKeyHex;
    const placeholder = resolved.kind === 'ported' && resolved.algorithm.origin === 'placeholder';
    return {
      ...base,
      ok: true,
      keyHex,
      expectedKeyHex,
      matched,
      verified: resolved.kind === 'ported' && resolved.algorithm.verified,
      ...(placeholder
        ? { messageZh: '★当前为占位实现（待替换为客户 代码），结果不可用于真实 ECU' }
        : {}),
    };
  }

  /* ─────────────── 内部 ─────────────── */

  /**
   * 解析算法 id：先查注册表（具名移植算法），再查服务库（constant/expression/javascript）。
   * ★两者都能解锁，避免"库里配好的算法在 UI 上选不了"。
   */
  resolveId(algorithmId: string): ResolvedAlgorithm | null {
    return this.resolve(algorithmId);
  }

  private resolve(algorithmId: string): ResolvedAlgorithm | null {
    const algorithm = this.deps.registry.get(algorithmId);
    if (algorithm !== undefined) return { kind: 'ported', algorithm };
    for (const spec of this.deps.library.keyAlgorithms()) {
      if (spec.id === algorithmId) return { kind: 'spec', spec };
      if (spec.type === 'ported' && spec.algorithmId === algorithmId) {
        const inner = this.deps.registry.get(spec.algorithmId);
        if (inner !== undefined) return { kind: 'ported', algorithm: inner };
      }
    }
    return null;
  }

  private computeKey(resolved: ResolvedAlgorithm, level: number, seed: Uint8Array): Buffer {
    const ctx = { level, seed: Uint8Array.from(seed) };
    if (resolved.kind === 'ported') {
      return this.deps.engine.computeById(resolved.algorithm.id, ctx);
    }
    return this.deps.engine.compute(resolved.spec, ctx);
  }
}
