/**
 * 后端运行日志落文件（自我排查用）。
 *
 * 为什么需要：终端关掉、或打包成应用之后，后端输出就没有留痕了。出现
 * "目标主动拒绝 TCP 连接（ECONNREFUSED）"这类问题时，用户只能靠猜。
 * 这里把同一条日志**同时写进文件**：`~/.doip-console/logs/backend-YYYYMMDD.log`。
 *
 * 设计约束：
 * - **写日志失败绝不影响主链路**：任何 IO 异常只累加 `dropped`，不抛、不重试、不退出。
 * - **攒批写入**：不为每条日志做一次 syscall；攒批或定时刷。
 * - **单文件上限 + 保号滚动**：超过 `MAX_FILE_BYTES` 续写 `-1`、`-2`…；保留最近 `KEEP_FILES` 个。
 * - ★**持久化屏障**：`tail()` / `dispose()` 必须等到已提交的批次真正落到磁盘再返回。
 *   否则会重演 RollingFileSink 的老问题——"清单说有、磁盘没有"，而用户看到的
 *   "最后几行"恰好缺掉刚发生的那几条（正是要看的原因）。
 *   `write()` 保持同步入口 + 内部串行 Promise 链，兼顾热路径与可等待性。
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import type { WriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LOGGING } from '@doip/shared';

/**
 * ★刻意不走 getLogger（避免 logger ↔ fileLog 循环依赖）：
 * 这里只往 stderr 打一行裸告警，且绝不再抛。
 */
