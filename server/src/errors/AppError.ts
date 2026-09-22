/**
 * AppError —— 全后端统一错误对象（§8.2）。
 * 任何跨模块的错误都必须包成 AppError，最终经 `toWsError()` 变成前端可消费的 WsError。
 */

import { getErrorDef, makeWsError, mapSocketErrorCode } from '@doip/shared';
import type { ErrorSeverity, WsError } from '@doip/shared';

export interface AppErrorOptions {
  severity?: ErrorSeverity;
  hintZh?: string;
  retryable?: boolean;
  detail?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  /** 声明为 `string | undefined`（exactOptionalPropertyTypes 下避免显式传 undefined） */
  readonly hintZh: string | undefined;
  readonly detail: unknown;

  constructor(code: string, messageZh?: string, options?: AppErrorOptions) {
    const def = getErrorDef(code);
    super(messageZh ?? def.messageZh);
    this.name = 'AppError';
    this.code = code;
    this.severity = options?.severity ?? def.severity;
    this.retryable = options?.retryable ?? def.retryable;
    this.hintZh = options?.hintZh ?? def.hintZh;
    this.detail = options?.detail;
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }

  toWsError(): WsError {
    const overrides: { hintZh?: string; linkedSeq?: number; detail?: unknown; messageZh?: string } = {};
    if (this.hintZh !== undefined) overrides.hintZh = this.hintZh;
    if (this.detail !== undefined) overrides.detail = this.detail;
    return makeWsError(this.code, { ...overrides, messageZh: this.message });
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** 任意抛出物 → AppError（未预期的用 E_IMPL_UNEXPECTED 兜底） */
export function toAppError(value: unknown, fallbackCode = 'E_IMPL_UNEXPECTED'): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    const nodeCode = (value as NodeJS.ErrnoException).code;
    if (typeof nodeCode === 'string') {
      const mapped = mapSocketErrorCode(nodeCode);
      if (mapped !== 'E_IMPL_UNEXPECTED' || nodeCode === 'EADDRINUSE') {
        return new AppError(mapped, undefined, { detail: { nodeCode, message: value.message }, cause: value });
      }
    }
    return new AppError(fallbackCode, value.message, { detail: { stack: value.stack }, cause: value });
  }
  return new AppError(fallbackCode, String(value), { detail: value });
}

/** Node socket / dgram 错误 → 中文 AppError（★禁止把 ECONNREFUSED 直接丢给用户） */
export function fromNodeError(value: unknown, fallbackCode = 'E_IMPL_UNEXPECTED'): AppError {
  if (isAppError(value)) return value;
  const err = value instanceof Error ? (value as NodeJS.ErrnoException) : undefined;
  const nodeCode = err?.code;
  if (typeof nodeCode === 'string') {
    return new AppError(mapSocketErrorCode(nodeCode), undefined, {
      detail: { nodeCode, message: err?.message ?? null },
      cause: value,
    });
  }
  return toAppError(value, fallbackCode);
}

/** 任意抛出物 → WsError */
export function errorToWsError(value: unknown, fallbackCode?: string): WsError {
  return (fallbackCode === undefined ? toAppError(value) : toAppError(value, fallbackCode)).toWsError();
}
