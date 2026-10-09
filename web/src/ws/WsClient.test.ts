import { describe, expect, it } from 'vitest';
import { TIMING } from '@doip/shared';
import { describeWsClose } from './WsClient';

/**
 * ★裁定① 回归：close 事件归一成"人话"的纯函数。
 * 自动重连保留（Q1 豁免的是传输层），但断线原因必须能被 UI 直接展示——
 * 归因错了，用户就会带着错误预期去点连接/解锁。
 */

describe('裁定① — describeWsClose 归因', () => {
  it('用户主动断开：明确"不会自动重连"', () => {
    const s = describeWsClose({ closedByUser: true, heartbeatTimeout: false, code: 1000, reason: '' });
    expect(s).toContain('主动断开');
    expect(s).toContain('不会自动重连');
  });

  it('心跳超时优先于 close code（本端因失活主动 close，code 无诊断价值）', () => {
    const s = describeWsClose({ closedByUser: false, heartbeatTimeout: true, code: 1006, reason: '' });
    expect(s).toContain('心跳超时');
    expect(s).toContain(String(TIMING.WS_PONG_TIMEOUT_MS));
  });

  it('1006 → 后端进程可能已退出', () => {
    const s = describeWsClose({ closedByUser: false, heartbeatTimeout: false, code: 1006, reason: '' });
    expect(s).toContain('1006');
    expect(s).toContain('后端进程');
  });

  it('正常远端断开：带上 code 与 reason 原文', () => {
    const s = describeWsClose({ closedByUser: false, heartbeatTimeout: false, code: 1001, reason: 'going away' });
    expect(s).toContain('code=1001');
    expect(s).toContain('going away');
  });

  it('无 code（网络中断兜底形态）也有明确文案', () => {
    const s = describeWsClose({ closedByUser: false, heartbeatTimeout: false, code: 0, reason: '' });
    expect(s).toContain('无 close code');
  });
});
