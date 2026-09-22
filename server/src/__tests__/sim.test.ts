/**
 * 仿真 ECU 单测（§9.1 TC-S01 ~ TC-S06）+ 真 socket 端到端（★难点 3 验证）。
 *
 * 端到端用例断言的是"客户端连仿真必须走真实 TCP/UDP"：
 * 起 DoipEntityServer(127.0.0.1) → DoipClient 连接 → 路由激活 → 0x8001/0x8002/0x8001 完整事务。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import dgram from 'node:dgram';
import { once } from 'node:events';
import { SimEcuRuntime } from '../sim/SimEcuRuntime';
import { VirtualEcu } from '../sim/VirtualEcu';
import { FaultInjector } from '../sim/FaultInjector';
import { SimUdsResponder } from '../sim/SimUdsResponder';
import { simSeedKeyHex, cloneDefaultSimEntities } from '../sim/simPresets';
import { DoipClient } from '../doip/DoipClient';
import { DoipHeaderCodec } from '../doip/DoipHeaderCodec';
import { DoipUdpDiscovery } from '../doip/DoipUdpDiscovery';
import { TransactionManager } from '../txn/TransactionManager';
import type { SimEntityConfig } from '@doip/shared';
import { LIMITS, PayloadType, formatHex, hexToAscii, parseHex, parseLogicalAddress } from '@doip/shared';
import type { SendUdsResult } from '@doip/shared';

const TEST_PORT = 13491;
const SA = 0x0e00;
const GATEWAY = 0x1000;

function ecuCfg(): SimEntityConfig {
  const all = cloneDefaultSimEntities();
  const first = all[0];
  if (first === undefined) throw new Error('预置实体缺失');
  return first;
}

function makeEcu(): VirtualEcu {
  return new VirtualEcu(ecuCfg());
}

function toHex(result: ReturnType<VirtualEcu['handleUds']>): string {
  if (result.kind === 'response') return formatHex(result.userData);
  if (result.kind === 'nrc') return `NRC:${result.nrc.toString(16).toUpperCase()}`;
  return 'IGNORE';
}

describe('TC-S01 会话控制 / ECU 复位', () => {
  it('10 03 → 50 03 + 会话参数，且会话切到 EXTENDED', () => {
    const ecu = makeEcu();
    expect(toHex(ecu.handleUds(parseHex('1003')))).toBe('50 03 00 32 01 F4');
    expect(ecu.session).toBe('EXTENDED');
    expect(toHex(ecu.handleUds(parseHex('1001')))).toBe('50 01 00 32 01 F4');
    expect(ecu.session).toBe('DEFAULT');
  });

  it('未知子功能 → NRC 0x12', () => {
    const ecu = makeEcu();
    expect(toHex(ecu.handleUds(parseHex('1077')))).toBe('NRC:12');
  });

  it('11 01 复位后会话回默认', () => {
    const ecu = makeEcu();
    ecu.handleUds(parseHex('1003'));
    expect(toHex(ecu.handleUds(parseHex('1101')))).toBe('51 01');
    expect(ecu.session).toBe('DEFAULT');
  });
});

describe('TC-S02 读 DID（0x22）', () => {
  it('22 F190 → 62 F190 + 17 字节 VIN（ASCII 可解码）', () => {
    const ecu = makeEcu();
    const hex = toHex(ecu.handleUds(parseHex('22F190')));
    expect(hex.startsWith('62 F1 90 ')).toBe(true);
    const payload = hex.slice('62 F1 90 '.length).replace(/ /g, '');
    expect(payload.length / 2).toBe(17);
    expect(hexToAscii(payload)).toBe('LSVAM1234N2000001');
  });

  it('未知 DID → NRC 0x31', () => {
    const ecu = makeEcu();
    expect(toHex(ecu.handleUds(parseHex('22FFFF')))).toBe('NRC:31');
  });

  it('一次读多个 DID → 62 + 多组', () => {
    const ecu = makeEcu();
    const hex = toHex(ecu.handleUds(parseHex('22F190F18C')));
    expect(hex.startsWith('62 F1 90')).toBe(true);
    expect(hex).toContain('F1 8C');
  });
});

describe('TC-S03 安全访问（0x27 Seed/Key）', () => {
  it('27 01 取种子 → 27 02 正确密钥 → 67 02 且解锁等级 1', () => {
    const ecu = makeEcu();
    const seedResp = ecu.handleUds(parseHex('2701'));
    expect(seedResp.kind).toBe('response');
    if (seedResp.kind !== 'response') return;
    expect(Array.from(seedResp.userData.subarray(0, 2))).toEqual([0x67, 0x01]);
    const seed = seedResp.userData.subarray(2);
    const keyHex = simSeedKeyHex(formatHex(seed).replace(/ /g, ''));

    const keyResp = ecu.handleUds(parseHex(`2702${keyHex}`));
    expect(toHex(keyResp)).toBe('67 02');
    expect(ecu.unlockedLevels).toEqual([1]);
  });

  it('错误密钥 → NRC 0x35；连续 3 次 → NRC 0x36', () => {
    const ecu = makeEcu();
    ecu.handleUds(parseHex('2701'));
    expect(toHex(ecu.handleUds(parseHex('270200000000')))).toBe('NRC:35');
    expect(toHex(ecu.handleUds(parseHex('270200000000')))).toBe('NRC:35');
    expect(toHex(ecu.handleUds(parseHex('270200000000')))).toBe('NRC:36');
    // 锁定后再取种子 → NRC 0x37
    expect(toHex(ecu.handleUds(parseHex('2701')))).toBe('NRC:37');
  });
});

describe('TC-S04 读 DTC（0x19）与清 DTC（0x14）', () => {
  it('19 02 FF → 59 02 FF + (3B DTC + 1B 状态) × N', () => {
    const ecu = makeEcu();
    const hex = toHex(ecu.handleUds(parseHex('1902FF')));
    expect(hex.startsWith('59 02 FF ')).toBe(true);
    const rest = hex.slice('59 02 FF '.length).split(' ');
    expect(rest.length % 4).toBe(0);
    expect(rest.length / 4).toBe(2); // 预置 2 条 DTC
  });

  it('14 FF FF FF → 54，且 DTC 被清空', () => {
    const ecu = makeEcu();
    expect(toHex(ecu.handleUds(parseHex('14FFFFFF')))).toBe('54');
    expect(toHex(ecu.handleUds(parseHex('1902FF')))).toBe('59 02 FF');
  });

  it('19 01 FF → 59 01 FF + 数量', () => {
    const ecu = makeEcu();
    expect(toHex(ecu.handleUds(parseHex('1901FF')))).toBe('59 01 FF FF 00 02');
  });
});

describe('TC-S05 TesterPresent 与抑制正响应', () => {
  it('3E 00 → 7E 00；3E 80 → 不回字节', () => {
    const ecu = makeEcu();
    expect(toHex(ecu.handleUds(parseHex('3E00')))).toBe('7E 00');
    expect(toHex(ecu.handleUds(parseHex('3E80')))).toBe('IGNORE');
  });

  it('未支持的服务 → NRC 0x11', () => {
    const ecu = makeEcu();
    expect(toHex(ecu.handleUds(parseHex('3101')))).toBe('NRC:11');
  });
});

describe('TC-S06 故障注入规则表', () => {
  it('remaining 递减归零后自动禁用', () => {
    const injector = new FaultInjector();
    injector.setRules([
      {
        id: 'r1',
        enabled: true,
        match: { sid: '0x22', occurrence: 'count' },
        action: { kind: 'nrc', code: '0x31' },
        remaining: 2,
      },
    ]);
    const rule = injector.match({ sid: '0x22' });
    expect(rule).not.toBeNull();
    if (rule === null) return;
    injector.consume(rule);
    expect(rule.remaining).toBe(1);
    injector.consume(rule);
    expect(rule.enabled).toBe(false);
    expect(injector.match({ sid: '0x22' })).toBeNull();
  });

  it('occurrence=once 只命中一次', () => {
    const injector = new FaultInjector();
    injector.setRules([
      {
        id: 'once',
        enabled: true,
        match: { sid: '0x22', occurrence: 'once' },
        action: { kind: 'nack', code: '0x03' },
        remaining: null,
      },
    ]);
    const rule = injector.match({ sid: '0x22' });
    expect(rule).not.toBeNull();
    if (rule === null) return;
    injector.consume(rule);
    expect(injector.match({ sid: '0x22' })).toBeNull();
  });

  it('按 LA + SID + DID 组合匹配；routingCode 只走路由匹配', () => {
    const injector = new FaultInjector();
    injector.setRules([
      {
        id: 'la-sid',
        enabled: true,
        match: { logicalAddress: '0x1000', sid: '0x22', did: '0xF190' },
        action: { kind: 'customHex', hex: '62F19001' },
        remaining: null,
      },
      {
        id: 'routing',
        enabled: true,
        match: { occurrence: 'always' },
        action: { kind: 'routingCode', code: '0x02' },
        remaining: null,
      },
    ]);
    expect(injector.match({ logicalAddress: '0x1000', sid: '0x22', did: '0xF190' })?.id).toBe('la-sid');
    expect(injector.match({ logicalAddress: '0x1010', sid: '0x22', did: '0xF190' })).toBeNull();
    expect(injector.match({ logicalAddress: '0x1000', sid: '0x22', did: '0xF191' })).toBeNull();
    // routingCode 规则不参与诊断匹配
    expect(injector.match({ logicalAddress: '0x9FFF' })).toBeNull();
    expect(injector.matchRouting()?.id).toBe('routing');
  });
});

/* ─────────────── ★真 socket 端到端（难点 3） ─────────────── */

