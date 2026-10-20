/**
 * 轻量 i18n（中文 / English / Deutsch）。
 *
 * 用法：
 *   const t = useT();               // 组件内（订阅语言变化，切换即重渲）
 *   t('连接')                        // 静态文案
 *   t('导入的文件不是合法 JSON')      // key 拼错 → 编译期报错（TKey 约束）
 *   t('带入 {endpoint}', { endpoint: '127.0.0.1:13401' })
 *
 * 非组件模块（store / ws）需要时用 `t(...)`（读取当前语言快照）。
 */

import { useCallback } from 'react';
import { create } from 'zustand';
import { zh } from './zh';
import { en } from './en';
import { de } from './de';
import type { Dict, Lang, TFunc, TKey, TParams } from './types';

const DICTS: Record<Lang, Dict> = { zh, en, de };

const STORAGE_KEY = 'doip.lang';

export const LANG_OPTIONS: ReadonlyArray<{ value: Lang; short: string; labelKey: TKey }> = [
  { value: 'zh', short: '中', labelKey: '简体中文' },
  { value: 'en', short: 'EN', labelKey: '英文' },
  { value: 'de', short: 'DE', labelKey: '德语' },
];

/** 初始语言：持久化偏好 > 浏览器语言（de/en）> 中文 */
function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh' || saved === 'en' || saved === 'de') return saved;
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  const nav = typeof navigator === 'undefined' ? 'zh' : navigator.language.toLowerCase();
  if (nav.startsWith('de')) return 'de';
  if (nav.startsWith('en')) return 'en';
  return 'zh';
}

interface I18nState {
  lang: Lang;
  setLang(lang: Lang): void;
}

export const useI18nStore = create<I18nState>((set) => ({
  lang: detectInitialLang(),
  setLang: (lang) => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
    set({ lang });
  },
}));

function translate(lang: Lang, key: TKey, params?: TParams): string {
  const dict = DICTS[lang] ?? zh;
  let text: string = dict[key] ?? zh[key] ?? key;
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** 当前语言快照（非组件模块用；组件请用 useT） */
export function t(key: TKey, params?: TParams): string {
  return translate(useI18nStore.getState().lang, key, params);
}

/** 组件内翻译函数：语言切换时自动重渲 */
export function useT(): TFunc {
  const lang = useI18nStore((s) => s.lang);
  return useCallback<TFunc>((key, params) => translate(lang, key, params), [lang]);
}

export type { Lang, TKey, TFunc } from './types';