function stderrWarn(msg: string, err: unknown): void {
  try {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[log-sink] ${msg}: ${detail}\n`);
  } catch {
    /* 连 stderr 都写不出去时保持静默 */
  }
}

export interface FileLogStatus {
  /** 日志目录绝对路径 */
  dir: string;
  /** 当前正在写的文件绝对路径 */
  file: string;
  /** 当前文件已写字节 */
  bytes: number;
  /** 本进程累计写入行数 */
  lines: number;
  /** 因 IO 失败被丢弃的行数（>0 说明日志不完整） */
  dropped: number;
  /** 写入流出现背压的次数（观测用，不代表丢数据） */
  backpressureHits: number;
  /** 目录下保留的日志文件清单（新的在前） */
  files: string[];
}

export interface FileLogSinkOptions {
  /** 覆盖根目录（测试用 tmp 目录） */
  rootDir?: string;
  maxFileBytes?: number;
  keepFiles?: number;
}

export interface TailResult {
  file: string;
  lines: string[];
  truncated: boolean;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function dateStamp(d: Date): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

export class FileLogSink {
  private readonly rootDir: string;
  private readonly maxFileBytes: number;
  private readonly keepFiles: number;

  private stream: WriteStream | null = null;
  private currentPath = '';
  private currentBytes = 0;
  private index = 0;
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** 串行化写入链，兼作"已提交写入"的持久化屏障 */
  private chain: Promise<void> = Promise.resolve();
  private lines = 0;
  private dropped = 0;
  private backpressureHits = 0;
  private dirReady = false;
  private enabled = true;

  constructor(options: FileLogSinkOptions = {}) {
    this.rootDir = options.rootDir ?? join(homedir(), LOGGING.ROOT_DIR);
    this.maxFileBytes = options.maxFileBytes ?? LOGGING.MAX_FILE_BYTES;
    this.keepFiles = options.keepFiles ?? LOGGING.KEEP_FILES;
    this.currentPath = this.pathFor(0);
  }

  /* ─────────────── 对外 ─────────────── */

  /** 写入一条已序列化的 JSON 行（同步入口，绝不抛） */
  write(line: string): void {
    if (!this.enabled) return;
    this.pending.push(line);
    if (this.pending.length >= LOGGING.MAX_LINES_PER_BATCH) {
      this.flush();
      return;
    }
    this.armTimer();
  }

  /** 立即把攒批队列提交到写入链（同步返回；用 `settled()` 等待真正落盘） */
  flush(): void {
    this.clearTimer();
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0, this.pending.length).join('\n') + '\n';
    const lines = countLines(batch);
    this.chain = this.chain.then(() => this.writeBatch(batch, lines));
  }

  /** 等待所有已提交的写入真正落盘（**有界**：绝不无限等待） */
  async settled(): Promise<void> {
    this.flush();
    await this.raceBounded(this.chain, LOGGING.SETTLE_TIMEOUT_MS);
  }

  /**
   * 给任意 Promise 加一个有界上界。
   *
   * ★日志侧的一切等待都必须有界：写入流在"出错但回调未到"的窗口里会让 await 永久挂起，
   *   而 `log.tail` 挂起会把 WS 的 ack 一起拖死 —— 用户看到的就是"查看日志一直转圈"。
   *   宁可少几行日志，也不能让诊断工具本身卡住。
   */
  private raceBounded(p: Promise<void>, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.dropped += 1;
        stderrWarn('日志等待超时（已放行，不再阻塞调用方）', new Error(`>${timeoutMs}ms`));
        finish();
      }, timeoutMs);
      timer.unref();
      void p.then(finish, finish);
    });
  }

  getStatus(): FileLogStatus {
    return {
      dir: this.rootDir,
      file: this.currentPath,
      bytes: this.currentBytes,
      lines: this.lines,
      dropped: this.dropped,
      backpressureHits: this.backpressureHits,
      files: this.listFiles(),
    };
  }

  /**
   * 读最近 N 行（界面直接查看，不必离开工具）。
   *
   * ★先 `settled()` 再读：否则会漏掉刚发生、还在写入链里的那几条。
   */
  async tail(lines: number): Promise<TailResult> {
    const wanted = Math.max(1, Math.min(lines, LOGGING.TAIL_MAX_LINES));
    await this.settled();
    const files = this.listFiles();
    const collected: string[][] = [];
    let remaining = wanted;
    let truncated = false;
    for (const name of files) {
      if (remaining <= 0) break;
      let text: string;
      try {
        text = readFileSync(join(this.rootDir, name), 'utf8');
      } catch {
        continue;
      }
      const rows = text.split('\n').filter((l) => l.length > 0);
      const take = rows.slice(Math.max(0, rows.length - remaining));
      if (take.length < rows.length) truncated = true;
      collected.unshift(take);
      remaining -= take.length;
    }
    const out = collected.flat();
    return {
      file: this.currentPath,
      // 文件是按"新的在前"遍历、依次 unshift，最终顺序已是旧的在前
      lines: out.slice(Math.max(0, out.length - wanted)),
      truncated: truncated || out.length > wanted,
    };
  }

  /** 在系统文件管理器里打开日志目录 */
  openDir(sub?: string): { ok: boolean; dir: string } {
    const target = sub !== undefined && sub.length > 0 ? join(this.rootDir, sub) : this.rootDir;
    const dir = existsSync(target) ? target : this.rootDir;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const cmd =
        process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, dir };
    } catch (err) {
      stderrWarn('打开日志目录失败', err);
      return { ok: false, dir };
    }
  }

  /** 收尾：把攒批与写入链全部落盘后关闭流（幂等） */
  async dispose(): Promise<void> {
    this.clearTimer();
    if (!this.enabled && this.stream === null) return;
    await this.settled();
    this.enabled = false;
    const stream = this.stream;
    this.stream = null;
    if (stream !== null) {
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    }
  }

  /* ─────────────── 内部 ─────────────── */

  private async writeBatch(batch: string, lines: number): Promise<void> {
    try {
      if (!this.ensureStream()) {
        this.dropped += lines;
        return;
      }
      const stream = this.stream;
      if (stream === null) {
        this.dropped += lines;
        return;
      }
      await new Promise<boolean>((resolve) => {
        // ★必须同时挂在 write 回调、'error' 与超时上：
        //   写入流出错时 write 回调可能永不触发，只等回调会让 settled()/tail() 永久挂起，
        //   而 tail() 挂起会连带把 log.tail 指令的 ack 也拖死（前端一直转圈）。
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          stream.off('error', onError);
          resolve(ok);
        };
        const onError = (): void => finish(false);
        const timer = setTimeout(() => {
          this.dropped += 1;
          stderrWarn('单批写入确认超时（已放行）', new Error(`>${LOGGING.WRITE_ACK_TIMEOUT_MS}ms`));
          finish(false);
        }, LOGGING.WRITE_ACK_TIMEOUT_MS);
        timer.unref();
        stream.once('error', onError);
        const ok = stream.write(batch, () => finish(true));
        if (!ok) this.backpressureHits += 1;
      });
      this.currentBytes += Buffer.byteLength(batch);
      this.lines += lines;
      if (this.currentBytes >= this.maxFileBytes) await this.rollover();
    } catch (err) {
      this.dropped += lines;
      // ★写日志失败绝不能抛给调用方
      stderrWarn('日志写入失败（已丢弃该批，不影响主链路）', err);
    }
  }

  private armTimer(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, LOGGING.FLUSH_INTERVAL_MS);
    // 刷盘定时器不应阻止进程退出
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private ensureStream(): boolean {
    if (this.stream !== null) return true;
    if (!this.dirReady) {
      try {
        mkdirSync(this.rootDir, { recursive: true });
        this.dirReady = true;
      } catch (err) {
        stderrWarn('创建日志目录失败，已停止写日志', err);
        this.enabled = false;
        return false;
      }
    }
    // 从当前序号起，跳过已经写满的文件（重启后继续追加，不覆盖历史）
    let guard = 0;
    while (
      existsSync(this.pathFor(this.index)) &&
      statSync(this.pathFor(this.index)).size >= this.maxFileBytes
    ) {
      this.index += 1;
      guard += 1;
      if (guard > 10_000) break;
    }
    this.currentPath = this.pathFor(this.index);
    try {
      this.currentBytes = existsSync(this.currentPath) ? statSync(this.currentPath).size : 0;
      const stream = createWriteStream(this.currentPath, { flags: 'a' });
      stream.on('error', (err: Error) => {
        this.dropped += 1;
        this.stream = null;
        stderrWarn('日志写入流错误（已停止写日志，不影响主链路）', err);
      });
      this.stream = stream;
      return true;
    } catch (err) {
      stderrWarn('打开日志文件失败，已停止写日志', err);
      this.enabled = false;
      return false;
    }
  }

  private pathFor(index: number): string {
    const suffix = index === 0 ? '' : `-${index}`;
    return join(this.rootDir, `backend-${dateStamp(new Date())}${suffix}.log`);
  }

  /** 关掉当前分片并切到下一个序号；**必须等旧流 close 完成** */
  private async rollover(): Promise<void> {
    const old = this.stream;
    this.stream = null;
    if (old !== null) {
      await new Promise<void>((resolve) => {
        old.end(() => resolve());
      });
    }
    this.index += 1;
    this.currentPath = this.pathFor(this.index);
    this.currentBytes = 0;
    this.prune();
  }

  /** 只保留最近 KEEP_FILES 个（文件名倒序，新的在前） */
  private prune(): void {
    if (this.keepFiles <= 0) return;
    const files = this.listFiles();
    for (const name of files.slice(this.keepFiles)) {
      try {
        unlinkSync(join(this.rootDir, name));
      } catch {
        /* ignore */
      }
    }
  }

  private listFiles(): string[] {
    try {
      return readdirSync(this.rootDir)
        .filter((f) => f.startsWith('backend-') && f.endsWith('.log'))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}

/** 进程级单例（logger 直接写入它） */
let singleton: FileLogSink | null = null;

export function getFileLogSink(): FileLogSink {
  if (singleton === null) singleton = new FileLogSink();
  return singleton;
}

export function setFileLogSink(sink: FileLogSink | null): void {
  singleton = sink;
}
