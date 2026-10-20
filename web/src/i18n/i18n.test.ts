/**
 * i18n 字典守卫（三语完整性）。
 *
 * 编译期已由 `satisfies Dict` 保证「不多不少」，这里再守两道运行期红线：
 *  1. 三语键集完全一致（防止有人用 `Record<string, string>` 绕过类型）；
 *  2. 不允许空翻译（空串会让界面出现"消失的按钮"）。
 */

import { describe, expect, it } from 'vitest';
import { zh } from './zh';
import { en } from './en';
import { de } from './de';

describe('i18n 字典', () => {
  it('zh / en / de 键集完全一致', () => {
    const zhKeys = Object.keys(zh).sort();
    expect(Object.keys(en).sort()).toEqual(zhKeys);
    expect(Object.keys(de).sort()).toEqual(zhKeys);
  });

  it('没有空翻译', () => {
    for (const [lang, dict] of Object.entries({ zh, en, de })) {
      for (const [key, value] of Object.entries(dict)) {
        expect(value, `${lang} 缺少翻译：${key}`).toBeTruthy();
      }
    }
  });

  it('参数占位符在三语中保持一致（{name} 不能被翻译掉）', () => {
    const placeholders = (text: string): string[] =>
      (text.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort();

    for (const key of Object.keys(zh) as Array<keyof typeof zh>) {
      const expected = placeholders(zh[key]);
      expect(placeholders(en[key]), `en 占位符不一致：${key}`).toEqual(expected);
      expect(placeholders(de[key]), `de 占位符不一致：${key}`).toEqual(expected);
    }
  });
});
