/**
 * ★难点 1 单测：DoipFrameReader 分帧状态机（§9.1 TC-F01 ~ TC-F12）。
 *
 * 这些用例断言的是**真实协议行为**（半包/粘包/超上限/压实/深拷贝），不是"函数存在性"。
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { DoipFrameReader } from '../doip/DoipFrameReader';
import type { FrameReaderError, FrameReaderOptions } from '../doip/DoipFrameReader';
import { DoipHeaderCodec } from '../doip/DoipHeaderCodec';
import { LIMITS, PayloadType, TIMING } from '@doip/shared';
import type { DoipFrame } from '@doip/shared';

interface Harness {
  reader: DoipFrameReader;
  frames: DoipFrame[];
  errors: FrameReaderError[];
}

function makeReader(overrides: Partial<FrameReaderOptions> = {}): Harness {
  const frames: DoipFrame[] = [];
  const errors: FrameReaderError[] = [];
  const reader = new DoipFrameReader({
    maxPayloadBytes: LIMITS.MAX_PAYLOAD_BYTES,
    maxBufferBytes: LIMITS.MAX_FRAME_READER_BUFFER_BYTES,
    incompleteFrameTimeoutMs: TIMING.FRAME_ASSEMBLY_TIMEOUT_MS,
    versionPolicy: 'lenient',
    resyncOnDesync: false,
    onFrame: (f) => frames.push(f),
    onError: (e) => errors.push(e),
    ...overrides,
  });
  return { reader, frames, errors };
}

/** 造一帧：8 字节头 + payload */
function mkFrame(payloadType: number, payload: number[] | Uint8Array, pv = 0x02): Buffer {
  return DoipHeaderCodec.buildFrame(pv, payloadType, Uint8Array.from(payload));
}

function uds(sa: number, ta: number, userData: number[]): Buffer {
  const payload = new Uint8Array([sa >> 8, sa & 0xff, ta >> 8, ta & 0xff, ...userData]);
  return mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, payload);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TC-F01 正常单帧', () => {
  it('一次 push 完整帧 → 产出 1 帧，字段正确', () => {
    const h = makeReader();
    const raw = uds(0x0e00, 0x1000, [0x22, 0xf1, 0x90]);
    h.reader.push(raw);

    expect(h.frames).toHaveLength(1);
    const f = h.frames[0];
    expect(f).toBeDefined();
    if (f === undefined) return;
    expect(f.header.protocolVersion).toBe(0x02);
    expect(f.header.inverseProtocolVersion).toBe(0xfd);
    expect(f.header.inverseVersionValid).toBe(true);
    expect(f.header.payloadType).toBe(PayloadType.DIAGNOSTIC_MESSAGE);
    expect(f.header.payloadLength).toBe(7);
    expect(f.payload.length).toBe(7);
    expect(f.raw.length).toBe(15);
    expect(Buffer.from(f.raw).equals(raw)).toBe(true);
    expect(h.errors).toHaveLength(0);
    expect(h.reader.pendingBytes()).toBe(0);
  });
});

describe('TC-F02 半包', () => {
  it('分 3 次 push，前两次不得产出帧', () => {
    const h = makeReader();
    const raw = uds(0x0e00, 0x1000, [0x22, 0xf1, 0x90]);
    const third = Math.ceil(raw.length / 3);
    h.reader.push(raw.subarray(0, third));
    expect(h.frames).toHaveLength(0);
    h.reader.push(raw.subarray(third, third * 2));
    expect(h.frames).toHaveLength(0);
    h.reader.push(raw.subarray(third * 2));
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]?.header.payloadLength).toBe(7);
  });

  it('先只给 4 字节头片段（不足 8 字节）也不得产出', () => {
    const h = makeReader();
    const raw = uds(0x0e00, 0x1000, [0x10, 0x03]);
    h.reader.push(raw.subarray(0, 4));
    expect(h.frames).toHaveLength(0);
    h.reader.push(raw.subarray(4));
    expect(h.frames).toHaveLength(1);
  });
});

describe('TC-F03 粘包（两帧一次性到达）', () => {
  it('两个完整帧挤在一个 TCP 段 → 产出 2 帧且边界正确', () => {
    const h = makeReader();
    const a = uds(0x0e00, 0x1000, [0x10, 0x03]);
    const b = uds(0x1000, 0x0e00, [0x50, 0x03]);
    h.reader.push(Buffer.concat([a, b]));

    expect(h.frames).toHaveLength(2);
    expect(Array.from(h.frames[0]?.payload ?? [])).toEqual([0x0e, 0x00, 0x10, 0x00, 0x10, 0x03]);
    expect(Array.from(h.frames[1]?.payload ?? [])).toEqual([0x10, 0x00, 0x0e, 0x00, 0x50, 0x03]);
    expect(Buffer.from(h.frames[1]?.raw ?? []).equals(b)).toBe(true);
  });
});

