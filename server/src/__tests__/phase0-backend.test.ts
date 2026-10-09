/**
 * Phase 0 后端批次回归 TC（审计 → 修复 → 证明）。
 *
 * 覆盖：#1 路由拒绝码假激活 / #2 重复连接守门 / #3 SA 取值时机 /
 * #4 危险操作后端门禁（原始 hex 不得绕过）/ #7 断开单一收尾出口 /
 * #8 fire-and-forget 迟到 ACK 静默吞掉 / #9 被动公告并入扫描结果 /
 * #10 路由激活响应 9/13 字节双容忍。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import dgram from 'node:dgram';
import type { Socket } from 'node:net';

import { PayloadType, TIMING, parseHex } from '@doip/shared';
import type { DiagnosticMessageAckPayload, SendUdsRequest } from '@doip/shared';
import { DoipHeaderCodec } from '../doip/DoipHeaderCodec';
import { DoipPayloadCodec } from '../doip/DoipPayloadCodec';
import { DoipUdpDiscovery } from '../doip/DoipUdpDiscovery';
import { DoipSession } from '../session/DoipSession';
import type { ConnectionManager } from '../session/ConnectionManager';
import { TransactionManager } from '../txn/TransactionManager';
import type { TxnEvent, TxnSender } from '../txn/TransactionManager';
import { UdsService } from '../uds/UdsService';

const CFG = { mode: 'sim' as const, host: '127.0.0.1', port: 13401, sa: '0x0E00', ta: '0x1000' };

/* ─── 可控假 TCP 对端（参考 qa-m2 夹具，可按需改激活响应） ─── */

interface PeerOpts {
  /** 0x0006 响应码（默认 0x10 成功） */
  routingCode?: number;
  /** 依次响应多个 0x0005 的响应码序列（优先于 routingCode，用于「拒绝→重激活」链路） */
  routingCodes?: number[];
  /** true = 用 9 字节旧格式响应（无 reservedOem，legacy 0x01 网关） */
  legacy9ByteResponse?: boolean;
}

interface FakePeer {
  socket: Socket;
  clientFrames(): Array<{ type: number; payload: Buffer; raw: Buffer }>;
  resetTx(): void;
}

function makeFakePeer(opts: PeerOpts = {}): FakePeer {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  let tx = Buffer.alloc(0);
  let frames: Array<{ type: number; payload: Buffer; raw: Buffer }> = [];
  const codes = opts.routingCodes ?? [opts.routingCode ?? 0x10];
  let repliesSent = 0;

  const respondRoutingActivation = (code: number): void => {
    // ★必须异步回：DoipClient 是"先 writeFrame 再注册 waiter"，同步回会被丢弃
    setImmediate(() => {
      let payload: Buffer;
      if (opts.legacy9ByteResponse === true) {
        payload = Buffer.alloc(9, 0x00);
        payload.writeUInt16BE(0x0e00, 0);
        payload.writeUInt16BE(0x1000, 2);
        payload.writeUInt8(code, 4);
      } else {
        payload = DoipPayloadCodec.encode({
          kind: 'routingActivationResponse',
          payloadType: PayloadType.ROUTING_ACTIVATION_RES,
          value: {
            testerLogicalAddress: 0x0e00,
            doipEntityLogicalAddress: 0x1000,
            routingActivationResponseCode: code,
            reservedIso: 0,
            reservedOem: new Uint8Array(4),
          },
        });
      }
      toClient.write(DoipHeaderCodec.buildFrame(0x02, PayloadType.ROUTING_ACTIVATION_RES, payload));
    });
  };

  fromClient.on('data', (c: Buffer) => {
    tx = Buffer.concat([tx, c]);
    for (;;) {
      if (tx.length < 8) break;
      const len = tx.readUInt32BE(4);
      const total = 8 + len;
      if (tx.length < total) break;
      const raw = Buffer.from(tx.subarray(0, total));
      frames.push({ type: raw.readUInt16BE(2), payload: raw.subarray(8), raw });
      tx = tx.subarray(total);
    }
    const reqCount = frames.filter((f) => f.type === PayloadType.ROUTING_ACTIVATION_REQ).length;
    while (repliesSent < reqCount && repliesSent < codes.length) {
      respondRoutingActivation(codes[repliesSent] ?? 0x10);
      repliesSent += 1;
    }
  });

  const socket = {
    on: (ev: string, h: (...a: unknown[]) => void) => {
      if (ev === 'data') toClient.on('data', h);
      return socket;
    },
    once: () => socket,
    removeListener: () => socket,
    removeAllListeners: () => socket,
    write: (b: Buffer) => {
      fromClient.write(Buffer.from(b));
      return true;
    },
    destroy: () => socket,
    end: () => socket,
    destroyed: false,
    remoteAddress: '127.0.0.1',
    remotePort: 13401,
    setTimeout: () => socket,
    setNoDelay: () => socket,
    setKeepAlive: () => socket,
    ref: () => socket,
    unref: () => socket,
  } as unknown as Socket;

  return {
    socket,
    clientFrames: () => frames,
    resetTx: () => {
      tx = Buffer.alloc(0);
      frames = [];
    },
  };
}

