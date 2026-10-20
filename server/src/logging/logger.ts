/**
 * 结构化日志（§8.3）—— M2 起换成 **pino**（高频 Trace 场景下性能远好于 console）。
 *
 * 字段契约与 M1 保持一致：`{ts, level, mod, msg, ...ctx}`，mod 即目录名
 * （doip.frame / txn / sim.uds / bridge.flusher / ...）。
 *
 * 环境变量：
 *  - `DOIP_LOG_LEVEL`：trace / debug / info / warn / error（默认 info）
 *  - `DOIP_LOG_FRAMES=1`：打开每帧 trace（默认关闭）
 *  - `DOIP_LOG_PRETTY=1`：dev 下用 pino-pretty 输出可读日志（默认关闭，避免测试环境挂住）
 *  - `DOIP_LOG_FILE=0`：**关闭文件日志**（默认开启，写 `~/.doip-console/logs/`）
 *
 * ★文件日志：每条经 `write()` 的日志**同时**写一份到 `~/.doip-console/logs/backend-*.log`。
 *   终端关掉/打包后仍留痕，出问题可在界面里直接查看尾部。写日志失败只累加 dropped，
 *   绝不影响主链路，也绝不抛。
 */

import pino from 'pino';
import type { Logger as PinoLoggerType, LoggerOptions } from 'pino';
import { getFileLogSink } from './fileLog';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

function defaultLevel(): LogLevel {
  const raw = process.env['DOIP_LOG_LEVEL'];
  if (raw === 'trace' || raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

let currentLevel: LogLevel = defaultLevel();
let framesEnabled = process.env['DOIP_LOG_FRAMES'] === '1';
/** 文件日志开关（默认开；`DOIP_LOG_FILE=0` 关闭） */
const fileLogEnabled = process.env['DOIP_LOG_FILE'] !== '0';

/**
 * ★CLI 适配：彻底静音（连同文件日志）。
 *
 * 命令行工具的 stdout 必须**只留业务输出**（尤其是 `--json`），
 * 而后端各模块在 info 级会打连接/激活日志，直接混进 stdout 会破坏管道解析。
 * 静音后 write() 直接返回，也不创建文件日志 sink —— 进程可干净退出。
 */
let silenced = false;

export function silenceLogs(): void {
  silenced = true;
}

/**
 * 写一份到文件日志。
 *
 * ★这里必须"永不抛、永不阻塞"：日志本身绝不能成为故障源。
 * 序列化失败（循环引用等）只降级为一行兜底文本。
 */
function writeToFile(level: LogLevel, msg: string, fields: Record<string, unknown>): void {
  try {
    const record: Record<string, unknown> = { ts: new Date().toISOString(), level, ...fields, msg };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ ts: record['ts'], level, mod: fields['mod'], msg: `${msg}（上下文无法序列化）` });
    }
    getFileLogSink().write(line);
  } catch {
    /* 绝不因日志问题影响主链路 */
  }
}

function buildRoot(): PinoLoggerType {
  const base: LoggerOptions = {
    level: currentLevel,
    messageKey: 'msg',
    base: null,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
  };
  if (process.env['DOIP_LOG_PRETTY'] === '1') {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }
  return pino(base);
}

let root: PinoLoggerType = buildRoot();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
  root.level = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setFramesEnabled(enabled: boolean): void {
  framesEnabled = enabled;
}

export function isLevelEnabled(level: LogLevel): boolean {
  if (level === 'trace') return framesEnabled && LEVEL_ORDER['trace'] >= LEVEL_ORDER[currentLevel];
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

/** 重建 root（仅测试/切换 pretty 时用） */
export function resetLogger(): void {
  root = buildRoot();
}

export interface Logger {
  readonly mod: string;
  trace(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(sub: string): Logger;
}

class ModLogger implements Logger {
  constructor(readonly mod: string) {}

  trace(msg: string, ctx?: Record<string, unknown>): void {
    this.write('trace', msg, ctx);
  }
  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.write('debug', msg, ctx);
  }
  info(msg: string, ctx?: Record<string, unknown>): void {
    this.write('info', msg, ctx);
  }
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.write('warn', msg, ctx);
  }
  error(msg: string, ctx?: Record<string, unknown>): void {
    this.write('error', msg, ctx);
  }

  child(sub: string): Logger {
    return new ModLogger(`${this.mod}.${sub}`);
  }

  private write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (silenced) return;
    if (!isLevelEnabled(level)) return;
    const fields: Record<string, unknown> = { mod: this.mod };
    if (ctx !== undefined) {
      for (const [k, v] of Object.entries(ctx)) {
        if (v !== undefined) fields[k] = v;
      }
    }
    root[level](fields, msg);
    if (fileLogEnabled) writeToFile(level, msg, fields);
  }
}

const cache = new Map<string, Logger>();

/** 取模块日志器（mod 用目录名，如 'doip.frame' / 'txn' / 'bridge.flusher'） */
export function getLogger(mod: string): Logger {
  const existing = cache.get(mod);
  if (existing !== undefined) return existing;
  const logger: Logger = new ModLogger(mod);
  cache.set(mod, logger);
  return logger;
}
