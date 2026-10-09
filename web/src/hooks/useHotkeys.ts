import { useEffect } from 'react';

export interface Hotkey {
  /** 如 'ctrl+k' / 'space' / 'f' */
  combo: string;
  handler: (event: KeyboardEvent) => void;
  /** 输入框聚焦时是否仍然生效（默认 false，避免抢输入） */
  allowInInput?: boolean;
}

function isEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

/**
 * ★P0-FE#6：' '（空格）与特殊键的归一化。
 * 旧实现用 event.key 直接比较 combo：空格键的 key 是 ' '（还有 macOS 的 'Space' 变体），
 * combo 'space' 永远匹配不上——暂停热键是死键。现按 e.code 优先归一 + key 别名兜底。
 */
const CODE_ALIASES: Record<string, string> = {
  space: 'space',
  enter: 'enter',
  numpadenter: 'enter',
  escape: 'esc',
  tab: 'tab',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

export function normalizedKey(ev: { key: string; code?: string }): string {
  const byCode = ev.code !== undefined ? CODE_ALIASES[ev.code.toLowerCase()] : undefined;
  if (byCode !== undefined) return byCode;
  const k = ev.key.toLowerCase();
  if (k === ' ' || k === 'spacebar') return 'space';
  if (k === 'escape') return 'esc';
  return k;
}

/** 纯匹配函数（供单测直接打）：combo 如 'ctrl+k' / 'space' / 'f' */
export function matchCombo(
  combo: string,
  ev: { key: string; code?: string; ctrlKey: boolean; metaKey?: boolean; shiftKey: boolean; altKey: boolean },
): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  const needCtrl = parts.includes('ctrl') || parts.includes('cmd');
  const needShift = parts.includes('shift');
  const needAlt = parts.includes('alt');
  // 布尔归一：可选 metaKey/shiftKey/altKey 传 undefined 时不能落到 `false !== undefined` 的严格比较
  const hasCtrl = ev.ctrlKey === true || ev.metaKey === true;
  if (needCtrl !== hasCtrl) return false;
  if (needShift !== (ev.shiftKey === true)) return false;
  if (needAlt !== (ev.altKey === true)) return false;
  return normalizedKey(ev) === key;
}

/**
 * 全局快捷键（T10/T11）：Ctrl+K 聚焦过滤框、Space 暂停/继续、Ctrl+L 清除 Trace。
 */
export function useHotkeys(hotkeys: Hotkey[]): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const hk of hotkeys) {
        if (!matchCombo(hk.combo, event)) continue;
        if (!hk.allowInInput && isEditingTarget(event.target)) continue;
        event.preventDefault();
        hk.handler(event);
        return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [hotkeys]);
}
