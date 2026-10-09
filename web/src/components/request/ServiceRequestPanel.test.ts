import { describe, expect, it } from 'vitest';
import { isDestructiveHex, isDestructiveRequest } from './ServiceRequestPanel';

/**
 * ★P0#4 前后端口径一致性回归：
 * 后端 UdsService.describeDestructive 的危险集 = 0x11/0x14/0x2E/0x31 + 0x27 偶数子功能。
 * 前端 B 区破坏性判定必须与它**逐字节同口径**——漏一个，用户就吃 E_UDS_CONFIRM_REQUIRED；
 * 多一个，就是无谓弹窗。
 */

describe('P0-FE#4 — isDestructiveHex 与后端同口径', () => {
  it('四个破坏性 SID 全命中', () => {
    expect(isDestructiveHex('11 01')).toBe(true);
    expect(isDestructiveHex('14 FFFF FF')).toBe(true);
    expect(isDestructiveHex('2E F1 90 41')).toBe(true);
    expect(isDestructiveHex('31 01 FF 00')).toBe(true);
  });

  it('★0x27 只拦偶数子功能（发送密钥）；取种子（奇数）与空子功能不拦', () => {
    expect(isDestructiveHex('27 02')).toBe(true);
    expect(isDestructiveHex('2704')).toBe(true);
    expect(isDestructiveHex('27 01')).toBe(false);
    expect(isDestructiveHex('2703')).toBe(false);
    expect(isDestructiveHex('27')).toBe(false); // 无子功能字节：后端 describeDestructive 同样不拦
  });

  it('常规读取类不拦', () => {
    expect(isDestructiveHex('22 F1 90')).toBe(false);
    expect(isDestructiveHex('3E')).toBe(false);
    expect(isDestructiveHex('10 03')).toBe(false);
  });

  it('非法/空输入不炸且不判危险', () => {
    expect(isDestructiveHex('')).toBe(false);
    expect(isDestructiveHex('ZZ')).toBe(false);
  });
});

/**
 * ★#4 裁定①回归：组合判定**与模式无关**（评审裁定进本批的那一行）。
 * 教训：库内置 0x27 表单含 SendKey 选项但未标 destructive——旧写法
 * `mode==='raw' && isDestructiveHex(...)` 会漏弹 B17，请求被后端拒发。
 */
describe('P0-FE#4 裁定① — isDestructiveRequest 按最终字节', () => {
  it('★表单模式产物（svc 未标 destructive）只要是 27 偶数子功能仍判危险', () => {
    expect(isDestructiveRequest({ destructive: false }, '2702AABB')).toBe(true);
    expect(isDestructiveRequest(null, '2702')).toBe(true);
  });

  it('库标记独立生效（字节判定兜不住的库自定义危险服务）', () => {
    expect(isDestructiveRequest({ destructive: true }, '22F190')).toBe(true);
  });

  it('双非 → 不弹框', () => {
    expect(isDestructiveRequest({ destructive: false }, '1003')).toBe(false);
    expect(isDestructiveRequest(null, '3E')).toBe(false);
  });
});
