/**
 * UDS 会话与安全等级推断（§3.7）。
 *
 * ★设计约束：状态**只由 Trace 事实驱动**（不靠本地猜测）——
 *   - 收到 `10 <sub>` 正响应（且未被抑制）→ 切到对应会话；`7F 10 xx` → 不变
 *   - `27 <odd>` 取种子 + `27 <even>` 正响应 → 加入 securityLevels
 *   - 连接断开 / ECU 复位（0x11）→ 回 DEFAULT 并清空已解锁等级
 * 这样保证 UI 显示与真实报文一致，不会出现"UI 说已解锁但 ECU 其实没解锁"。
 */

import type { UdsSessionType } from '@doip/shared';
import { getLogger } from '../logging/logger';

/** 诊断会话控制 0x10 的子功能 → 会话类型 */
const SESSION_SUB_TO_TYPE: ReadonlyMap<number, UdsSessionType> = new Map([
  [0x01, 'DEFAULT'],
  [0x02, 'PROGRAMMING'],
  [0x03, 'EXTENDED'],
]);

export interface UdsSessionSnapshot {
  session: UdsSessionType;
  securityLevels: number[];
  /** 最近一次取种子的安全等级（null = 当前无进行中的解锁流程） */
  pendingLevel: number | null;
}

export class UdsSessionTracker {
  private readonly log = getLogger('session.uds');
  private current: UdsSessionType = 'DEFAULT';
  private levels = new Set<number>();
  private pendingLevel: number | null = null;

  get session(): UdsSessionType {
    return this.current;
  }

  get securityLevels(): number[] {
    return [...this.levels].sort((a, b) => a - b);
  }

  snapshot(): UdsSessionSnapshot {
    return {
      session: this.current,
      securityLevels: this.securityLevels,
      pendingLevel: this.pendingLevel,
    };
  }

  /**
   * 观察一条**发出**的 UDS 请求。
   * @param sid 服务 ID
   * @param subFunction 子功能（无子功能的服务传 null）
   */
  observeRequest(sid: number, subFunction: number | null): void {
    if (sid !== 0x27 || subFunction === null) return;
    // 奇数子功能 = 请求种子；记录当前正在解锁的等级
    if (subFunction % 2 === 1) this.pendingLevel = subFunction;
  }

  /**
   * 观察一条**收到**的 UDS 正响应。
   * @param responseSid 响应 SID（请求 SID + 0x40）
   * @param subFunction 响应中的子功能（可能为 null）
   */
  observePositiveResponse(responseSid: number, subFunction: number | null): void {
    const sid = responseSid - 0x40;
    if (sid === 0x10) {
      const sub = subFunction === null ? null : subFunction & 0x7f;
      const next = sub === null ? 'UNKNOWN' : SESSION_SUB_TO_TYPE.get(sub) ?? 'UNKNOWN';
      if (next !== this.current) {
        this.log.info('诊断会话切换', { from: this.current, to: next });
        this.current = next;
      }
      return;
    }
    if (sid === 0x27) {
      // ★只有"偶数子功能（发密钥）的正响应"才算解锁成功；
      //   奇数子功能（取种子）的正响应只是把种子带回来，此时不得计入已解锁等级。
      if (subFunction !== null && subFunction % 2 === 0) {
        const level = this.pendingLevel;
        if (level !== null) {
          this.levels.add(level);
          this.log.info('安全访问解锁成功', { level: `0x${level.toString(16)}` });
        }
        this.pendingLevel = null;
      }
      return;
    }
  }

  /**
   * 观察一条**收到**的 UDS 负响应。
   * @param requestSid 被拒绝的请求 SID
   */
  observeNegativeResponse(requestSid: number): void {
    if (requestSid === 0x27) {
      // 密钥错误 / 次数超限 / 锁定 → 本次解锁流程作废，等级不加
      this.pendingLevel = null;
    }
    // ★0x10 负响应：会话保持不变（设计明确要求）
  }

  /** ECU 复位（0x11）或连接断开：会话回落 DEFAULT、已解锁等级清空 */
  reset(reason: string): void {
    if (this.current !== 'DEFAULT' || this.levels.size > 0) {
      this.log.info('UDS 会话已复位', { reason, from: this.current });
    }
    this.current = 'DEFAULT';
    this.levels.clear();
    this.pendingLevel = null;
  }
}
