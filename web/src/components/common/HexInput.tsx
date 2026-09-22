import { useEffect, useState } from 'react';
import { TextField } from '@mui/material';
import { normalizeHex, tryParseHex } from '@doip/shared';

/**
 * 受控 hex 输入（T11，§8.4）：
 * - 用户输入允许小写/无空格/0x 前缀，经 `normalizeHex()` 归一为大写单空格；
 * - 非法输入即时提示（不抛异常，不阻塞输入）。
 */

export interface HexInputProps {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  /** 期望字节数（可选，用于长度校验） */
  expectedBytes?: number;
  size?: 'small' | 'medium';
  fullWidth?: boolean;
  placeholder?: string;
  disabled?: boolean;
}

export function HexInput({
  label,
  value,
  onChange,
  expectedBytes,
  size = 'small',
  fullWidth = true,
  placeholder,
  disabled,
}: HexInputProps): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const handleChange = (next: string): void => {
    setDraft(next);
    const trimmed = next.trim();
    if (trimmed === '') {
      setError(null);
      onChange('');
      return;
    }
    const bytes = tryParseHex(trimmed);
    if (bytes === null) {
      setError('非法 hex：只允许 0-9 / A-F');
      return;
    }
    if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
      setError(`长度应为 ${expectedBytes} 字节，当前 ${bytes.length} 字节`);
      return;
    }
    setError(null);
    try {
      onChange(normalizeHex(trimmed));
    } catch {
      setError('非法 hex 输入');
    }
  };

  return (
    <TextField
      label={label}
      value={draft}
      onChange={(e) => handleChange(e.target.value)}
      error={error !== null}
      helperText={error ?? undefined}
      size={size}
      fullWidth={fullWidth}
      placeholder={placeholder ?? '0x0E00'}
      {...(disabled === undefined ? {} : { disabled })}
      inputProps={{ className: 'mono', spellCheck: false }}
    />
  );
}