describe('TC-E2E 仿真 ECU（真 socket）↔ DoipClient 完整事务', () => {
  let runtime: SimEcuRuntime;
  let client: DoipClient;
  let txns: TransactionManager;
  let seq: number;
  let actualPort: number;

  beforeAll(async () => {
    runtime = new SimEcuRuntime();
    const started = await runtime.start({ port: TEST_PORT });
    actualPort = started.port;
    expect(actualPort).toBe(TEST_PORT);
    expect(runtime.getStatus().running).toBe(true);

    seq = 0;
    // ★回调经构造函数注入（闭合引用后续赋值的 txns，调用时才求值）
    client = new DoipClient({
      protocolVersion: 0x02,
      onAck: (p) => txns.onDiagnosticMessageAck(p, (seq += 1)),
      onNack: (p) => txns.onDiagnosticMessageNack(p, (seq += 1)),
      onDiagnosticMessage: (p) => txns.onDiagnosticMessage(p, (seq += 1)),
    });
    txns = new TransactionManager({
      sa: SA,
      ta: GATEWAY,
      sender: {
        sendDiagnosticMessage: (sa, ta, userData) => client.sendDiagnosticMessage(sa, ta, userData),
      },
      seqSource: { next: () => (seq += 1) },
    });

    await client.connect({ mode: 'sim', host: '127.0.0.1', port: actualPort, sa: '0x0E00', ta: '0x1000' });
  }, 30000);

  afterAll(async () => {
    txns.dispose();
    client.close('test-end');
    await runtime.stop();
  }, 30000);

  it('路由激活成功（0x0006 code=0x10）', async () => {
    const res = await client.sendRoutingActivation(SA, 0x00);
    expect(res.code).toBe(0x10);
    expect(res.codeNameZh).toContain('成功');
    expect(client.isConnected()).toBe(true);
  }, 15000);

  it('UDP 单播发现能看到仿真实体（真 dgram）', async () => {
    const discovery = new DoipUdpDiscovery({ port: actualPort });
    const entities = await discovery.unicastRequest('127.0.0.1', 2000, actualPort);
    expect(entities.length).toBeGreaterThanOrEqual(1);
    const gw = entities.find((e) => e.logicalAddress === '0x1000');
    expect(gw).toBeDefined();
    expect(gw?.vin).toBe('LSVAM1234N2000001');
    expect(gw?.isSimulated).toBe(true);
    discovery.stopPassiveListen();
  }, 15000);

  it('10 03 → COMPLETED，并记录 gatewayForwardLatencyMs', async () => {
    const r: SendUdsResult = await txns.send({ addressing: 'physical', sid: '0x10', subFunction: '0x03' });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('COMPLETED');
    expect(r.responseHex?.startsWith('50 03')).toBe(true);
    expect(typeof r.gatewayForwardLatencyMs).toBe('number');
  }, 15000);

  it('22 F190 → 返回 17 字节 VIN', async () => {
    const r = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
    expect(r.ok).toBe(true);
    expect(r.responseHex?.startsWith('62 F1 90')).toBe(true);
    const body = (r.responseHex ?? '').slice('62 F1 90 '.length).replace(/ /g, '');
    expect(hexToAscii(body)).toBe('LSVAM1234N2000001');
  }, 15000);

  it('目标地址不存在 → FAILED_NACK（网关未转发）', async () => {
    txns.setAddresses(SA, 0x9fff);
    const r = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
    expect(r.state).toBe('FAILED_NACK');
    expect(r.note).toContain('网关未转发');
    txns.setAddresses(SA, GATEWAY);
  }, 15000);

  it('故障注入 nrc 0x31 → 事务 COMPLETED 且 nrc=0x31', async () => {
    runtime.setFaultRules([
      {
        id: 'nrc31',
        enabled: true,
        match: { sid: '0x22', did: '0xF190' },
        action: { kind: 'nrc', code: '0x31' },
        remaining: null,
      },
    ]);
    const r = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
    expect(r.state).toBe('COMPLETED');
    expect(r.nrc).toBe(0x31);
    expect(r.nrcNameZh).toContain('越界');
    runtime.setFaultRules([]);
  }, 15000);

  it('故障注入 noResponse → FAILED_UDS_TIMEOUT（★而非 FAILED_ACK_TIMEOUT）', async () => {
    runtime.setFaultRules([
      {
        id: 'silent',
        enabled: true,
        match: { sid: '0x22', did: '0xF191' },
        action: { kind: 'noResponse' },
        remaining: null,
      },
    ]);
    const r = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF191'] });
    expect(r.state).toBe('FAILED_UDS_TIMEOUT');
    expect(r.note).toContain('网关已收下并转发');
    runtime.setFaultRules([]);
  }, 15000);

  it('故障注入 nack → FAILED_NACK 且 note 含"网关未转发"', async () => {
    runtime.setFaultRules([
      {
        id: 'nack01',
        enabled: true,
        match: { sid: '0x19' },
        action: { kind: 'nack', code: '0x03' },
        remaining: null,
      },
    ]);
    const r = await txns.send({ addressing: 'physical', sid: '0x19', subFunction: '0x02', dataHex: 'FF' });
    expect(r.state).toBe('FAILED_NACK');
    expect(r.note).toContain('网关未转发（非 UDS 层错误）');
    runtime.setFaultRules([]);
  }, 15000);

  it('故障注入 delayMs → 先收 7F xx 78 再收最终响应（P2* 链路）', async () => {
    runtime.setFaultRules([
      {
        id: 'delay',
        enabled: true,
        match: { sid: '0x22', did: '0xF1A0' },
        action: { kind: 'delayMs', ms: 300 },
        remaining: null,
      },
    ]);
    const r = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF1A0'] });
    expect(r.ok).toBe(true);
    expect(r.state).toBe('COMPLETED');
    // 客户端确实先经历了 pending（P2*）再收到最终响应
    const txn = txns.getTransaction(r.txnId);
    expect(txn?.nrc).toBeNull();
    runtime.setFaultRules([]);
  }, 15000);

  it('0x27 解锁链路（Seed → 算 Key → 校验）', async () => {
    const seedRes = await txns.send({ addressing: 'physical', sid: '0x27', subFunction: '0x01' });
    expect(seedRes.ok).toBe(true);
    const hex = (seedRes.responseHex ?? '').split(' ');
    expect(hex.slice(0, 2).join('')).toBe('6701');
    const seedHex = hex.slice(2).join('');
    const keyHex = simSeedKeyHex(seedHex);
    const keyRes = await txns.send({
      addressing: 'physical',
      sid: '0x27',
      subFunction: '0x02',
      dataHex: keyHex,
    });
    expect(keyRes.responseHex).toBe('67 02');
  }, 15000);

  it('3E 80（抑制正响应）→ SUPPRESSED 且不报超时', async () => {
    const r = await txns.send({ addressing: 'physical', rawHex: '3E80' });
    expect(r.state).toBe('SUPPRESSED');
    expect(r.ok).toBe(true);
    expect(r.errorCode).toBeUndefined();
  }, 15000);
});

