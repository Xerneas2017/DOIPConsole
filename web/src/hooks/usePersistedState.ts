import { useCallback, useEffect, useState } from 'react';

/**
 * localStorage 持久化状态（T09）。
 * 与 `useUiStore` 的偏好项同源口径：读写失败（隐私模式/配额满）不影响运行。
 */

export function usePersistedState<T>(
  key: string,
  initial: T,
  serialize: (v: T) => string = JSON.stringify,
  deserialize: (s: string) => T = JSON.parse as (s: string) => T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      if (raw === null) return initial;
      return deserialize(raw) as T;
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        try {
          window.localStorage.setItem(key, serialize(resolved));
        } catch {
          /* 配额/隐私模式：忽略 */
        }
        return resolved;
      });
    },
    [key, serialize, deserialize],
  );

  useEffect(() => {
    // 首次挂载时把当前值写回，保证 key 存在
    try {
      window.localStorage.setItem(key, serialize(value));
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [value, update];
}
