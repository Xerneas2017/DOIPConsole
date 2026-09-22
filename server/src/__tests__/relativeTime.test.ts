import { describe, expect, it } from 'vitest';
import type { DoipFrame } from '@doip/shared';
import { TraceEntryBuilder } from '../trace/TraceEntryBuilder';
import type { DoipSessionFrameContext } from '../session/DoipSession';

/**
 * ★D-05 回归：`tsRelMs` 的基准必须是**本次连接建立的时刻**，
 * 不是后端进程启动时刻（否则进程挂机一晚后第一条报文的相对时间就是几万秒）。
 */

function frame8001(): DoipFrame {
  const raw = Uint8Array.from([
    0x02, 0xfd, 0x80, 0x01, 0x00, 0x00, 0x00, 0x06, 0x0e, 0x00, 0x10, 0x00, 0x10, 0x03,
  ]);
  return {
    header: {
      protocolVersion: 0x02,
      inverseProtocolVersion: 0xfd,
      inverseVersionValid: true,
      payloadType: 0x8001,
      payloadLength: 6,
    },
    payload: raw.subarray(8),
    raw,
    firstByteAtMs: 0,
  };
}

function ctx(overrides: Partial<DoipSessionFrameContext> = {}): DoipSessionFrameContext {
  return {
    sessionId: 'default',
    peer: '127.0.0.1:13400',
    transport: 'TCP',
    direction: 'TX',
    ...overrides,
  };
}

describe('D-05 — 相对时间基准', () => {
  it('★基准取 ctx.sessionStartMs（连接建立时刻），而不是后端进程启动时刻', () => {
    // 构造参数给一个很早的兜底基准（模拟"进程启动于 10 分钟前"）
    const processStart = Date.now() - 600_000;
    const builder = new TraceEntryBuilder(processStart);
    const connectAt = Date.now() - 2_000;
    const entry = builder.build(frame8001(), ctx({ sessionStartMs: connectAt }));
    // 相对时间 ≈ 2 s，而不是 ≈ 600 s
    expect(entry.tsRelMs).toBeGreaterThanOrEqual(1_900);
    expect(entry.tsRelMs).toBeLessThan(4_000);
  });

  it('ctx 未带基准时回落到构造参数（不产生 NaN / 负数）', () => {
    const builder = new TraceEntryBuilder(Date.now());
    const entry = builder.build(frame8001(), ctx());
    expect(Number.isFinite(entry.tsRelMs)).toBe(true);
    expect(entry.tsRelMs).toBeGreaterThanOrEqual(0);
  });

  it('基准为未来时刻（时钟回拨）时钳到 0，不出现负数', () => {
    const builder = new TraceEntryBuilder(Date.now());
    const entry = builder.build(frame8001(), ctx({ sessionStartMs: Date.now() + 5_000 }));
    expect(entry.tsRelMs).toBe(0);
  });
});