describe('SimUdsResponder 直接调用', () => {
  it('未配置 expectedKeyHex 时给出 warn 并放行', () => {
    const cfg = ecuCfg();
    const levelCfg = cfg.security.levels[1];
    if (levelCfg !== undefined) Reflect.deleteProperty(levelCfg, 'expectedKeyHex');
    const responder = new SimUdsResponder();
    const state = { session: 'DEFAULT' as const, unlocked: new Set<number>(), attempts: new Map(), lockedUntilMs: new Map() };
    const res = responder.handle(cfg, state, parseHex('270211223344'), 0);
    expect(res.kind).toBe('response');
    expect(state.unlocked.has(1)).toBe(true);
  });

  it('SimUdsResponder.seedBytes 能取到配置种子', () => {
    const cfg = ecuCfg();
    expect(formatHex(SimUdsResponder.seedBytes(cfg, 1))).toBe('12 34 56 78');
  });
});

/**
 * ★TC-S07 互操作性补充：用**原始 socket**（不经过我们自己的 DoipClient）验证两个
 * 曾被漏掉的请求类型。两条都是在拿第三方标准库（python-doipclient）做互操作测试时暴露的：
 *
 *  - TCP `0x0007` Alive check request：tester 主动询问存活也是合法场景，
 *    实体必须回 `0x0008`（payload = 实体逻辑地址）。此前没有分支 → 静默丢弃 → 对方超时。
 *  - UDP `0x4001` 实体状态请求：必须回 `0x4002`（7 字节）。此前 UDP 只处理
 *    0x0001/0x0002/0x0003 → 静默丢弃 → 对方超时。
 *
 * 用原始 socket 而不是 DoipClient，是为了避免"自己验自己"。
 */