function makeSession(peer: FakePeer, onError?: (code: string) => void): DoipSession {
  return new DoipSession({
    sessionId: 'phase0',
    seqSource: { next: () => 1 },
    onFrame: () => 1,
    client: { factory: { connect: async () => peer.socket } },
    ...(onError === undefined ? {} : { onError: (e) => onError(e.code) }),
  });
}

/* ═══════════════ #1 路由激活拒绝码 ═══════════════ */

describe('#1 路由激活拒绝码不得被当成功（审计 P0-1）', () => {
  it('0x00 拒绝 → connect 报 E_ROUTING_DENIED、状态 ERROR、带码表 hint', async () => {
    const peer = makeFakePeer({ routingCode: 0x00 });
    const session = makeSession(peer);
    const err = await session.connect(CFG).then(() => null, (e: unknown) => e as Error & { code: string; hintZh?: string });
    expect(err).not.toBeNull();
    expect(err?.code).toBe('E_ROUTING_DENIED');
    expect(err?.message).toContain('源地址未注册');
    expect(err?.hintZh).toContain('白名单');
    expect(session.status.state).toBe('ERROR');
    expect(session.status.lastRoutingCode).toBe(0x00);
    session.dispose();
  });

  it('0x10 成功 → ROUTING_ACTIVE（对照组）', async () => {
    const peer = makeFakePeer({ routingCode: 0x10 });
    const session = makeSession(peer);
    const status = await session.connect(CFG);
    expect(status.state).toBe('ROUTING_ACTIVE');
    session.dispose();
  });

  it('拒绝(0x01) → ERROR 后手动重激活（同 socket 再发 0x0005）成功 → ROUTING_ACTIVE、零非法迁移', async () => {
    const peer = makeFakePeer({ routingCodes: [0x01, 0x10] });
    const errorCodes: string[] = [];
    const session = makeSession(peer, (code) => errorCodes.push(code));
    await expect(session.connect(CFG)).rejects.toMatchObject({ code: 'E_ROUTING_DENIED' });
    expect(session.status.state).toBe('ERROR');
    errorCodes.length = 0;

    await session.reactivate();
    expect(session.status.state).toBe('ROUTING_ACTIVE');
    expect(errorCodes).toEqual([]); // ★ERROR→ROUTING_ACTIVATING 迁移边必须存在
    session.dispose();
  });
});

/* ═══════════════ #10 路由激活响应 9/13 双容忍 ═══════════════ */

