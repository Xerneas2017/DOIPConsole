/**
 * ★变更 1（D8 提前到 P0）：长挂机滚动落盘（§3.11.1）。
 *
 * 目录：`~/.doip-console/trace-logs/<yyyymmdd-HHMMSS>-<sessionId>/`
 *   ├── session.json          会话元数据
 *   ├── index.json            分片清单（原子写：.tmp + rename）
 *   └── trace-00000N.jsonl    一行一条 TraceEntry（紧凑 JSON，含 rawHex，可完全离线还原）
 *
 * ★★拓扑约束（架构师特别强调，实现时不可搞错）：
 *   本类是 `EventBus.subscribeEntries()` 的**平级订阅者**，挂在 `emit()` 原始入口上，
 *   **绝不消费 BatchFlusher 的输出** —— 否则 WS 触发 L2 背压降级时会连带把落盘报文也丢掉，
 *   兜底就失效了。落盘侧有独立背压（`writableLength > SINK_HIGH_WATER_BYTES` 转 lossy，
 *   保留 error 类条目，恢复后补写 `kind:"gap"` 行）。
 *
 * 写盘失败（无权限/满盘）走 `E_IO_*` warn，主链路不受影响，**不自动重试**（与 Q1 一致）。
 */

import { createWriteStream, mkdirSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import { RECORDING, sleep } from '@doip/shared';
import type {
  LogFileInfo,
  RecordingConfigOverrides,
  RecordingStatus,
  TraceEntry,
} from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { toJsonlLine } from './exporters/JsonExporter';

export interface RollingFileSinkOptions {
  /** 覆盖落盘根目录（默认 `~/.doip-console/trace-logs`）；测试用 tmp 目录 */
  rootDir?: string;
  sessionId?: string;
  overrides?: RecordingConfigOverrides;
  /** 覆盖高水位（测试用） */
  highWaterBytes?: number;
  /** 覆盖最小可用空间阈值（测试用） */
  minFreeBytes?: number;
  now?: () => number;
  onStatus?: (status: RecordingStatus) => void;
  onError?: (error: AppError) => void;
}

export interface SessionMeta {
  peer?: string | null;
  sa?: number | null;
  ta?: number | null;
  protocolVersion?: number | null;
  toolVersion?: string;
}

interface ResolvedLimits {
  flushIntervalMs: number;
  maxEntriesPerBatch: number;
  maxEntriesPerFile: number;
  maxFileBytes: number;
  maxFileDurationMs: number;
  retainMaxBytesPerSession: number;
}

function resolveLimits(overrides?: RecordingConfigOverrides): ResolvedLimits {
  return {
    flushIntervalMs: overrides?.flushIntervalMs ?? RECORDING.FLUSH_INTERVAL_MS,
    maxEntriesPerBatch: RECORDING.MAX_ENTRIES_PER_BATCH,
    maxEntriesPerFile: overrides?.maxEntriesPerFile ?? RECORDING.MAX_ENTRIES_PER_FILE,
    maxFileBytes: overrides?.maxFileBytes ?? RECORDING.MAX_FILE_BYTES,
    maxFileDurationMs: overrides?.maxFileDurationMs ?? RECORDING.MAX_FILE_DURATION_MS,
    retainMaxBytesPerSession: overrides?.retainMaxBytesPerSession ?? RECORDING.RETAIN_MAX_BYTES_PER_SESSION,
  };
}

function timestampSlug(epochMs: number): string {
  const d = new Date(epochMs);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** error 类与超时条目在落盘背压时仍必须保留 */
function isCriticalEntry(entry: TraceEntry): boolean {
  return entry.errorCode !== null || entry.timeout === true;
}

export class RollingFileSink {
  private readonly log = getLogger('trace.sink');
  private readonly now: () => number;
  private readonly rootDir: string;
  private readonly sessionId: string;
  private readonly onStatus?: (status: RecordingStatus) => void;
  private readonly onError?: (error: AppError) => void;

  private limits: ResolvedLimits;
  private highWaterBytes: number;
  private minFreeBytes: number;

  private state: RecordingStatus['state'] = 'stopped';
  private sessionDir: string | null = null;
  private stream: WriteStream | null = null;
  private shardIndex = 0;
  private currentFile: string | null = null;
  private currentFilePath: string | null = null;
  private currentEntries = 0;
  private currentBytes = 0;
  private currentFromSeq: number | null = null;
  private currentToSeq: number | null = null;
  private currentStartedAtMs = 0;

  private files: LogFileInfo[] = [];
  private entriesWritten = 0;
  private bytesWritten = 0;
  private droppedCount = 0;
  private startedAtMs: number | null = null;

  private buffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private pendingFlush = false;
  /** 已 end() 但尚未 close 的分片流（stop() 必须等它们都 close） */
  private pendingCloses: Array<Promise<void>> = [];
  private lossy = false;
  private gapFromSeq: number | null = null;
  private gapToSeq: number | null = null;
  private gapCount = 0;
  private lastProgressPushMs = 0;
  private errorCode: string | null = null;
  private errorNameZh: string | null = null;

  constructor(options: RollingFileSinkOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sessionId = options.sessionId ?? 'default';
    this.rootDir = options.rootDir ?? join(homedir(), RECORDING.ROOT_DIR);
    this.limits = resolveLimits(options.overrides);
    this.highWaterBytes = options.highWaterBytes ?? RECORDING.SINK_HIGH_WATER_BYTES;
    this.minFreeBytes = options.minFreeBytes ?? RECORDING.MIN_FREE_BYTES;
    if (options.onStatus !== undefined) this.onStatus = options.onStatus;
    if (options.onError !== undefined) this.onError = options.onError;
  }

  /* ─────────────── 生命周期 ─────────────── */

  /** 启动录盘；目录/文件打开失败 → state='disabled' + E_IO_SINK_OPEN_FAILED（主链路不受影响） */
  async start(options: { sessionDir?: string; overrides?: RecordingConfigOverrides; meta?: SessionMeta } = {}): Promise<RecordingStatus> {
    if (options.overrides !== undefined) this.limits = resolveLimits(options.overrides);
    if (this.state === 'recording') return this.getStatus();

    const nowMs = this.now();
    const dir =
      options.sessionDir ?? join(this.rootDir, `${timestampSlug(nowMs)}-${this.sessionId}`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      return this.fail('disabled', 'E_IO_SINK_OPEN_FAILED', dir, err);
    }

    this.sessionDir = dir;
    this.startedAtMs = nowMs;
    this.shardIndex = 0;
    this.files = [];
    this.entriesWritten = 0;
    this.bytesWritten = 0;
    this.droppedCount = 0;
    this.errorCode = null;
    this.errorNameZh = null;

    try {
      this.writeSessionJson(dir, options.meta, nowMs);
    } catch (err) {
      return this.fail('disabled', 'E_IO_SINK_OPEN_FAILED', dir, err);
    }

    const opened = this.openShard(nowMs);
    if (!opened) return this.getStatus();

    this.state = 'recording';
    this.scheduleFlush();
    this.log.info('录盘已开始', { dir, shard: this.currentFile });
    this.pushStatus(true);
    return this.getStatus();
  }

  /** 停止录盘：补写未了的 gap → flush → 关闭分片（★等 fd 关闭）→ 重写 index.json */
  async stop(): Promise<RecordingStatus> {
    this.clearFlushTimer();
    if (this.state !== 'recording') {
      this.state = this.state === 'error' ? 'error' : 'stopped';
      this.pushStatus(true);
      return this.getStatus();
    }
    // ★QA-BUG-04：若仍处于 lossy，已累计的丢弃必须在收尾时补写 gap 行（不得静默丢失）
    if (this.gapCount > 0) this.writeGapLine();
    // ★先等写入真正落盘再关流：否则 index.json 会先于分片数据写完（看起来"分片是空的"）
    await this.flush();
    this.closeShard(this.now());
    // ★QA-BUG-06：必须等所有分片流真正 close（fs.open/write 都是异步的），
    //   否则 stop() 返回时 index.json 声明的分片可能还没被创建出来，崩溃恢复会读空。
    await this.awaitShardCloses();
    this.state = 'stopped';
    this.writeIndex();
    this.log.info('录盘已停止', {
      entries: this.entriesWritten,
      bytes: this.bytesWritten,
      dropped: this.droppedCount,
      shards: this.files.length,
    });
    this.pushStatus(true);
    return this.getStatus();
  }

  /** 释放资源（进程退出前调用，★确保无悬挂 timer） */
  dispose(): void {
    this.clearFlushTimer();
    if (this.stream !== null) {
      try {
        this.stream.end();
      } catch {
        /* ignore */
      }
      this.stream = null;
    }
    this.buffer = [];
  }

  /* ─────────────── 写入 ─────────────── */

  /**
   * 追加一条 TraceEntry（由 EventBus 平级订阅驱动）。
   * 同步入队、异步攒批写盘；绝不每条 appendFileSync。
   */
  append(entry: TraceEntry): void {
    if (this.state !== 'recording') return;

    // ① 落盘侧独立背压：高水位 → lossy（仍保留 error 类条目）
    const buffered = this.stream?.writableLength ?? 0;
    if (buffered > this.highWaterBytes) {
      if (!this.lossy) {
        this.lossy = true;
        this.log.warn('落盘写入积压，转入 lossy 模式', { bufferedBytes: buffered });
        this.reportError(
          new AppError('E_IO_SINK_BACKPRESSURE', undefined, { detail: { bufferedBytes: buffered } }),
        );
      }
      if (!isCriticalEntry(entry)) {
        this.droppedCount += 1;
        if (this.gapFromSeq === null) this.gapFromSeq = entry.seq;
        this.gapToSeq = entry.seq;
        this.gapCount += 1;
        return;
      }
    } else if (this.lossy) {
      // ② 恢复：先补一行 gap，再继续
      this.lossy = false;
      this.writeGapLine();
    }

    const line = toJsonlLine(entry);
    this.buffer.push(line);
    this.currentEntries += 1;
    this.currentBytes += Buffer.byteLength(line, 'utf8') + 1; // + '\n'
    this.entriesWritten += 1;
    if (this.currentFromSeq === null) this.currentFromSeq = entry.seq;
    this.currentToSeq = entry.seq;

    if (this.buffer.length >= this.limits.maxEntriesPerBatch) this.flushNow();
    this.maybeRoll();
    this.pushStatus(false);
  }

  /** 立即刷盘（把内存中的行一次性 write） */
  flushNow(): void {
    if (this.stream === null || this.buffer.length === 0) return;
    // 上一次 write 尚未 drain：保留 buffer，等 drain 后再继续（不丢数据，只是延后）
    if (this.pendingFlush) return;

    const chunk = Buffer.from(this.buffer.join('\n') + '\n', 'utf8');
    this.buffer = [];
    this.bytesWritten += chunk.length;
    this.pendingFlush = true;
    try {
      const ok = this.stream.write(chunk, (err) => {
        this.pendingFlush = false;
        if (err !== undefined && err !== null) this.handleWriteError(err);
      });
      if (ok) this.pendingFlush = false;
    } catch (err) {
      this.pendingFlush = false;
      this.handleWriteError(err);
    }
  }

  /**
   * 立即刷盘并**等待写入完成**（写入流是异步的：open 与 write 都在事件循环里完成）。
   * 有界等待：到达 deadline 即返回，绝不把主链路挂住。
   */
  async flush(timeoutMs: number = RECORDING.FLUSH_INTERVAL_MS): Promise<void> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    this.flushNow();
    while (Date.now() < deadline) {
      // ★必须等 writableLength 归零：write 回调只代表"chunk 被流接收"，
      //   此时 fs.open 可能还没完成，分片文件甚至还没被创建出来。
      const queued = this.stream?.writableLength ?? 0;
      if (this.buffer.length === 0 && !this.pendingFlush && queued === 0) {
        if (this.state === 'recording') this.writeIndex();
        return;
      }
      if (this.state !== 'recording') return;
      await sleep(1);
      this.flushNow();
    }
  }

  /* ─────────────── 查询 ─────────────── */

  getStatus(): RecordingStatus {
    const status: RecordingStatus = {
      state: this.state,
      sessionDir: this.sessionDir,
      currentFile: this.currentFile,
      /**
       * ★含"正在写的分片"（与 `writeIndex()` 同一口径）。
       * 否则录盘进行中前端会显示"0 片"，而磁盘上明明已经有 trace-000001.jsonl —— 读起来像坏了。
       */
      files: this.allFileInfos(),
      entriesWritten: this.entriesWritten,
      bytesWritten: this.bytesWritten,
      droppedCount: this.droppedCount,
      startedAtMs: this.startedAtMs,
    };
    if (this.errorCode !== null) status.errorCode = this.errorCode;
    if (this.errorNameZh !== null) status.errorNameZh = this.errorNameZh;
    return status;
  }

  get recording(): boolean {
    return this.state === 'recording';
  }

  /** 在本机文件管理器中打开落盘目录（record.openDir） */
  openDir(dir?: string): { ok: boolean; dir: string | null; command: string | null } {
    const target = dir ?? this.sessionDir ?? this.rootDir;
    const cmd =
      platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'explorer' : 'xdg-open';
    try {
      const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
      child.on('error', (err) => {
        this.log.warn('打开目录失败', { target, message: err.message });
      });
      child.unref();
      return { ok: true, dir: target, command: cmd };
    } catch (err) {
      this.log.warn('打开目录失败', { target, message: err instanceof Error ? err.message : String(err) });
      return { ok: false, dir: target, command: cmd };
    }
  }

  /* ─────────────── 内部实现 ─────────────── */

  private writeSessionJson(dir: string, meta: SessionMeta | undefined, nowMs: number): void {
    const payload = {
      sessionId: this.sessionId,
      startedAt: new Date(nowMs).toISOString(),
      startedAtMs: nowMs,
      toolVersion: meta?.toolVersion ?? '0.1.0',
      peer: meta?.peer ?? null,
      sa: meta?.sa ?? null,
      ta: meta?.ta ?? null,
      protocolVersion: meta?.protocolVersion ?? null,
      limits: this.limits,
    };
    writeFileSync(join(dir, 'session.json'), JSON.stringify(payload, null, 2), 'utf8');
  }

  private openShard(nowMs: number): boolean {
    this.shardIndex += 1;
    const file = `trace-${String(this.shardIndex).padStart(6, '0')}.jsonl`;
    const path = this.sessionDir === null ? file : join(this.sessionDir, file);
    try {
      const stream = createWriteStream(path, { flags: 'a' });
      stream.on('error', (err: Error) => this.handleWriteError(err));
      this.stream = stream;
      this.currentFile = file;
      this.currentFilePath = path;
      this.currentEntries = 0;
      this.currentBytes = 0;
      this.currentFromSeq = null;
      this.currentToSeq = null;
      this.currentStartedAtMs = nowMs;
      return true;
    } catch (err) {
      this.fail('disabled', 'E_IO_SINK_OPEN_FAILED', path, err);
      return false;
    }
  }

  private closeShard(nowMs: number): void {
    const stream = this.stream;
    this.stream = null;
    // ★走 endStream：登记 close 事件，供 stop() 等待（保证分片真的在磁盘上）
    this.endStream(stream);
    if (this.currentFile !== null && this.currentEntries > 0) {
      const info: LogFileInfo = {
        file: this.currentFile,
        absolutePath: this.currentFilePath ?? this.currentFile,
        seqRange: [this.currentFromSeq ?? 0, this.currentToSeq ?? 0],
        entries: this.currentEntries,
        bytes: this.currentBytes,
        startedAtMs: this.currentStartedAtMs,
        endedAtMs: nowMs,
      };
      this.files.push(info);
    }
    this.currentFile = null;
    this.currentFilePath = null;
    // ★QA-BUG-03：关闭后必须清零当前分片计数，否则 applyRetention() 会把"刚归档的分片"
    //   在 files 里算一次、又在 currentBytes 里算一次 → 重复计数 → 误删唯一的分片。
    this.currentEntries = 0;
    this.currentBytes = 0;
    this.currentFromSeq = null;
    this.currentToSeq = null;
  }

  /**
   * 关闭流并登记"待完成"的 Promise（fs 的 open/write/close 都是异步的）。
   * `stop()` 用 `awaitShardCloses()` 等待，保证 stop() 返回时分片已在磁盘上。
   */
  private endStream(stream: WriteStream | null): void {
    if (stream === null) return;
    const closed = new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      stream.once('close', done);
      stream.once('error', done);
      // 兜底：极端情况下流既不 close 也不 error（如 fd 泄漏），避免 stop() 永久挂住
      setTimeout(done, RECORDING.FLUSH_INTERVAL_MS).unref?.();
      try {
        stream.end();
      } catch {
        done();
      }
    });
    this.pendingCloses.push(closed);
  }

  /** 等待所有分片流关闭（有界：最多等 FLUSH_INTERVAL_MS） */
  private async awaitShardCloses(): Promise<void> {
    const pending = this.pendingCloses.splice(0);
    if (pending.length === 0) return;
    await Promise.all(pending);
  }

  /** 滚动三策：条数 / 字节 / 时长，**先到者触发** */
  private maybeRoll(): void {
    if (this.state !== 'recording') return;
    const nowMs = this.now();
    const byEntries = this.currentEntries >= this.limits.maxEntriesPerFile;
    const byBytes = this.currentBytes >= this.limits.maxFileBytes;
    const byDuration = nowMs - this.currentStartedAtMs >= this.limits.maxFileDurationMs;
    if (!byEntries && !byBytes && !byDuration) return;
    this.roll(nowMs, byEntries ? 'entries' : byBytes ? 'bytes' : 'duration');
  }

  private roll(nowMs: number, reason: 'entries' | 'bytes' | 'duration'): void {
    this.flushNow();
    this.closeShard(nowMs);
    this.log.info('录盘分片滚动', {
      reason,
      shards: this.files.length,
      entries: this.entriesWritten,
    });

    // ① 保留策略：超出单会话上限 → 删最旧分片
    this.applyRetention();

    // ② 磁盘保护：可用空间不足 → 停录并报错
    if (!this.hasEnoughDiskSpace()) {
      const error = new AppError('E_IO_DISK_FULL');
      this.state = 'error';
      this.errorCode = error.code;
      this.errorNameZh = error.message;
      this.reportError(error);
      this.pushStatus(true);
      return;
    }

    if (!this.openShard(nowMs)) return;
    this.writeIndex();
    this.pushStatus(true);
  }

  private applyRetention(): void {
    const maxBytes = this.limits.retainMaxBytesPerSession;
    if (maxBytes <= 0) return;
    let total = this.files.reduce((sum, f) => sum + f.bytes, 0) + this.currentBytes;
    while (total > maxBytes && this.files.length > 0) {
      const oldest = this.files.shift();
      if (oldest === undefined) break;
      try {
        rmSync(oldest.absolutePath, { force: true });
        this.log.warn('录盘保留策略：已删除最旧分片', { file: oldest.file, bytes: oldest.bytes });
      } catch (err) {
        this.log.warn('删除旧分片失败', {
          file: oldest.file,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      total -= oldest.bytes;
    }
  }

  private hasEnoughDiskSpace(): boolean {
    if (this.minFreeBytes <= 0) return true;
    const target = this.sessionDir ?? this.rootDir;
    try {
      const stat = statfsSync(target);
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (free >= this.minFreeBytes) return true;
      this.log.warn('磁盘可用空间不足', { freeBytes: free, minFreeBytes: this.minFreeBytes });
      return false;
    } catch {
      // statfs 不可用时不做阻断（避免误停录）
      return true;
    }
  }

  private writeGapLine(): void {
    if (this.gapCount <= 0 || this.gapFromSeq === null || this.gapToSeq === null) return;
    const line = JSON.stringify({
      kind: 'gap',
      reason: 'sinkBackpressure',
      fromSeq: this.gapFromSeq,
      toSeq: this.gapToSeq,
      count: this.gapCount,
      ts: new Date().toISOString(),
    });
    this.buffer.push(line);
    this.gapFromSeq = null;
    this.gapToSeq = null;
    this.gapCount = 0;
  }

  /** 已滚动完成的分片 + 正在写的分片（快照，供 status 与 index.json 共用） */
  private allFileInfos(): LogFileInfo[] {
    const files = this.files.map((f) => ({ ...f }));
    const current = this.currentFileInfo(this.now());
    if (current !== null) files.push(current);
    return files;
  }

  private writeIndex(): void {
    if (this.sessionDir === null) return;
    // ★包含"正在写的分片"：否则录盘过程中 index.json 会少列当前分片（崩溃恢复会丢尾部）
    const files = this.allFileInfos();
    const payload = {
      sessionId: this.sessionId,
      startedAtMs: this.startedAtMs,
      updatedAtMs: this.now(),
      entriesWritten: this.entriesWritten,
      bytesWritten: this.bytesWritten,
      droppedCount: this.droppedCount,
      currentFile: this.currentFile,
      files,
    };
    const target = join(this.sessionDir, 'index.json');
    const tmp = `${target}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      renameSync(tmp, target);
    } catch (err) {
      this.reportError(
        new AppError('E_IO_WRITE_FAILED', undefined, {
          detail: { path: target, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  /** 当前（未关闭）分片的清单条目；无进行中分片时返回 null */
  private currentFileInfo(nowMs: number): LogFileInfo | null {
    if (this.currentFile === null || this.currentEntries <= 0) return null;
    return {
      file: this.currentFile,
      absolutePath: this.currentFilePath ?? this.currentFile,
      seqRange: [this.currentFromSeq ?? 0, this.currentToSeq ?? 0],
      entries: this.currentEntries,
      bytes: this.currentBytes,
      startedAtMs: this.currentStartedAtMs,
      endedAtMs: nowMs,
    };
  }

  private handleWriteError(err: unknown): void {
    const appErr = new AppError('E_IO_WRITE_FAILED', undefined, {
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
    this.state = 'error';
    this.errorCode = appErr.code;
    this.errorNameZh = appErr.message;
    this.clearFlushTimer();
    if (this.stream !== null) {
      try {
        this.stream.end();
      } catch {
        /* ignore */
      }
      this.stream = null;
    }
    this.reportError(appErr);
    this.pushStatus(true);
  }

  private fail(
    state: RecordingStatus['state'],
    code: string,
    path: string,
    err: unknown,
  ): RecordingStatus {
    const appErr = new AppError(code, undefined, {
      detail: { path, message: err instanceof Error ? err.message : String(err) },
    });
    this.state = state;
    this.errorCode = appErr.code;
    this.errorNameZh = appErr.message;
    this.reportError(appErr);
    this.pushStatus(true);
    return this.getStatus();
  }

  private reportError(error: AppError): void {
    this.log.warn(error.message, { code: error.code, path: this.sessionDir });
    this.onError?.(error);
  }

  /** 状态推送：状态变化时立即推；recording 期间按 PROGRESS_PUSH_INTERVAL_MS 节流 */
  private pushStatus(force: boolean): void {
    if (this.onStatus === undefined) return;
    const nowMs = this.now();
    if (!force && nowMs - this.lastProgressPushMs < RECORDING.PROGRESS_PUSH_INTERVAL_MS) return;
    this.lastProgressPushMs = nowMs;
    this.onStatus(this.getStatus());
  }

  private scheduleFlush(): void {
    this.clearFlushTimer();
    this.flushTimer = setInterval(() => {
      this.flushNow();
      this.maybeRoll();
      // 周期性刷新清单：保证录盘进行中 index.json 始终可读（崩溃/异常退出也能找到分片）
      if (this.state === 'recording') this.writeIndex();
    }, this.limits.flushIntervalMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