describe('TC-F04 一帧含多包', () => {
  it('3 帧合并 push → 产出 3 帧且顺序正确', () => {
    const h = makeReader();
    const frames = [
      uds(0x0e00, 0x1000, [0x10, 0x03]),
      mkFrame(PayloadType.DIAGNOSTIC_MESSAGE_ACK, [0x10, 0x00, 0x0e, 0x00, 0x00, 0x10, 0x03]),
      uds(0x1000, 0x0e00, [0x50, 0x03]),
    ];
    h.reader.push(Buffer.concat(frames));

    expect(h.frames).toHaveLength(3);
    expect(h.frames.map((f) => f.header.payloadType)).toEqual([
      PayloadType.DIAGNOSTIC_MESSAGE,
      PayloadType.DIAGNOSTIC_MESSAGE_ACK,
      PayloadType.DIAGNOSTIC_MESSAGE,
    ]);
    h.frames.forEach((f, i) => {
      expect(Buffer.from(f.raw).equals(frames[i] ?? Buffer.alloc(0))).toBe(true);
    });
  });
});

describe('TC-F05 极端切分（逐字节）', () => {
  it('按 1 字节逐次 push → 恰好在第 total 次产出', () => {
    const h = makeReader();
    const raw = uds(0x0e00, 0x1000, [0x22, 0xf1, 0x90]);
    for (let i = 0; i < raw.length; i += 1) {
      h.reader.push(raw.subarray(i, i + 1));
      const expected = i === raw.length - 1 ? 1 : 0;
      expect(h.frames.length).toBe(expected);
    }
    expect(h.frames).toHaveLength(1);
  });
});

describe('TC-F06 payloadLength 超上限', () => {
  it('payloadLength=0xFFFFFFFF → E_DOIP_PAYLOAD_TOO_LARGE，且不得分配该大小内存', () => {
    const h = makeReader({ maxPayloadBytes: LIMITS.MAX_PAYLOAD_BYTES });
    // 只构造 8 字节头（payload 一字节都没到），payloadLength 已是非法上界
    const header = Buffer.alloc(8);
    header.writeUInt8(0x02, 0);
    header.writeUInt8(0xfd, 1);
    header.writeUInt16BE(PayloadType.DIAGNOSTIC_MESSAGE, 2);
    header.writeUInt32BE(0xffffffff, 4);

    const before = process.memoryUsage().heapUsed;
    h.reader.push(header);
    const after = process.memoryUsage().heapUsed;

    expect(h.frames).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('E_DOIP_PAYLOAD_TOO_LARGE');
    expect(h.errors[0]?.recoverable).toBe(false);
    // ★关键：不得真的去分配 4 GiB（堆增长必须远小于 1 GiB）
    expect(after - before).toBeLessThan(1024 * 1024 * 1024);
    expect(h.reader.isHalted()).toBe(true);
  });
});

describe('TC-F07 缓冲溢出', () => {
  it('持续 push 垃圾且永不完整 → E_DOIP_BUFFER_OVERFLOW', () => {
    // 小缓冲便于触发：payloadLength 合法（未超单帧上界）但缓冲装不下
    const h = makeReader({ maxBufferBytes: 4096, maxPayloadBytes: LIMITS.MAX_PAYLOAD_BYTES });
    const header = Buffer.alloc(8);
    header.writeUInt8(0x02, 0);
    header.writeUInt8(0xfd, 1);
    header.writeUInt16BE(PayloadType.DIAGNOSTIC_MESSAGE, 2);
    header.writeUInt32BE(100000, 4);

    h.reader.push(header);
    for (let i = 0; i < 40 && h.errors.length === 0; i += 1) {
      h.reader.push(Buffer.alloc(512, 0xaa));
    }
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('E_DOIP_BUFFER_OVERFLOW');
    expect(h.errors[0]?.recoverable).toBe(false);
    expect(h.errors[0]?.dumpHex.length).toBeGreaterThan(0);
  });
});

describe('TC-F08 分帧超时', () => {
  it('半包卡死并推进 5s → E_DOIP_INCOMPLETE_FRAME_TIMEOUT', () => {
    let fakeNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNow);

    const h = makeReader({ incompleteFrameTimeoutMs: TIMING.FRAME_ASSEMBLY_TIMEOUT_MS });
    const raw = uds(0x0e00, 0x1000, [0x22, 0xf1, 0x90]);
    h.reader.push(raw.subarray(0, 5)); // 只到半个头之后一点点

    fakeNow = 1000;
    h.reader.tick();
    expect(h.errors).toHaveLength(0); // 未超时

    fakeNow = TIMING.FRAME_ASSEMBLY_TIMEOUT_MS + 1;
    h.reader.tick();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('E_DOIP_INCOMPLETE_FRAME_TIMEOUT');
    expect(h.reader.isHalted()).toBe(true);
  });
});

