/**
 * 服务库仓储（§3.5 / T12）。
 *
 * 三个硬要求：
 *  1. **不可信输入**：一切来自用户的库 JSON 都先过 `UdsLibraryValidator`。
 *  2. **升级不覆盖自定义**：运行时库 = merge(内置基线, 用户覆盖)。
 *     内置新增条目自动出现；用户改过的条目与自建条目（`builtin:false`）永远保留。
 *  3. **热更新 + repatch**：库变更后下一次解码立即生效，并由调用方对最近
 *     `LIMITS.LIBRARY_REPATCH_MAX_ENTRIES` 条 Trace 重算解码（P0-10 验收 ②）。
 *
 * ★文件监听句柄必须在 `dispose()` 里关闭，否则进程无法自行退出。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname, join } from 'node:path';import type { CodeEntry, UdsLibrary, ValidationResult } from '@doip/shared';
import { LIMITS } from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { validateLibrary } from './UdsLibraryValidator';

export interface UdsLibraryStoreOptions {
  /** 内置基线（只读，随版本发布） */
  builtinPath?: string;
  /** 用户覆盖/自定义（可写） */
  userPath?: string;
  /** 关闭文件监听（单测用） */
  watch?: boolean;
  /** 库重载回调（触发 repatch） */
  onReload?: (library: UdsLibrary) => void;
}

export type DoipTableName = keyof UdsLibrary['doipTables'];

interface Keyed<T> {
  keyOf: (item: T) => string;
}

/** 合并两个有序列表：内置在前，用户覆盖同位、新增追加 */
function mergeKeyed<T>(builtin: T[], user: T[], keyed: Keyed<T>): T[] {
  const out: T[] = [];
  const posOf = new Map<string, number>();
  builtin.forEach((item, i) => {
    posOf.set(keyed.keyOf(item), i);
    out.push(item);
  });
  for (const item of user) {
    const key = keyed.keyOf(item);
    const at = posOf.get(key);
    if (at === undefined) {
      posOf.set(key, out.length);
      out.push(item);
    } else {
      out[at] = item;
    }
  }
  return out;
}

function codeKey(item: { code: string }): string {
  return item.code.toUpperCase();
}

/** 从 cwd 向上找 `data/` 目录（npm workspace 下 cwd 可能落在 server/ 或 web/） */
export function findDataDir(): string {
  const candidates = [
    join(process.cwd(), 'data'),
    join(process.cwd(), '..', 'data'),
    join(process.cwd(), '..', '..', 'data'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'uds-library.json'))) return candidate;
  }
  return join(process.cwd(), 'data');
}

export class UdsLibraryStore {
  private readonly log = getLogger('uds.library');
  private readonly builtinPath: string;
  private readonly userPath: string;
  private readonly watchEnabled: boolean;
  private readonly onReload: ((library: UdsLibrary) => void) | null;
  private library: UdsLibrary;
  private builtin: UdsLibrary;
  private watchers: FSWatcher[] = [];
  private disposed = false;

  constructor(options: UdsLibraryStoreOptions = {}) {
    const root = findDataDir();
    this.builtinPath = options.builtinPath ?? join(root, 'uds-library.json');
    this.userPath = options.userPath ?? join(root, 'uds-library.user.json');
    this.watchEnabled = options.watch ?? false;
    this.onReload = options.onReload ?? null;

    this.builtin = this.readBuiltin();
    this.library = this.builtin;
    this.applyUserOverrides();
    if (this.watchEnabled) this.installWatchers();
  }

  /* ─────────────── 读取 ─────────────── */

  get(): UdsLibrary {
    return this.library;
  }

  getBuiltin(): UdsLibrary {
    return this.builtin;
  }

  get userFilePath(): string {
    return this.userPath;
  }

  /** repatch 覆盖的条目数（P0-10：最近 2000 条） */
  get repatchWindow(): number {
    return LIMITS.LIBRARY_REPATCH_MAX_ENTRIES;
  }

  /* ─────────────── 写入 ─────────────── */

