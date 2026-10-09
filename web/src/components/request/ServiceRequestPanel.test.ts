import { describe, expect, it } from 'vitest';
import { isDestructiveHex } from './ServiceRequestPanel';

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
