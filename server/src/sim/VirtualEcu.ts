/**
 * 单个虚拟 ECU：持有会话/解锁状态，把 UDS 语义委托给 SimUdsResponder。
 * ★不感知传输层 —— P1 加"网关 + 子网拓扑"时本类零改动（§3.10 / A10）。
 */

import { formatLogicalAddress, nowMonoMs, parseLogicalAddress } from '@doip/shared';
import type { SimEntityConfig } from '@doip/shared';
import type { UdsSessionType } from '@doip/shared';
import { SimUdsResponder } from './SimUdsResponder';
import type { EcuRuntimeState, HandleResult } from './SimUdsResponder';
import { createEcuRuntimeState } from './SimUdsResponder';

export class VirtualEcu {
  private cfg: SimEntityConfig;
  private state: EcuRuntimeState = createEcuRuntimeState();
  private readonly responder = new SimUdsResponder();

  constructor(cfg: SimEntityConfig) {
    this.cfg = cfg;
  }

  get logicalAddress(): number {
    return parseLogicalAddress(this.cfg.logicalAddress);
  }

  get logicalAddressHex(): string {
    return formatLogicalAddress(this.logicalAddress);
  }

  get config(): SimEntityConfig {
    return this.cfg;
  }

  get session(): UdsSessionType {
    return this.state.session;
  }

  get unlockedLevels(): number[] {
    return [...this.state.unlocked].sort((a, b) => a - b);
  }

  /** 处理一条 UDS 请求，返回应答语义（不含传输层封装） */
  handleUds(userData: Uint8Array, nowMs: number = nowMonoMs()): HandleResult {
    return this.responder.handle(this.cfg, this.state, userData, nowMs);
  }

  /** 复位到上电默认状态 */
  reset(): void {
    this.state = createEcuRuntimeState();
  }

  /** 热改数据集（VIN / DID / DTC / 时序），无需重启仿真 */
  patch(patch: Partial<SimEntityConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  getState(): { session: UdsSessionType; unlocked: number[] } {
    return { session: this.state.session, unlocked: this.unlockedLevels };
  }
}