  /** 整体替换（先校验，再落盘，再热更新）。返回校验结果供前端展示 issues */
  update(next: unknown): ValidationResult {
    const result = validateLibrary(next);
    if (!result.ok || result.library === null) return result;
    this.persistUser(result.library);
    this.reload();
    return result;
  }

  /** 从 JSON 文本导入（不可信输入） */
  importJson(text: string): ValidationResult {
    return this.update(text);
  }

  exportJson(): string {
    return JSON.stringify(this.library, null, 2);
  }

  /** 「重置内置」：丢弃用户覆盖，回到内置基线 */
  resetBuiltin(): UdsLibrary {
    this.persistUser(this.builtin);
    this.reload();
    this.log.info('服务库已重置为内置基线');
    return this.library;
  }

  /** 重新加载（用户文件被外部改动 / 手动触发） */
  reload(): UdsLibrary {
    this.applyUserOverrides();
    this.onReload?.(this.library);
    return this.library;
  }

  /** ★关闭文件监听句柄（保证进程可自行退出） */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* 忽略已关闭的监听 */
      }
    }
    this.watchers = [];
  }

  /* ─────────────── 查询辅助 ─────────────── */

  services(): UdsLibrary['services'] {
    return this.library.services;
  }

  serviceBySid(sid: number): UdsLibrary['services'][number] | null {
    for (const svc of this.library.services) {
      if (this.hexOf(svc.id) === (sid & 0xff)) return svc;
    }
    return null;
  }

  nrcTable(): UdsLibrary['nrcTable'] {
    return this.library.nrcTable;
  }

  didTable(): UdsLibrary['didTable'] {
    return this.library.didTable;
  }

  didById(did: number): UdsLibrary['didTable'][number] | null {
    for (const item of this.library.didTable) {
      if (this.hexOf(item.id) === (did & 0xffff)) return item;
    }
    return null;
  }

  aliases(): UdsLibrary['addressing']['aliases'] {
    return this.library.addressing.aliases;
  }

  aliasOf(address: number): string | null {
    for (const item of this.library.addressing.aliases) {
      if (this.hexOf(item.address) === (address & 0xffff)) return item.alias;
    }
    return null;
  }

  doipTable(name: DoipTableName): CodeEntry[] {
    return this.library.doipTables[name];
  }

  /** ★Q2：0x8003 NACK 码表走库文件，代码里只留 fallback */
  diagnosticMessageNackCodes(): CodeEntry[] {
    return this.library.doipTables.diagnosticMessageNackCodes;
  }

  keyAlgorithms(): UdsLibrary['keyAlgorithms'] {
    return this.library.keyAlgorithms;
  }

  /* ─────────────── 内部实现 ─────────────── */

  private hexOf(text: string): number {
    const cleaned = text.replace(/^0[xX]/, '').trim();
    const value = Number.parseInt(cleaned, 16);
    return Number.isFinite(value) ? value : -1;
  }

  private readBuiltin(): UdsLibrary {
    if (!existsSync(this.builtinPath)) {
      this.log.error('内置服务库缺失，使用最小兜底库', { path: this.builtinPath });
      return minimalLibrary();
    }
    const text = readFileSync(this.builtinPath, 'utf8');
    const result = validateLibrary(text);
    if (!result.ok || result.library === null) {
      this.log.error('内置服务库校验失败，使用最小兜底库', {
        path: this.builtinPath,
        issues: result.issues.slice(0, 5),
      });
      return minimalLibrary();
    }
    return result.library;
  }

  private applyUserOverrides(): void {
    if (!existsSync(this.userPath)) {
      this.library = this.builtin;
      return;
    }
    let user: UdsLibrary;
    try {
      const result = validateLibrary(readFileSync(this.userPath, 'utf8'));
      if (!result.ok || result.library === null) {
        this.log.error('用户服务库校验失败，已忽略并回退内置', {
          path: this.userPath,
          issues: result.issues.slice(0, 5),
        });
        this.library = this.builtin;
        return;
      }
      user = result.library;
    } catch (err) {
      this.log.error('用户服务库读取失败，已回退内置', {
        path: this.userPath,
        message: err instanceof Error ? err.message : String(err),
      });
      this.library = this.builtin;
      return;
    }
    this.library = mergeLibraries(this.builtin, user);
  }

  private persistUser(library: UdsLibrary): void {
    const dir = dirname(this.userPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.userPath, JSON.stringify(library, null, 2), 'utf8');
  }

  private installWatchers(): void {
    const targets = [this.builtinPath, this.userPath];
    for (const target of targets) {
      if (!existsSync(target)) continue;
      try {
        const watcher = watch(target, () => {
          if (this.disposed) return;
          this.log.info('服务库文件已变更，热更新中', { path: target });
          this.reload();
        });
        this.watchers.push(watcher);
      } catch (err) {
        this.log.warn('服务库文件监听失败（不影响使用）', {
          path: target,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/** 内置 + 用户的合并（★升级只合并新增内置项，绝不覆盖自定义项） */
export function mergeLibraries(builtin: UdsLibrary, user: UdsLibrary): UdsLibrary {
  return {
    schemaVersion: '1.0',
    meta: { ...builtin.meta, ...user.meta, name: user.meta.name || builtin.meta.name },
    doipTables: {
      routingActivationCodes: mergeKeyed(
        builtin.doipTables.routingActivationCodes,
        user.doipTables.routingActivationCodes,
        { keyOf: codeKey },
      ),
      genericHeaderNackCodes: mergeKeyed(
        builtin.doipTables.genericHeaderNackCodes,
        user.doipTables.genericHeaderNackCodes,
        { keyOf: codeKey },
      ),
      diagnosticMessageNackCodes: mergeKeyed(
        builtin.doipTables.diagnosticMessageNackCodes,
        user.doipTables.diagnosticMessageNackCodes,
        { keyOf: codeKey },
      ),
      ackCodes: mergeKeyed(builtin.doipTables.ackCodes, user.doipTables.ackCodes, {
        keyOf: codeKey,
      }),
    },
    nrcTable: mergeKeyed(builtin.nrcTable, user.nrcTable, { keyOf: codeKey }),
    services: mergeKeyed(builtin.services, user.services, { keyOf: (s) => s.id.toUpperCase() }),
    didTable: mergeKeyed(builtin.didTable, user.didTable, { keyOf: (d) => d.id.toUpperCase() }),
    dtcTable: mergeKeyed(builtin.dtcTable, user.dtcTable, { keyOf: codeKey }),
    keyAlgorithms: mergeKeyed(builtin.keyAlgorithms, user.keyAlgorithms, {
      keyOf: (a) => a.id,
    }),
    addressing: {
      testerLogicalAddress: user.addressing.testerLogicalAddress || builtin.addressing.testerLogicalAddress,
      functionalAddress: user.addressing.functionalAddress || builtin.addressing.functionalAddress,
      aliases: mergeKeyed(builtin.addressing.aliases, user.addressing.aliases, {
        keyOf: (a) => a.address.toUpperCase(),
      }),
    },
  };
}

/** 库文件全损时的最小兜底（保证协议栈仍能给出中文名，绝不白屏） */
export function minimalLibrary(): UdsLibrary {
  return {
    schemaVersion: '1.0',
    meta: {
      name: '最小兜底库',
      description: 'data/uds-library.json 缺失或损坏时的兜底，仅供协议栈继续工作',
      updatedAt: new Date().toISOString().slice(0, 10),
    },
    doipTables: {
      routingActivationCodes: [],
      genericHeaderNackCodes: [],
      diagnosticMessageNackCodes: [],
      ackCodes: [],
    },
    nrcTable: [],
    services: [],
    didTable: [],
    dtcTable: [],
    keyAlgorithms: [],
    addressing: { testerLogicalAddress: '0x0E00', functionalAddress: '0x1FFF', aliases: [] },
  };
}

/** 库未加载时的一致错误对象 */
export function libraryNotLoadedError(): AppError {
  return new AppError('E_LIB_NOT_LOADED');
}
