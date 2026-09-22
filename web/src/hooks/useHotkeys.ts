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

function match(combo: string, event: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts[parts.length - 1] ?? '';
  const needCtrl = parts.includes('ctrl') || parts.includes('cmd');
  const needShift = parts.includes('shift');
  const needAlt = parts.includes('alt');
  const hasCtrl = event.ctrlKey || event.metaKey;
  if (needCtrl !== hasCtrl) return false;
  if (needShift !== event.shiftKey) return false;
  if (needAlt !== event.altKey) return false;
  return event.key.toLowerCase() === key;
}

/**
 * 全局快捷键（T10/T11）：Ctrl+K 聚焦过滤框、Space 暂停/继续、Ctrl+L 清除 Trace。
 */
export function useHotkeys(hotkeys: Hotkey[]): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const hk of hotkeys) {
        if (!match(hk.combo, event)) continue;
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
