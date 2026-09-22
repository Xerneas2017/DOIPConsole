/**
 * 故障注入（§3.10 / §5.6）：规则表匹配与执行。
 *
 * 注入点位于**最外层**：DoipEntityServer 收到 0x8001 后先问 FaultInjector.match()，
 * 命中即按 action 处理，不再进 VirtualEcu —— 这样"不响应"是真的不发字节。
 */

import { formatCode, formatLogicalAddress } from '@doip/shared';
import type { FaultRule } from '@doip/shared';
import { getLogger } from '../logging/logger';

export interface FaultMatchContext {
  /** '0x1000' */
  logicalAddress?: string | undefined;
  /** '0x22' */
  sid?: string | undefined;
  subFunction?: string | undefined;
  /** '0xF190' */
  did?: string | undefined;
}

function normHex(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.trim().toUpperCase().replace(/^0X/, '0x');
}

function sameCode(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const na = normHex(a);
  const nb = normHex(b);
  if (na === undefined || nb === undefined) return false;
  const pa = Number.parseInt(na.replace(/^0x/, ''), 16);
  const pb = Number.parseInt(nb.replace(/^0x/, ''), 16);
  return Number.isFinite(pa) && Number.isFinite(pb) && pa === pb;
}

export class FaultInjector {
  private readonly log = getLogger('sim.fault');
  private rules: FaultRule[] = [];

  setRules(rules: FaultRule[]): void {
    // occurrence='once' → remaining 归 1；'always' → 无限；'count' → 沿用传入值
    this.rules = rules.map((rule) => {
      const occurrence = rule.match.occurrence ?? 'always';
      const remaining = occurrence === 'once' ? 1 : occurrence === 'count' ? (rule.remaining ?? 1) : null;
      return { ...rule, remaining };
    });
    this.log.info('故障规则已更新', { count: this.rules.length });
  }

  getRules(): FaultRule[] {
    return this.rules;
  }

  /** 匹配诊断报文（0x8001）级别的故障规则 */
  match(ctx: FaultMatchContext): FaultRule | null {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.remaining !== null && rule.remaining <= 0) continue;
      if (rule.action.kind === 'routingCode') continue; // 路由激活专用
      if (!this.matchesRule(rule, ctx)) continue;
      return rule;
    }
    return null;
  }

  /** 匹配路由激活（0x0005）级别的故障规则 */
  matchRouting(logicalAddress?: string): FaultRule | null {
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (rule.remaining !== null && rule.remaining <= 0) continue;
      if (rule.action.kind !== 'routingCode') continue;
      if (rule.match.logicalAddress !== undefined && !sameCode(rule.match.logicalAddress, logicalAddress)) continue;
      return rule;
    }
    return null;
  }

  /** 消耗一次触发次数，归零则自动禁用 */
  consume(rule: FaultRule): void {
    if (rule.remaining === null) return;
    rule.remaining -= 1;
    if (rule.remaining <= 0) {
      rule.enabled = false;
      this.log.info('故障规则已耗尽并自动禁用', { id: rule.id });
    }
  }

  private matchesRule(rule: FaultRule, ctx: FaultMatchContext): boolean {
    const m = rule.match;
    if (m.logicalAddress !== undefined && !sameCode(m.logicalAddress, ctx.logicalAddress)) return false;
    if (m.sid !== undefined && !sameCode(m.sid, ctx.sid)) return false;
    if (m.subFunction !== undefined) {
      if (ctx.subFunction === undefined) return false;
      if (!sameCode(m.subFunction, ctx.subFunction)) return false;
    }
    if (m.did !== undefined) {
      if (ctx.did === undefined) return false;
      if (!sameCode(m.did, ctx.did)) return false;
    }
    return true;
  }
}

/** 从 UDS 请求里抽取 DID（取第一个 2 字节 DID，供规则匹配） */
export function extractFirstDid(userData: Uint8Array): string | undefined {
  const hi = userData[1];
  const lo = userData[2];
  if (hi === undefined || lo === undefined) return undefined;
  return `0x${(((hi << 8) | lo) & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`;
}

/** 从 UDS 请求里抽取 sid / subFunction（'0x22' 形式） */
export function extractSidAndSub(userData: Uint8Array): { sid?: string; subFunction?: string } {
  const sid = userData[0];
  const sub = userData[1];
  const out: { sid?: string; subFunction?: string } = {};
  if (sid !== undefined) out.sid = formatCode(sid);
  if (sub !== undefined) out.subFunction = formatCode(sub & 0x7f);
  return out;
}

export function formatLaHex(addr: number): string {
  return formatLogicalAddress(addr);
}
