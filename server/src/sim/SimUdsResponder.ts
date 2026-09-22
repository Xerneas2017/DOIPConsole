/**
 * 仿真 UDS 应答（§3.10）：0x10 / 0x11 / 0x14 / 0x19 / 0x22 / 0x27 / 0x2E / 0x3E。
 *
 * 本类只处理 UDS 语义（userData → userData），**不感知传输层**；
 * 分包 / ACK / NACK / 故障注入由 DoipEntityServer 负责（分层切分便于 P1 加网关拓扑）。
 */

import { formatCode, formatDid, parseHex, tryParseHex } from '@doip/shared';
import type { SimEntityConfig } from '@doip/shared';
import type { UdsSessionType } from '@doip/shared';
import { getLogger } from '../logging/logger';

/* ─────────────── NRC 常量 ─────────────── */
export const NRC_SERVICE_NOT_SUPPORTED = 0x11;
export const NRC_SUBFUNCTION_NOT_SUPPORTED = 0x12;
export const NRC_INCORRECT_LENGTH = 0x13;
export const NRC_REQUEST_OUT_OF_RANGE = 0x31;
export const NRC_INVALID_KEY = 0x35;
export const NRC_EXCEED_ATTEMPTS = 0x36;
export const NRC_TIME_DELAY_NOT_EXPIRED = 0x37;
export const NRC_SERVICE_NOT_SUPPORTED_IN_SESSION = 0x7f;

/* ─────────────── SID ─────────────── */
export const SID_SESSION_CONTROL = 0x10;
export const SID_ECU_RESET = 0x11;
export const SID_CLEAR_DTC = 0x14;
export const SID_READ_DTC = 0x19;
export const SID_READ_DATA_BY_ID = 0x22;
export const SID_SECURITY_ACCESS = 0x27;
export const SID_WRITE_DATA_BY_ID = 0x2e;
export const SID_TESTER_PRESENT = 0x3e;

/** P2server = 50ms(0x0032)，P2*server = 500ms(0x01F4)（ISO 14229 会话正响应参数） */
const SESSION_PARAM_RECORD = [0x00, 0x32, 0x01, 0xf4];

export type HandleResult =
  | { kind: 'response'; userData: Uint8Array; note?: string }
  | { kind: 'nrc'; nrc: number }
  /** 抑制正响应：一个字节都不回 */
  | { kind: 'ignore' };

export interface EcuRuntimeState {
  session: UdsSessionType;
  unlocked: Set<number>;
  /** level → 连续错误次数 */
  attempts: Map<number, number>;
  /** level → 解锁禁闭截止时刻（mono ms） */
  lockedUntilMs: Map<number, number>;
}

export function createEcuRuntimeState(): EcuRuntimeState {
  return {
    session: 'DEFAULT',
    unlocked: new Set<number>(),
    attempts: new Map<number, number>(),
    lockedUntilMs: new Map<number, number>(),
  };
}

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values.map((v) => v & 0xff));
}

function didBytes(did: number): [number, number] {
  return [(did >> 8) & 0xff, did & 0xff];
}

function readDid(userData: Uint8Array, offset: number): number | null {
  const hi = userData[offset];
  const lo = userData[offset + 1];
  if (hi === undefined || lo === undefined) return null;
  return ((hi << 8) | lo) & 0xffff;
}

export class SimUdsResponder {
  private readonly log = getLogger('sim.uds');

  handle(cfg: SimEntityConfig, state: EcuRuntimeState, userData: Uint8Array, nowMs: number): HandleResult {
    if (userData.length === 0) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
    const sid = userData[0] ?? 0;
    const sidHex = formatCode(sid);
    if (!cfg.supportedSids.some((s) => s.toUpperCase() === sidHex.toUpperCase())) {
      this.log.debug('仿真 ECU 不支持该服务', { la: cfg.logicalAddress, sid: sidHex });
      return { kind: 'nrc', nrc: NRC_SERVICE_NOT_SUPPORTED };
    }
    switch (sid) {
      case SID_SESSION_CONTROL:
        return this.sessionControl(state, userData);
      case SID_ECU_RESET:
        return this.ecuReset(state, userData);
      case SID_CLEAR_DTC:
        return this.clearDtc(cfg, userData);
      case SID_READ_DTC:
        return this.readDtc(cfg, userData);
      case SID_READ_DATA_BY_ID:
        return this.readDataById(cfg, userData);
      case SID_WRITE_DATA_BY_ID:
        return this.writeDataById(cfg, state, userData);
      case SID_SECURITY_ACCESS:
        return this.securityAccess(cfg, state, userData, nowMs);
      case SID_TESTER_PRESENT:
        return this.testerPresent(userData);
      default:
        return { kind: 'nrc', nrc: NRC_SERVICE_NOT_SUPPORTED };
    }
  }

