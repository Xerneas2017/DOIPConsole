import { describe, expect, it } from 'vitest';
import type { KeyAlgorithmDescriptor } from '@doip/shared';
import { requiresStrongConfirm } from './SecurityAccessPanel';

/**
 * ★P0-FE#4 回归：0x27 解锁强确认门禁的判定口径。
 *
 * 规则：只有**通过向量校验**（verified=true）的算法可以免确认直接解锁；
 * 未验证 / 占位算法一律需要强确认对话框 + `confirmed:true`。
 */

function algo(over: Partial<KeyAlgorithmDescriptor>): KeyAlgorithmDescriptor {
  return {
    id: 'a',
    nameZh: '算法A',
    provider: 'ported',
    origin: 'ported',
    appliesToLevels: [1],
    verified: false,
    ...over,
  } as unknown as KeyAlgorithmDescriptor;
}

describe('P0-FE#4 — requiresStrongConfirm', () => {
  it('未验证的移植算法需要强确认', () => {
    expect(requiresStrongConfirm(algo({ verified: false }))).toBe(true);
  });

  it('占位算法（未验证）需要强确认', () => {
    expect(
      requiresStrongConfirm(algo({ origin: 'placeholder', verified: false })),
    ).toBe(true);
  });

  it('已通过向量校验的算法免强确认', () => {
    expect(requiresStrongConfirm(algo({ verified: true }))).toBe(false);
  });

  it('无选中算法不放行（返回 false，由调用方按钮禁用兜底）', () => {
    expect(requiresStrongConfirm(null)).toBe(false);
  });
});
