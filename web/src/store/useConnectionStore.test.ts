import { beforeEach, describe, expect, it } from 'vitest';
import { useConnectionStore } from './useConnectionStore';
import type { SessionStatus, SimStatus } from '@doip/shared';

/**
 * ★D-03 回归：WS 断开时必须清空/标记未知。
 * 不能继续显示上一次的成功状态（"ECU 还连着、路由还激活着、仿真还在跑"）。
 */

function fakeStatus(): SessionStatus {
  return {
    sessionId: 'default',
    state: 'ROUTING_ACTIVE',
    stateSinceMs: 0,
    peer: { host: '127.0.0.1', port: 13400, mode: 'sim' },
    sa: 0x0e00,
    ta: 0x1000,
    activationType: 0,
    protocolVersion: 2,
    lastRoutingCode: 0x10,
    lastRoutingCodeZh: '路由已激活',
    udsSession: 'EXTENDED',
    securityLevels: [1],
    s3RemainingMs: 4000,
    testerPresent: { enabled: true, periodMs: 2000, nextDueMs: 100 },
    counters: { tx: 3, rx: 5, errors: 0, traceCount: 8 },
    lastRttMs: 12,
  } as unknown as SessionStatus;
}

describe('D-03 — WS 断开后的陈旧状态', () => {
  beforeEach(() => {
    useConnectionStore.setState({
      wsStatus: 'open',
      status: fakeStatus(),
      entities: [{ address: '0x1000' }] as never,
      scanning: false,
      sim: { running: true } as unknown as SimStatus,
      recording: { state: 'recording' } as never,
      lastResult: { ok: true, hex: '50 03', note: '' },
      stale: false,
      errors: [],
    });
  });

  it('★markStale 清空连接/路由/会话/解锁/仿真/录盘，并置 stale', () => {
    useConnectionStore.getState().markStale();
    const s = useConnectionStore.getState();
    expect(s.status).toBeNull();
    expect(s.entities).toEqual([]);
    expect(s.scanning).toBe(false);
    expect(s.sim).toBeNull();
    expect(s.recording).toBeNull();
    expect(s.lastResult).toBeNull();
    expect(s.stale).toBe(true);
  });

  it('★保留错误历史（那是发生过的事实，不是"当前状态"）', () => {
    useConnectionStore.getState().pushError({ code: 'E_WS_CLOSED', messageZh: '断开', severity: 'warn' });
    useConnectionStore.getState().markStale();
    expect(useConnectionStore.getState().errors).toHaveLength(1);
  });

  it('后端重新推来真值 → stale 自动解除', () => {
    useConnectionStore.getState().markStale();
    expect(useConnectionStore.getState().stale).toBe(true);
    useConnectionStore.getState().setStatus(fakeStatus());
    expect(useConnectionStore.getState().stale).toBe(false);
    useConnectionStore.getState().markStale();
    useConnectionStore.getState().setSim({ running: true } as unknown as SimStatus);
    expect(useConnectionStore.getState().stale).toBe(false);
  });

  it('setEntities 顺带清掉 scanning（扫描结果到了就不该还转圈）', () => {
    useConnectionStore.setState({ scanning: true });
    useConnectionStore.getState().setEntities([{ address: '0x1000' }] as never);
    expect(useConnectionStore.getState().scanning).toBe(false);
  });
});
