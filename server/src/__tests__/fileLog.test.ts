/**
 * 运行日志落文件测试。
 *
 * 重点不是"能写进去"，而是四条纪律：
 * ① **写日志失败绝不影响主链路**（不抛、不重试、不退出）；
 * ② 单文件超限要保号续写，并只保留最近 N 个；
 * ③ ★`tail()` 必须先等到持久化屏障再读——否则用户看到的"最后几行"会缺掉刚发生的那几条，
 *    而那几条通常正是要看的原因（这是 RollingFileSink 踩过的同一个坑）；
 * ④ 追加写：重启后不覆盖历史。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLogSink } from '../logging/fileLog';

const dirs: string[] = [];

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'doip-filelog-'));
  dirs.push(d);
  return d;
}

function readAll(root: string): string {
  return readdirSync(root)
    .filter((f) => f.startsWith('backend-'))
    .map((f) => readFileSync(join(root, f), 'utf8'))
    .join('');
}

function logFiles(root: string): string[] {
  return readdirSync(root).filter((f) => f.startsWith('backend-'));
}

afterEach(() => {
  for (const d of dirs.splice(0, dirs.length)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      /* ignore */
    }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('TC-LG01 运行日志：写入与读取', () => {
  it('写入后 tail 能读到，且确实落到了磁盘', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    sink.write('{"i":1}');
    sink.write('{"i":2}');
    const res = await sink.tail(10);
    expect(res.lines).toEqual(['{"i":1}', '{"i":2}']);
    expect(readAll(root)).toContain('"i":1');
    await sink.dispose();
  });

  it('★tail 必须先过持久化屏障：刚写还没到刷盘时间的行也要看得到', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    // 只写 1 条（远小于攒批阈值），此时还在内存缓冲里
    sink.write('{"recent":true}');
    const res = await sink.tail(5);
    expect(res.lines).toContain('{"recent":true}');
    // 且确实读的是磁盘内容，而不只是从内存里拼出来的
    expect(readAll(root)).toContain('"recent":true');
    await sink.dispose();
  });

  it('tail 请求行数超上限时被夹紧，不会返回无限数据', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    for (let i = 0; i < 50; i += 1) sink.write(`{"i":${i}}`);
    const res = await sink.tail(1_000_000);
    expect(res.lines.length).toBeLessThanOrEqual(5000);
    expect(res.lines.at(-1)).toBe('{"i":49}');
    await sink.dispose();
  });

  it('tail 的 truncated 在只取到部分内容时为 true', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    for (let i = 0; i < 20; i += 1) sink.write(`{"i":${i}}`);
    const res = await sink.tail(5);
    expect(res.lines).toHaveLength(5);
    expect(res.truncated).toBe(true);
    await sink.dispose();
  });
});

describe('TC-LG02 运行日志：滚动与保留', () => {
  it('超过单文件上限后保号续写（backend-<日期>-N.log）', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root, maxFileBytes: 16 });
    // 分批写并等落盘，让滚动真的发生（单批只写 2 行）
    for (let i = 0; i < 30; i += 1) {
      sink.write(`{"i":${String(i).padStart(3, '0')}}`);
      if (i % 2 === 1) await sink.settled();
    }
    await sink.dispose();
    const files = logFiles(root);
    expect(files.length).toBeGreaterThan(1);
    expect(files.some((f) => /backend-\d{8}-\d+\.log$/.test(f))).toBe(true);
  });

  it('★保留上限生效：滚动后不会无限堆积文件', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root, maxFileBytes: 16, keepFiles: 3 });
    for (let i = 0; i < 60; i += 1) {
      sink.write(`{"i":${String(i).padStart(3, '0')}}`);
      if (i % 2 === 1) await sink.settled();
    }
    await sink.dispose();
    expect(logFiles(root).length).toBeLessThanOrEqual(3);
  });

  it('滚动后不丢内容：所有批次都能在磁盘上找到（允许被保留策略淘汰之外的部分）', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root, maxFileBytes: 24, keepFiles: 0 });
    for (let i = 0; i < 12; i += 1) {
      sink.write(`{"i":${String(i).padStart(3, '0')}}`);
      if (i % 3 === 2) await sink.settled();
    }
    await sink.dispose();
    const all = readAll(root);
    for (let i = 0; i < 12; i += 1) {
      expect(all).toContain(`{"i":${String(i).padStart(3, '0')}}`);
    }
  });
});

describe('TC-LG03 运行日志：失败绝不影响主链路', () => {
  it('★目录不可创建时不抛异常，只累加 dropped', async () => {
    const root = mkTmp();
    const blocker = join(root, 'blocker');
    // 先造一个普通文件，让 mkdir 必然失败（同名路径不可作目录）
    writeFileSync(blocker, 'x');
    const sink = new FileLogSink({ rootDir: join(blocker, 'nested') });
    expect(() => sink.write('{"a":1}')).not.toThrow();
    expect(() => sink.flush()).not.toThrow();
    await expect(sink.settled()).resolves.toBeUndefined();
    expect(sink.getStatus().dropped).toBeGreaterThan(0);
    await expect(sink.dispose()).resolves.toBeUndefined();
  });

  it('更坏的情况：目录建好后写入失败，也不影响主链路', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    sink.write('{"ok":1}');
    await sink.settled();
    // 把目录权限摘掉，后续写入应失败但不抛
    chmodSync(root, 0o500);
    expect(() => sink.write('{"ok":2}')).not.toThrow();
    await expect(sink.settled()).resolves.toBeUndefined();
    chmodSync(root, 0o700);
    await sink.dispose();
  });

  it('未写任何内容时 getStatus 不报错且 files 为空', () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: join(root, 'fresh') });
    const status = sink.getStatus();
    expect(status.files).toEqual([]);
    expect(status.lines).toBe(0);
    expect(status.dropped).toBe(0);
  });

  it('dispose 之后继续写不再落盘（幂等收尾）', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    sink.write('{"before":1}');
    await sink.dispose();
    sink.write('{"after":1}');
    await sink.settled();
    const all = readAll(root);
    expect(all).toContain('"before":1');
    expect(all).not.toContain('"after":1');
  });

  it('dispose 可重复调用', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    sink.write('{"x":1}');
    await sink.dispose();
    await expect(sink.dispose()).resolves.toBeUndefined();
    expect(readAll(root)).toContain('"x":1');
  });

  it('★追加写：重启后不覆盖历史（同一天两次启动）', async () => {
    const root = mkTmp();
    const first = new FileLogSink({ rootDir: root });
    first.write('{"run":1}');
    await first.dispose();
    const second = new FileLogSink({ rootDir: root });
    second.write('{"run":2}');
    await second.dispose();
    const all = readAll(root);
    expect(all).toContain('"run":1');
    expect(all).toContain('"run":2');
  });
});

describe('TC-LG04 运行日志：目录与状态', () => {
  it('openDir 不抛，并返回结构化结果', () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: join(root, 'none') });
    expect(() => sink.openDir()).not.toThrow();
    const res = sink.openDir();
    expect(typeof res.ok).toBe('boolean');
    expect(typeof res.dir).toBe('string');
  });

  it('getStatus 的 dir 指向配置的根目录', () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    expect(existsSync(root)).toBe(true);
    expect(sink.getStatus().dir).toBe(root);
  });

  it('lines 计数随写入增长（供界面显示"已记录 N 行"）', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    sink.write('{"a":1}');
    sink.write('{"a":2}');
    await sink.settled();
    expect(sink.getStatus().lines).toBe(2);
    await sink.dispose();
  });
});