describe('#10 路由激活响应 9/13 字节双容忍（审计 P2，互操作反向孪生）', () => {
  it('9 字节响应解码成功且 reservedOem 为空数组', () => {
    const nine = Buffer.from([0x0e, 0x00, 0x10, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00]);
    const d = DoipPayloadCodec.decode(PayloadType.ROUTING_ACTIVATION_RES, nine);
    expect(d.kind).toBe('routingActivationResponse');
    if (d.kind === 'routingActivationResponse') {
      expect(d.value.testerLogicalAddress).toBe(0x0e00);
      expect(d.value.routingActivationResponseCode).toBe(0x10);
      expect(d.value.reservedOem).toEqual(new Uint8Array(0));
    }
  });

  it('13 字节响应 reservedOem 完整取出', () => {
    const buf = Buffer.alloc(13, 0x00);
    buf.writeUInt16BE(0x0e00, 0);
    buf.writeUInt16BE(0x1000, 2);
    buf.writeUInt8(0x10, 4);
    buf.writeUInt32BE(0, 5);
    buf.writeUInt32BE(0xdeadbeef, 9);
    const d = DoipPayloadCodec.decode(PayloadType.ROUTING_ACTIVATION_RES, buf);
    expect(d.kind).toBe('routingActivationResponse');
    if (d.kind === 'routingActivationResponse') {
      expect(Array.from(d.value.reservedOem)).toEqual([0xde, 0xad, 0xbe, 0xef]);
    }
  });

  it('8 字节仍是非法（退化 unknown，不抛异常）', () => {
    const d = DoipPayloadCodec.decode(PayloadType.ROUTING_ACTIVATION_RES, Buffer.alloc(8, 0x00));
    expect(d.kind).toBe('unknown');
  });

  it('端到端：legacy 9 字节网关回 0x10 → 激活成功而不是超时', async () => {
    const peer = makeFakePeer({ routingCode: 0x10, legacy9ByteResponse: true });
    const session = makeSession(peer);
    const status = await session.connect(CFG);
    expect(status.state).toBe('ROUTING_ACTIVE');
    expect(status.lastRoutingCode).toBe(0x10);
    session.dispose();
  });
});

/* ═══════════════ #2 重复连接守门 ═══════════════ */

describe('#2 重复 connect 显式回错（审计 P0-2）', () => {
  it('已连接时第二次 connect → E_CONN_ALREADY_CONNECTED，原连接不受影响', async () => {
    const peer = makeFakePeer();
    const session = makeSession(peer);
    await session.connect(CFG);
    const err = await session.connect(CFG).then(() => null, (e: unknown) => e as Error & { code: string });
    expect(err?.code).toBe('E_CONN_ALREADY_CONNECTED');
    expect(session.status.state).toBe('ROUTING_ACTIVE');
    session.dispose();
  });
});

/* ═══════════════ #3 SA 取值时机 + activationType 生效 ═══════════════ */

describe('#3/#1 连接配置必须真实落到线路上（审计 P1-2 / P1-1）', () => {
  it('sa=0x0E01 时：0x8001 的 sourceAddress 与 0x0005 请求体都用新 SA/activationType', async () => {
    const peer = makeFakePeer();
    const session = makeSession(peer);
    await session.connect({ ...CFG, sa: '0x0E01', activationType: '0x01' });
    // 路由激活请求帧：byte[2] = activationType
    await vi.waitUntil(() => peer.clientFrames().some((f) => f.type === PayloadType.ROUTING_ACTIVATION_REQ), { timeout: 2000 });
    const req5 = peer.clientFrames().find((f) => f.type === PayloadType.ROUTING_ACTIVATION_REQ);
    expect(req5).toBeDefined();
    expect(req5?.payload.readUInt8(2)).toBe(0x01);
    peer.resetTx();

    await session.sendUds({ addressing: 'physical', sid: '0x22', dids: ['0xF190'], expectResponse: false });
    await vi.waitUntil(() => peer.clientFrames().some((f) => f.type === PayloadType.DIAGNOSTIC_MESSAGE), { timeout: 2000 });
    const diag = peer.clientFrames().find((f) => f.type === PayloadType.DIAGNOSTIC_MESSAGE);
    expect(diag).toBeDefined();
    // ★修复前：setAddresses 在 connect 之前执行 → 这里是旧默认 SA（0x0E00）
    expect(diag?.payload.readUInt16BE(0)).toBe(0x0e01);
    expect(diag?.payload.readUInt16BE(2)).toBe(0x1000);
    session.dispose();
  });
});

/* ═══════════════ #7 断开单一收尾出口 ═══════════════ */