describe('TC-F09 inverse 校验 lenient / strict', () => {
  it('lenient：inverse 无效仍继续解析并打标', () => {
    const h = makeReader({ versionPolicy: 'lenient' });
    // pv=0x02, ipv=0x00（非 0xFD）→ inverse 无效
    const raw = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, 0x22], 0x02);
    raw.writeUInt8(0x00, 1);
    h.reader.push(raw);

    expect(h.errors).toHaveLength(0);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]?.header.inverseVersionValid).toBe(false);
    expect(h.frames[0]?.header.payloadType).toBe(PayloadType.DIAGNOSTIC_MESSAGE);
  });

  it('strict：inverse 无效立即报错并停止', () => {
    const h = makeReader({ versionPolicy: 'strict' });
    const raw = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, [0x0e, 0x00, 0x10, 0x00, 0x22], 0x02);
    raw.writeUInt8(0x00, 1);
    h.reader.push(raw);

    expect(h.frames).toHaveLength(0);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.code).toBe('E_DOIP_INVERSE_VERSION_INVALID');
    expect(h.errors[0]?.recoverable).toBe(false);
  });
});

describe('TC-F10 压实正确性', () => {
  it('灌 2 MiB 数据（大量小帧）后每帧 raw 与原始字节逐字节相等', () => {
    const h = makeReader();
    const frames: Buffer[] = [];
    let total = 0;
    while (total < 2 * 1024 * 1024) {
      const payloadLen = 40;
      const payload = Array.from({ length: payloadLen }, (_, i) => (i + total) & 0xff);
      const f = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, payload);
      frames.push(f);
      total += f.length;
    }
    // 一次性 push 全部（会触发多次压实）
    h.reader.push(Buffer.concat(frames));

    expect(h.errors).toHaveLength(0);
    expect(h.frames).toHaveLength(frames.length);
    h.frames.forEach((f, i) => {
      expect(Buffer.from(f.raw).equals(frames[i] ?? Buffer.alloc(0))).toBe(true);
    });
  });
});

describe('TC-F11 raw 深拷贝', () => {
  it('产出帧后继续 push 触发压实，先前帧 raw 不得被覆写', () => {
    const h = makeReader();
    const first = mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, Array.from({ length: 200 }, () => 0x11));
    h.reader.push(first);
    expect(h.frames).toHaveLength(1);
    const firstRawCopy = Buffer.from(h.frames[0]?.raw ?? []);
    expect(firstRawCopy.equals(first)).toBe(true);

    // 再灌入足以触发压实/扩容的数据量
    const bulk = Buffer.concat(
      Array.from({ length: 200 }, () => mkFrame(PayloadType.DIAGNOSTIC_MESSAGE, Array.from({ length: 300 }, () => 0x22))),
    );
    h.reader.push(bulk);

    // ★先前帧的 raw 必须仍是原样
    expect(Buffer.from(h.frames[0]?.raw ?? []).equals(first)).toBe(true);
    expect(firstRawCopy.equals(first)).toBe(true);
  });
});

describe('TC-F12 零长度 payload', () => {
  it('payloadLength=0 的帧（0x0007 AliveCheckRequest）正确产出', () => {
    const h = makeReader();
    const raw = DoipHeaderCodec.buildFrame(0x02, PayloadType.ALIVE_CHECK_REQ, new Uint8Array(0));
    h.reader.push(raw);

    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]?.header.payloadLength).toBe(0);
    expect(h.frames[0]?.payload.length).toBe(0);
    expect(h.frames[0]?.raw.length).toBe(8);
  });
});

describe('附加：粘包 + 半包混合（真实 TCP 常见形态）', () => {
  it('帧1完整 + 帧2只剩半个头 + 后续补齐 → 正确产出 2 帧', () => {
    const h = makeReader();
    const a = uds(0x0e00, 0x1000, [0x10, 0x03]);
    const b = uds(0x1000, 0x0e00, [0x50, 0x03]);
    h.reader.push(Buffer.concat([a, b.subarray(0, 12)]));
    expect(h.frames).toHaveLength(1);
    h.reader.push(b.subarray(12));
    expect(h.frames).toHaveLength(2);
    expect(Buffer.from(h.frames[1]?.raw ?? []).equals(b)).toBe(true);
  });
});