  /* ─────────────── 各服务 ─────────────── */

  private sessionControl(state: EcuRuntimeState, userData: Uint8Array): HandleResult {
    const sub = userData[1];
    if (sub === undefined) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
    const suppress = (sub & 0x80) !== 0;
    const type = sub & 0x7f;
    let next: UdsSessionType;
    switch (type) {
      case 0x01:
        next = 'DEFAULT';
        break;
      case 0x02:
        next = 'PROGRAMMING';
        break;
      case 0x03:
        next = 'EXTENDED';
        break;
      default:
        return { kind: 'nrc', nrc: NRC_SUBFUNCTION_NOT_SUPPORTED };
    }
    state.session = next;
    if (next === 'DEFAULT') state.unlocked.clear();
    if (suppress) return { kind: 'ignore' };
    return { kind: 'response', userData: bytesOf(0x50, type, ...SESSION_PARAM_RECORD) };
  }

  private ecuReset(state: EcuRuntimeState, userData: Uint8Array): HandleResult {
    const sub = userData[1];
    if (sub === undefined) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
    const suppress = (sub & 0x80) !== 0;
    const type = sub & 0x7f;
    if (type !== 0x01 && type !== 0x03) return { kind: 'nrc', nrc: NRC_SUBFUNCTION_NOT_SUPPORTED };
    // 复位：会话回默认、解锁清空、错误计数清零
    state.session = 'DEFAULT';
    state.unlocked.clear();
    state.attempts.clear();
    state.lockedUntilMs.clear();
    if (suppress) return { kind: 'ignore' };
    return { kind: 'response', userData: bytesOf(0x51, type) };
  }

  private clearDtc(cfg: SimEntityConfig, userData: Uint8Array): HandleResult {
    if (userData.length < 4) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
    const before = cfg.dtcs.length;
    cfg.dtcs.length = 0;
    return { kind: 'response', userData: bytesOf(0x54), note: `已清除 ${before} 条 DTC` };
  }

  private readDtc(cfg: SimEntityConfig, userData: Uint8Array): HandleResult {
    const sub = userData[1];
    if (sub === undefined) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
    const mask = userData[2] ?? 0xff;
    if (sub === 0x01) {
      // 19 01：按状态掩码报告 DTC 数量
      const count = cfg.dtcs.filter((d) => (d.status & mask) !== 0).length;
      return { kind: 'response', userData: bytesOf(0x59, 0x01, mask, 0xff, (count >> 8) & 0xff, count & 0xff) };
    }
    if (sub === 0x02) {
      // 19 02：报告已确认 DTC（3 字节码 + 1 字节状态）
      const out: number[] = [0x59, 0x02, mask];
      for (const dtc of cfg.dtcs) {
        if ((dtc.status & mask) === 0) continue;
        const bytes = tryParseHex(dtc.code);
        if (bytes === null || bytes.length < 3) continue;
        out.push(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, dtc.status & 0xff);
      }
      return { kind: 'response', userData: Uint8Array.from(out) };
    }
    return { kind: 'nrc', nrc: NRC_SUBFUNCTION_NOT_SUPPORTED };
  }

  private readDataById(cfg: SimEntityConfig, userData: Uint8Array): HandleResult {
    if (userData.length < 3) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
    const out: number[] = [0x62];
    let offset = 1;
    while (offset + 1 < userData.length) {
      const did = readDid(userData, offset);
      if (did === null) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
      const entry = cfg.dids[formatDid(did)];
      if (entry === undefined) {
        this.log.debug('仿真 ECU 无此 DID', { la: cfg.logicalAddress, did: formatDid(did) });
        return { kind: 'nrc', nrc: NRC_REQUEST_OUT_OF_RANGE };
      }
      const value = tryParseHex(entry.valueHex) ?? new Uint8Array(0);
      const [hi, lo] = didBytes(did);
      out.push(hi, lo, ...value);
      offset += 2;
    }
    return { kind: 'response', userData: Uint8Array.from(out) };
  }

