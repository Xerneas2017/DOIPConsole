/**
 * ★变更 1（T17 后端部分）：RollingFileSink 单测（§9.1 TC-R01 ~ TC-R06）。
 *
 * 其中 **TC-R03 是本条兜底的立身之本**：WS 处于 L2 背压降级时，落盘必须仍是全量。
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyUdsDecodeResult } from '@doip/shared';
import type { AppError } from '../errors/AppError';
import type { TraceEntry } from '@doip/shared';
import { RollingFileSink } from '../trace/RollingFileSink';
import { EventBus } from '../bridge/EventBus';
import { BatchFlusher } from '../bridge/BatchFlusher';
import { TraceStore } from '../trace/TraceStore';

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'doip-sink-'));
}

function makeEntry(seq: number, overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    seq,
    transactionId: null,
    ts: '2026-09-22T10:00:00.000000Z',
    tsRelMs: seq,
    transport: 'TCP',
    direction: 'TX',
    peer: '127.0.0.1:13401',
    sessionId: 'default',
    doip: {
      protocolVersion: 0x02,
      inverseVersionValid: true,
      payloadType: 0x8001,
      payloadTypeName: 'DiagnosticMessage',
      payloadTypeNameZh: '诊断报文',
      payloadLength: 6,
      sourceAddress: 0x0e00,
      targetAddress: 0x1000,
      sourceAddressName: '0x0E00',
      targetAddressName: '0x1000',
      ackCode: null,
      ackNameZh: null,
      nackCode: null,
      nackNameZh: null,
      activationResponseCode: null,
      activationResponseCodeZh: null,
      vin: null,
      eid: null,
      gid: null,
      headerHex: '02FD800100000006',
    },
    uds: emptyUdsDecodeResult(),
    linkedSeq: null,
    txnRole: 'request',
    latencyMs: null,
    gatewayForwardLatencyMs: null,
    timeout: false,
    errorCode: null,
    errorNameZh: null,
    tags: [],
    rawHex: '02FD8001000000060E0010001003',
    ...overrides,
  };
}

function readLines(dir: string, file: string): string[] {
  return readFileSync(join(dir, file), 'utf8').split('\n').filter((l) => l !== '');
}

function readIndex(dir: string): {
  files: Array<{ file: string; entries: number; seqRange: [number, number] }>;
  entriesWritten: number;
  droppedCount: number;
} {
  return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
    files: Array<{ file: string; entries: number; seqRange: [number, number] }>;
    entriesWritten: number;
    droppedCount: number;
  };
}

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    try {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('TC-R01 基本落盘', () => {
  it('灌 200 000 条 → 分片行数与条数一致，逐行 JSON.parse 全成功，index.json 一致', async () => {
    const root = tmpRoot();
    cleanup.push(root);
    // 单测用紧凑循环会人为把写队列堆高（真实场景是随时间到达），
    // 故此处把落盘高水位放大；背压行为由 TC-R05 单独覆盖。
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'r01',
      highWaterBytes: 1 << 30,
      overrides: { maxEntriesPerFile: 50_000, flushIntervalMs: 50 },
    });
    await sink.start();

    const total = 200_000;
    for (let i = 1; i <= total; i += 1) {
      sink.append(makeEntry(i));
      if (i % 1000 === 0) await sink.flush();
    }
    const status = await sink.stop();

    const dir = status.sessionDir ?? '';
    expect(status.state).toBe('stopped');
    expect(status.entriesWritten).toBe(total);
    expect(status.files).toHaveLength(4);

    let lines = 0;
    let lastSeq = 0;
    for (const f of status.files) {
      const fileLines = readLines(dir, f.file);
      lines += fileLines.length;
      for (const line of fileLines) {
        const parsed = JSON.parse(line) as TraceEntry;
        expect(parsed.seq).toBe(lastSeq + 1); // ★seq 单调递增无空洞
        lastSeq = parsed.seq;
        expect(typeof parsed.rawHex).toBe('string');
      }
    }
    expect(lines).toBe(total);

    const index = readIndex(dir);
    expect(index.entriesWritten).toBe(total);
    expect(index.files).toHaveLength(4);
    expect(index.files[0]?.seqRange).toEqual([1, 50_000]);
    expect(index.droppedCount).toBe(0);
    expect(existsSync(join(dir, 'session.json'))).toBe(true);
  }, 120000);
});

describe('TC-R02 三条滚动阈值各自独立生效', () => {
  it('按条数滚动', async () => {
    const root = tmpRoot();
    cleanup.push(root);
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'r02a',
      highWaterBytes: 1 << 30,
      overrides: { maxEntriesPerFile: 100, flushIntervalMs: 50 },
    });
    await sink.start();
    for (let i = 1; i <= 250; i += 1) sink.append(makeEntry(i));
    const status = await sink.stop();
    expect(status.files.length).toBeGreaterThanOrEqual(3);
    expect(status.files[0]?.entries).toBe(100);
  });

  it('按字节滚动', async () => {
    const root = tmpRoot();
    cleanup.push(root);
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'r02b',
      highWaterBytes: 1 << 30,
      overrides: { maxFileBytes: 4096, flushIntervalMs: 50 },
    });
    await sink.start();
    for (let i = 1; i <= 200; i += 1) sink.append(makeEntry(i, { rawHex: 'AB'.repeat(64) }));
    const status = await sink.stop();
    expect(status.files.length).toBeGreaterThanOrEqual(2);
    for (const f of status.files.slice(0, -1)) expect(f.bytes).toBeGreaterThan(0);
  });

  it('按时间滚动', async () => {
    const root = tmpRoot();
    cleanup.push(root);
    let clock = 0;
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'r02c',
      highWaterBytes: 1 << 30,
      now: () => clock,
      overrides: { maxFileDurationMs: 1000, flushIntervalMs: 50 },
    });
    await sink.start();
    sink.append(makeEntry(1));
    clock = 1500;
    sink.append(makeEntry(2));
    clock = 3000;
    sink.append(makeEntry(3));
    const status = await sink.stop();
    expect(status.files.length).toBeGreaterThanOrEqual(2);
  });
});

describe('TC-R03 ★WS 背压 L2 时落盘仍全量（关键回归）', () => {
  it('BatchFlusher 丢弃 90% 以上条目，磁盘分片仍是全量', async () => {
    const root = tmpRoot();
    cleanup.push(root);

    const bus = new EventBus();
    const store = new TraceStore();
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'r03',
      highWaterBytes: 1 << 30,
      overrides: { flushIntervalMs: 50, maxEntriesPerFile: 1000 },
    });
    await sink.start();

    // ★平级订阅：TraceStore 与 RollingFileSink 都挂在 EventBus 原始入口上
    bus.subscribeEntries((e) => store.append(e));
    bus.subscribeEntries((e) => sink.append(e));

    // WS 侧：人为让 bufferedAmount 恒为高水位以上 → L2 降级
    const sentEvents: number[] = [];
    const flusher = new BatchFlusher({
      getBufferedAmount: () => 2 * 1024 * 1024,
      send: (envelope) => {
        const events = (envelope.payload as { events: Array<{ kind: string }> }).events;
        sentEvents.push(events.filter((e) => e.kind === 'trace.entry').length);
      },
    });
    bus.setStreamSink((ev) => flusher.enqueue(ev));

    const total = 300;
    for (let i = 0; i < total; i += 1) bus.publishTrace(makeEntry(0));
    flusher.flush();

    const pushed = sentEvents.reduce((a, b) => a + b, 0);
    expect(pushed).toBeLessThan(total / 10); // WS 侧确实丢了很多（L2 采样）
    expect(store.size).toBe(total); // 缓冲全量

    await sink.flush();
    const status = await sink.stop();
    const dir = status.sessionDir ?? '';
    let diskLines = 0;
    for (const f of status.files) diskLines += readLines(dir, f.file).length;
    // ★落盘全量：一行不少
    expect(diskLines).toBe(total);
    expect(status.droppedCount).toBe(0);
    flusher.dispose();
  });
});

describe('TC-R04 写盘失败降级（主链路不受影响）', () => {
  it('目录只读 → state=disabled + E_IO_SINK_OPEN_FAILED', async () => {
    if (process.getuid?.() === 0) {
      // root 下 chmod 不生效，跳过该用例（不影响 CI 结论）
      return;
    }
    const root = tmpRoot();
    cleanup.push(root);
    const readOnly = join(root, 'readonly');
    chmodSync(root, 0o500);
    const errors: AppError[] = [];
    const sink = new RollingFileSink({
      rootDir: readOnly,
      sessionId: 'r04',
      onError: (e) => errors.push(e),
    });
    const status = await sink.start();
    expect(status.state).toBe('disabled');
    expect(status.errorCode).toBe('E_IO_SINK_OPEN_FAILED');
    expect(errors.some((e) => e.code === 'E_IO_SINK_OPEN_FAILED')).toBe(true);
    // ★主链路不受影响：继续 append 不得抛异常
    expect(() => sink.append(makeEntry(1))).not.toThrow();
    sink.dispose();
  });
});

describe('TC-R05 落盘侧背压与 gap 行', () => {
  it('writableLength 超阈值 → lossy：error 类条目仍保留，恢复后写入 kind:"gap" 行', async () => {
    const root = tmpRoot();
    cleanup.push(root);
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'r05',
      // 高水位设为 1 字节：一次 write 后必然积压 → 立即 lossy
      highWaterBytes: 1,
      overrides: { flushIntervalMs: 50 },
    });
    await sink.start();

    sink.append(makeEntry(1));
    // 只入队不等待：制造真实的"写入积压"（此时 writableLength > 0）
    sink.flushNow();
    for (let i = 2; i <= 50; i += 1) sink.append(makeEntry(i));
    const errEntry = makeEntry(51, { errorCode: 'E_TXN_UDS_TIMEOUT', timeout: true });
    sink.append(errEntry); // ★error 类条目必须在 lossy 下仍保留

    const midStatus = sink.getStatus();
    expect(midStatus.droppedCount).toBeGreaterThan(0);

    // 排空 → writableLength 归零；此时再写一条普通条目会先补 gap 行
    await sink.flush();
    sink.append(makeEntry(52));
    await sink.flush();
    const status = await sink.stop();
    const dir = status.sessionDir ?? '';
    const all = readLines(dir, status.files[0]?.file ?? 'trace-000001.jsonl');
    const gapLines = all.filter((l) => l.includes('"kind":"gap"'));
    expect(gapLines).toHaveLength(1);
    const gap = JSON.parse(gapLines[0] ?? '{}') as {
      reason: string;
      fromSeq: number;
      toSeq: number;
      count: number;
    };
    expect(gap.reason).toBe('sinkBackpressure');
    expect(gap.count).toBeGreaterThan(0);
    const seqs = all
      .map((l) => JSON.parse(l) as { seq?: number })
      .filter((o) => typeof o.seq === 'number')
      .map((o) => o.seq ?? 0);
    expect(seqs).toContain(51); // error 条目被保留
  });
});

describe('TC-R06 保留策略与磁盘保护', () => {
  it('超出 RETAIN_MAX_BYTES_PER_SESSION → 删除最旧分片', async () => {
    const root = tmpRoot();
    cleanup.push(root);
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'r06a',
      highWaterBytes: 1 << 30,
      overrides: { maxEntriesPerFile: 50, retainMaxBytesPerSession: 4096, flushIntervalMs: 50 },
    });
    await sink.start();
    for (let i = 1; i <= 400; i += 1) sink.append(makeEntry(i));
    const status = await sink.stop();
    const dir = status.sessionDir ?? '';
    // 保留生效：并非所有分片都还在
    expect(status.files.length).toBeLessThan(8);
    for (const f of status.files) expect(existsSync(join(dir, f.file))).toBe(true);
    const index = readIndex(dir);
    expect(index.files.length).toBe(status.files.length);
  });

  it('可用空间不足 → 停录并报 E_IO_DISK_FULL', async () => {
    const root = tmpRoot();
    cleanup.push(root);
    const errors: AppError[] = [];
    const sink = new RollingFileSink({
      rootDir: root,
      sessionId: 'r06b',
      highWaterBytes: 1 << 30,
      // 阈值设为不可能满足 → 触发停录
      minFreeBytes: Number.MAX_SAFE_INTEGER,
      onError: (e) => errors.push(e),
      overrides: { maxEntriesPerFile: 10, flushIntervalMs: 50 },
    });
    await sink.start();
    for (let i = 1; i <= 30; i += 1) sink.append(makeEntry(i));
    expect(sink.getStatus().state).toBe('error');
    expect(sink.getStatus().errorCode).toBe('E_IO_DISK_FULL');
    expect(errors.some((e) => e.code === 'E_IO_DISK_FULL')).toBe(true);
    sink.dispose();
  });
});