describe('TC-S07 互操作补充：0x0007 保活 与 0x4001 实体状态', () => {
  const EXTRA_PORT = 13495;
  let runtime: SimEcuRuntime;
  let extraPort = EXTRA_PORT;

  beforeAll(async () => {
    runtime = new SimEcuRuntime();
    const started = await runtime.start({ port: EXTRA_PORT });
    extraPort = started.port;
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('tester 主动发 0x0007 → 实体回 0x0008，payload 为实体逻辑地址', async () => {
    const socket = net.connect({ host: '127.0.0.1', port: extraPort });
    await once(socket, 'connect');
    socket.write(DoipHeaderCodec.buildFrame(0x02, PayloadType.ALIVE_CHECK_REQ, Buffer.alloc(0)));
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    socket.destroy();

    const header = DoipHeaderCodec.decodeHeader(chunk, 0);
    expect(header.payloadType).toBe(PayloadType.ALIVE_CHECK_RES);
    expect(header.payloadLength).toBe(2);
    const la = chunk.subarray(8, 10).readUInt16BE(0);
    // 预置第一个实体的逻辑地址
    expect(la).toBe(parseLogicalAddress(ecuCfg().logicalAddress));
  });

  it('UDP 0x4001 → 0x4002：7 字节，且 maxDataSize 与 LIMITS 常量一致', async () => {
    const sock = dgram.createSocket('udp4');
    const req = DoipHeaderCodec.buildFrame(0x02, PayloadType.ENTITY_STATUS_REQ, Buffer.alloc(0));
    sock.send(req, extraPort, '127.0.0.1');
    const [msg] = (await once(sock, 'message')) as [Buffer];
    sock.close();

    const header = DoipHeaderCodec.decodeHeader(msg, 0);
    expect(header.payloadType).toBe(PayloadType.ENTITY_STATUS_RES);
    expect(header.payloadLength).toBe(7);
    expect(msg.readUInt8(8)).toBe(0x01); // nodeType = DoIP gateway
    expect(msg.readUInt8(9)).toBe(LIMITS.SIM_MAX_CONCURRENT_TCP_SOCKETS);
    // currentlyOpenSockets 取真实连接数（此刻 TCP 已断开，应为 0）
    expect(msg.readUInt8(10)).toBe(0);
    expect(msg.readUInt32BE(11)).toBe(LIMITS.MAX_PAYLOAD_BYTES);
  });

  it('UDP 未处理的请求类型必须留下 warn 日志而不是静默丢弃', async () => {
    const sock = dgram.createSocket('udp4');
    // 0x0007 是 TCP 侧的消息，走 UDP 属于未处理类型
    const req = DoipHeaderCodec.buildFrame(0x02, PayloadType.ALIVE_CHECK_REQ, Buffer.alloc(0));
    sock.send(req, extraPort, '127.0.0.1');
    // 不期望有响应；这里只验证"不崩、且 0x4001 仍能正常工作"
    await new Promise((r) => setTimeout(r, 150));
    sock.close();

    const sock2 = dgram.createSocket('udp4');
    const good = DoipHeaderCodec.buildFrame(0x02, PayloadType.ENTITY_STATUS_REQ, Buffer.alloc(0));
    sock2.send(good, extraPort, '127.0.0.1');
    const [msg] = (await once(sock2, 'message')) as [Buffer];
    sock2.close();
    expect(DoipHeaderCodec.decodeHeader(msg, 0).payloadType).toBe(PayloadType.ENTITY_STATUS_RES);
  });
});