  private writeDataById(cfg: SimEntityConfig, state: EcuRuntimeState, userData: Uint8Array): HandleResult {
    if (userData.length < 3) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
    const did = readDid(userData, 1);
    if (did === null) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
    // 默认会话不允许写 DID（真实 ECU 常见行为）
    if (state.session === 'DEFAULT') return { kind: 'nrc', nrc: NRC_SERVICE_NOT_SUPPORTED_IN_SESSION };
    const entry = cfg.dids[formatDid(did)];
    if (entry === undefined) return { kind: 'nrc', nrc: NRC_REQUEST_OUT_OF_RANGE };
    const data = Uint8Array.from(userData.subarray(3));
    entry.valueHex = Array.from(data)
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join('');
    const [hi, lo] = didBytes(did);
    return { kind: 'response', userData: bytesOf(0x6e, hi, lo) };
  }

  private securityAccess(
    cfg: SimEntityConfig,
    state: EcuRuntimeState,
    userData: Uint8Array,
    nowMs: number,
  ): HandleResult {
    const sub = userData[1];
    if (sub === undefined) return { kind: 'nrc', nrc: NRC_INCORRECT_LENGTH };
    const type = sub & 0x7f;
    const level = type % 2 === 1 ? (type + 1) / 2 : type / 2;
    const levelCfg = cfg.security.levels[level];
    if (levelCfg === undefined) return { kind: 'nrc', nrc: NRC_SUBFUNCTION_NOT_SUPPORTED };

    const lockedUntil = state.lockedUntilMs.get(level) ?? 0;
    if (lockedUntil > nowMs) {
      return { kind: 'nrc', nrc: NRC_TIME_DELAY_NOT_EXPIRED };
    }

    if (type % 2 === 1) {
      // 奇数：请求种子
      const seed = tryParseHex(levelCfg.seedHex) ?? new Uint8Array(0);
      this.log.debug('仿真 ECU 下发种子', { la: cfg.logicalAddress, level, seedHex: levelCfg.seedHex });
      return { kind: 'response', userData: Uint8Array.from([0x67, type, ...seed]) };
    }

    // 偶数：发送密钥
    const key = Uint8Array.from(userData.subarray(2));
    const expected = levelCfg.expectedKeyHex === undefined ? null : tryParseHex(levelCfg.expectedKeyHex);
    if (expected === null) {
      // 未配置期望 Key → 只校验长度非 0 即通过（便于手工测试），并在日志中提示
      this.log.warn('仿真 ECU 未配置 expectedKeyHex，密钥校验放宽', { la: cfg.logicalAddress, level });
      state.unlocked.add(level);
      state.attempts.set(level, 0);
      return { kind: 'response', userData: bytesOf(0x67, type) };
    }
    if (key.length === expected.length && key.every((b, i) => b === expected[i])) {
      state.unlocked.add(level);
      state.attempts.set(level, 0);
      return { kind: 'response', userData: bytesOf(0x67, type) };
    }
    const attempts = (state.attempts.get(level) ?? 0) + 1;
    state.attempts.set(level, attempts);
    const maxAttempts = levelCfg.maxAttempts ?? 3;
    if (attempts >= maxAttempts) {
      state.lockedUntilMs.set(level, nowMs + (levelCfg.lockoutMs ?? 10000));
      return { kind: 'nrc', nrc: NRC_EXCEED_ATTEMPTS };
    }
    return { kind: 'nrc', nrc: NRC_INVALID_KEY };
  }

  private testerPresent(userData: Uint8Array): HandleResult {
    const sub = userData[1] ?? 0x00;
    if ((sub & 0x80) !== 0) return { kind: 'ignore' };
    return { kind: 'response', userData: bytesOf(0x7e, sub & 0x7f) };
  }

  /** 供 VirtualEcu 在 0x14 后清空 DTC 数据集 */
  static clearDtcs(cfg: SimEntityConfig): void {
    cfg.dtcs.length = 0;
  }

  /** 解析 seedHex（供上层使用） */
  static seedBytes(cfg: SimEntityConfig, level: number): Uint8Array {
    const levelCfg = cfg.security.levels[level];
    if (levelCfg === undefined) return new Uint8Array(0);
    return parseHex(levelCfg.seedHex);
  }
}
