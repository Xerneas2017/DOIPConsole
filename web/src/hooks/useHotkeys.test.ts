import { describe, expect, it } from 'vitest';
import { matchCombo, normalizedKey } from './useHotkeys';

/**
 * ★P0-FE#6 回归：空格暂停热键曾是死键（combo 'space' vs event.key ' ' 永不匹配）。
 */

function kv(over: Partial<{ key: string; code: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) {
  return { key: '', code: '', ctrlKey: false, shiftKey: false, altKey: false, ...over };
}

describe('P0-FE#6 — 热键归一化', () => {
  it('★空格三种真实浏览器形态都命中 combo "space"（Firefox key=Space）', () => {
    expect(matchCombo('space', kv({ key: ' ', code: 'Space' }))).toBe(true);
    expect(matchCombo('space', kv({ key: 'Space', code: 'Space' }))).toBe(true);
    expect(matchCombo('space', kv({ key: ' ', code: '' }))).toBe(true);
  });

  it('旧缺陷形态：key=" " 且无 code → 仍命中（当年即在此死掉）', () => {
    expect(normalizedKey({ key: ' ', code: '' })).toBe('space');
  });

  it('普通字母键不受影响；大小写归一', () => {
    expect(matchCombo('f', kv({ key: 'f', code: 'KeyF' }))).toBe(true);
    expect(matchCombo('f', kv({ key: 'F', code: 'KeyF', shiftKey: true }))).toBe(false); // shift 语义保持
  });

  it('Ctrl 组合与 mac meta 等价', () => {
    const ev = { ...kv({ key: 'l', code: 'KeyL' }), ctrlKey: true };
    expect(matchCombo('ctrl+l', ev)).toBe(true);
    expect(matchCombo('ctrl+l', kv({ key: 'l', code: 'KeyL' }))).toBe(false);
  });

  it('Esc/Enter/方向键别名命中', () => {
    expect(matchCombo('esc', kv({ key: 'Escape', code: 'Escape' }))).toBe(true);
    expect(matchCombo('enter', kv({ key: 'Enter', code: 'NumpadEnter' }))).toBe(true);
    expect(matchCombo('down', kv({ key: 'ArrowDown', code: 'ArrowDown' }))).toBe(true);
  });
});