describe('#7 断开幂等：不得再产 DISCONNECTED→CLOSED 非法迁移（审计 P1-6）', () => {
  it('disconnect 三次：状态恒为 DISCONNECTED、无非法迁移、错误计数不再增长', async () => {
    const peer = makeFakePeer();
    const errorCodes: string[] = [];
    const session = makeSession(peer, (code) => errorCodes.push(code));
    await session.connect(CFG);
    errorCodes.length = 0;

    session.disconnect('first');
    expect(session.status.state).toBe('DISCONNECTED');
    const errorsAfterFirst = session.status.counters.errors;
    session.disconnect('second');
    session.disconnect('third');
    expect(session.status.state).toBe('DISCONNECTED');
    expect(errorCodes).toEqual([]); // ★旧代码在这里会产 E_SESSION_INVALID_TRANSITION
    expect(session.status.counters.errors).toBe(errorsAfterFirst);
    session.dispose();
  });
});

/* ═══════════════ #4 危险操作后端门禁 ═══════════════ */

describe('#4 危险 SID 后端门禁（原始 hex 不得绕过）', () => {
  interface Call {
    req: SendUdsRequest;
  }
  function mkUdsService(): { svc: UdsService; calls: Call[] } {
    const calls: Call[] = [];
    const fakeConn = {
      sendUds: async (r: SendUdsRequest) => {
        calls.push({ req: r });
        return { ok: true, txnId: 't1', state: 'COMPLETED' };
      },
    } as unknown as ConnectionManager;
    return { svc: new UdsService(fakeConn), calls };
  }

  const deny = async (req: SendUdsRequest): Promise<void> => {
    const { svc, calls } = mkUdsService();
    const err = await svc.sendUdsRequest(req).then(() => null, (e: unknown) => e as Error & { code: string });
    expect(err?.code).toBe('E_UDS_CONFIRM_REQUIRED');
    expect(calls).toHaveLength(0); // 绝不能下发
  };
  const allow = async (req: SendUdsRequest): Promise<void> => {
    const { svc, calls } = mkUdsService();
    const res = await svc.sendUdsRequest(req);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
  };

  it('原始 hex 11 01（ECU 复位）未确认 → 拒绝（★不得绕过）', () => deny({ addressing: 'physical', rawHex: '11 01' }));
  it('原始 hex 27 02（发送密钥）未确认 → 拒绝', () => deny({ addressing: 'physical', rawHex: '27 02 aa bb' }));
  it('表单 0x14 清DTC → 拒绝', () => deny({ addressing: 'physical', sid: '0x14', dataHex: 'FF FF FF' }));
  it('表单 0x2E 写DID → 拒绝', () => deny({ addressing: 'physical', sid: '0x2E', dids: ['0xF190'], dataHex: '01' }));
  it('表单 0x31 例程 → 拒绝', () => deny({ addressing: 'physical', sid: '0x31', subFunction: '0x01' }));
  it('表单 0x11 复位 → 拒绝', () => deny({ addressing: 'physical', sid: '0x11', subFunction: '0x01' }));

  it('confirmed:true 放行复位', () => allow({ addressing: 'physical', rawHex: '11 01', confirmed: true }));
  it('confirmed:true 放行 27 偶数子功能', () => allow({ addressing: 'physical', rawHex: '27 02 aa bb', confirmed: true }));
  it('27 01 请求种子（奇数）无破坏性 → 直接放行', () => allow({ addressing: 'physical', rawHex: '27 01' }));
  it('22 读DID / 10 会话 / 3E → 全部放行', async () => {
    await allow({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
    await allow({ addressing: 'physical', sid: '0x10', subFunction: '0x03' });
    await allow({ addressing: 'physical', sid: '0x3e', subFunction: '0x00' });
  });
});

/* ═══════════════ #8 fire-and-forget 迟到 ACK ═══════════════ */

describe('#8 expectResponse=false 的迟到 0x8002 静默吞掉（审计 P1-5）', () => {
  const SA = 0x0e00;
  const TA = 0x1000;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  class FakeSender implements TxnSender {
    sendDiagnosticMessage(): void {
      /* 只需记录已发出 */
    }
  }

  function setup(): { txns: TransactionManager; events: TxnEvent[] } {
    const events: TxnEvent[] = [];
    const txns = new TransactionManager({
      sender: new FakeSender(),
      sa: SA,
      ta: TA,
      now: () => Date.now(),
      onEvent: (e) => events.push(e),
    });
    return { txns, events };
  }

  function ackFor(hex: string): DiagnosticMessageAckPayload {
    return { sourceAddress: TA, targetAddress: SA, ackCode: 0x00, previousMessage: parseHex(hex) };
  }

  const warnCodes = (events: TxnEvent[]): string[] =>
    events.filter((e) => e.kind === 'warn').map((e) => (e as { code: string }).code);

  it('已发不等响应的事务 ACK 到达 → 不再产 E_TXN_UNMATCHED_ACK', async () => {
    const { txns, events } = setup();
    await txns.send({ addressing: 'physical', sid: '0x3e', subFunction: '0x00', expectResponse: false });
    txns.onDiagnosticMessageAck(ackFor('3e00'), 1);
    expect(warnCodes(events)).toEqual([]);
    txns.dispose();
  });

  it('TTL 过期后同类 ACK 恢复告警（吞掉窗口有界）', async () => {
    const { txns, events } = setup();
    await txns.send({ addressing: 'physical', sid: '0x3e', subFunction: '0x00', expectResponse: false });
    vi.advanceTimersByTime(TIMING.FIRE_AND_FORGET_ACK_TTL_MS + 10);
    txns.onDiagnosticMessageAck(ackFor('3e00'), 1);
    expect(warnCodes(events)).toEqual(['E_TXN_UNMATCHED_ACK']);
    txns.dispose();
  });

  it('无关 ACK 依然告警（不得吞掉真实异常）', async () => {
    const { txns, events } = setup();
    txns.onDiagnosticMessageAck(ackFor('22f190'), 1);
    expect(warnCodes(events)).toEqual(['E_TXN_UNMATCHED_ACK']);
    txns.dispose();
  });

  it('fire-and-forget 的 0x8003 NACK 仍照常告警（投递失败必须可见）', async () => {
    const { txns, events } = setup();
    await txns.send({ addressing: 'physical', sid: '0x3e', subFunction: '0x00', expectResponse: false });
    txns.onDiagnosticMessageNack(
      { sourceAddress: TA, targetAddress: SA, nackCode: 0x01, previousMessage: parseHex('3e00') },
      1,
    );
    expect(warnCodes(events)).toContain('E_TXN_UNMATCHED_ACK');
    txns.dispose();
  });
});

/* ═══════════════ #9 被动监听公告并入结果 ═══════════════ */

describe('#9 scan(passive) 的 0x0004 公告必须进入结果（审计 P2）', () => {
  it('被动收到公告 → entities 含该节点且 partial=true；不开被动 → partial=false', async () => {
    const port = 13611;
    const vin = 'TESTAABBCCDDEEFF0';
    const announce = DoipHeaderCodec.buildFrame(
      0x02,
      PayloadType.VEHICLE_ANNOUNCEMENT,
      DoipPayloadCodec.encode({
        kind: 'vehicleAnnouncement',
        payloadType: PayloadType.VEHICLE_ANNOUNCEMENT,
        value: {
          vin,
          logicalAddress: 0x1000,
          eid: new Uint8Array([1, 2, 3, 4, 5, 6]),
          gid: new Uint8Array(6),
          furtherActionRequired: 0x00,
          vinGidSyncStatus: 0x00,
        },
      }),
    );

    const disc = new DoipUdpDiscovery({ port });
    const scanPromise = disc.scan({ passive: true, targetIp: '127.0.0.1', timeoutMs: 400, port });
    const sender = dgram.createSocket('udp4');
    sender.on('error', () => {
      /* localhost ICMP ECONNREFUSED 与本用例无关，忽略 */
    });
    await new Promise<void>((resolve) => {
      sender.bind(0, () => {
        sender.send(announce, port, '127.0.0.1', () => resolve());
      });
    });
    const result = await scanPromise;
    sender.close();

    const entity = result.entities.find((e) => e.vin === vin);
    expect(entity).toBeDefined();
    expect(entity?.nodeType).toBe('gateway');
    expect(result.partial).toBe(true); // ★被动监听窗口内结果必然可能不全

    disc.stopPassiveListen();
    disc.cancelPending();
  }, 10000);
});
