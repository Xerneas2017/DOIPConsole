/**
 * ★协议完整度补齐回归测试：
 *  1. tester 侧 UDP 实体状态请求（0x4001 → 0x4002）—— 之前只有仿真侧应答，tester 从未发过；
 *  2. tester 侧 UDP 电源模式请求（0x4003 → 0x4004）—— 仿真侧此前也缺应答，一并补齐验证；
 *  3. TCP 主动 Alive Check（0x0007 → 0x0008）走 ConnectionManager 端到端；
 *  4. ConnectConfig.protocolVersion 真正生效（Q8：之前 schema 有字段但从未传入 client）。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIND_HOST } from '@doip/shared';
import { DoipUdpDiscovery } from '../doip/DoipUdpDiscovery';
import { ConnectionManager } from '../session/ConnectionManager';
import { SimEcuRuntime } from '../sim/SimEcuRuntime';
import { DoipEntityUdp } from '../sim/DoipEntityUdp';
import { cloneDefaultSimEntities } from '../sim/simPresets';

describe('tester 侧 UDP 管理报文（0x4001 / 0x4003）', () => {
  let udp: DoipEntityUdp;
  let port = 13501;

  beforeAll(async () => {
    udp = new DoipEntityUdp({
      host: BIND_HOST,
      port,
      entities: cloneDefaultSimEntities(),
      openSocketCount: () => 2,
    });
    port = await udp.start();
  }, 15000);

  afterAll(async () => {
    await udp.stop();
  }, 15000);

  it('0x4001 → 0x4002：拿到 nodeType / 并发容量 / 当前连接数 / maxDataSize', async () => {
    const discovery = new DoipUdpDiscovery({ port });
    const status = await discovery.requestEntityStatus(BIND_HOST, undefined, port);
    expect(status).not.toBeNull();
    expect(status?.nodeType).toBe(0x01); // 仿真语义上是网关
    expect(status?.maxConcurrentSockets).toBeGreaterThan(0);
    expect(status?.currentlyOpenSockets).toBe(2); // 构造时注入的计数
    expect(status?.maxDataSize).toBeGreaterThan(0);
    expect(status?.from).toContain(BIND_HOST);
    expect(status?.latencyMs).toBeGreaterThanOrEqual(0);
  }, 10000);

  it('0x4003 → 0x4004：拿到电源模式码（0x00~0x03）', async () => {
    const discovery = new DoipUdpDiscovery({ port });
    const result = await discovery.requestPowerMode(BIND_HOST, undefined, port);
    expect(result).not.toBeNull();
    expect(result?.powerMode).toBeGreaterThanOrEqual(0x00);
    expect(result?.powerMode).toBeLessThanOrEqual(0x03);
  }, 10000);

  it('无响应目标：两条请求都按超时返回 null 而不是挂死', async () => {
    const discovery = new DoipUdpDiscovery({ port: 13999 }); // 空端口
    const t1 = await discovery.requestEntityStatus(BIND_HOST, 300, 13999);
    expect(t1).toBeNull();
    const t2 = await discovery.requestPowerMode(BIND_HOST, 300, 13999);
    expect(t2).toBeNull();
  }, 10000);
});

describe('TCP 主动 Alive Check + protocolVersion 生效（端到端，仿真真 socket）', () => {
  let sim: SimEcuRuntime;
  let port = 13502;

  beforeAll(async () => {
    sim = new SimEcuRuntime();
    const started = await sim.start({ port, announce: false });
    port = started.port;
  }, 30000);

  afterAll(async () => {
    await sim.stop();
  }, 30000);

  it('aliveCheck()：ROUTING_ACTIVE → ALIVE_CHECKING → 回到 ROUTING_ACTIVE，RTT 合理', async () => {
    const mgr = new ConnectionManager({});
    try {
      await mgr.connect({ mode: 'sim', host: BIND_HOST, port, sa: '0x0E00', ta: '0x1000' });
      expect(mgr.statusOf()?.state).toBe('ROUTING_ACTIVE');

      const result = await mgr.aliveCheck();
      expect(result.sourceAddress).toBe(0x1000); // 仿真主实体回自己的逻辑地址
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(mgr.statusOf()?.state).toBe('ROUTING_ACTIVE'); // 环路回到原态
      expect(mgr.statusOf()?.lastRttMs).toBe(result.latencyMs);
    } finally {
      mgr.dispose();
    }
  }, 30000);

  it('未连接时 aliveCheck() 显式报 E_CONN_NOT_CONNECTED，而不是抛裸异常', async () => {
    const mgr = new ConnectionManager({});
    try {
      await expect(mgr.aliveCheck()).rejects.toMatchObject({ code: 'E_CONN_NOT_CONNECTED' });
    } finally {
      mgr.dispose();
    }
  }, 10000);

  it('★Q8：ConnectConfig.protocolVersion="0x03" 真正生效（修复前从未传入 client）', async () => {
    const mgr = new ConnectionManager({});
    try {
      await mgr.connect({
        mode: 'sim',
        host: BIND_HOST,
        port,
        sa: '0x0E00',
        ta: '0x1000',
        protocolVersion: '0x03',
      });
      // 连接成功说明 0x03 帧头被仿真接受；status 里回显的必须是 3
      expect(mgr.statusOf()?.protocolVersion).toBe(0x03);
    } finally {
      mgr.dispose();
    }
  }, 30000);

  it('非法协议版本（0x05）被拒绝，报 E_CONN_INVALID_CONFIG', async () => {
    const mgr = new ConnectionManager({});
    try {
      await expect(
        mgr.connect({
          mode: 'sim',
          host: BIND_HOST,
          port,
          sa: '0x0E00',
          ta: '0x1000',
          protocolVersion: '0x05',
        }),
      ).rejects.toMatchObject({ code: 'E_CONN_INVALID_CONFIG' });
    } finally {
      mgr.dispose();
    }
  }, 10000);
}, );
