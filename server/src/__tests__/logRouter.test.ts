import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestRouter } from '../bridge/RequestRouter';
import type { RequestRouterDeps } from '../bridge/RequestRouter';
import { FileLogSink, setFileLogSink } from '../logging/fileLog';

/**
 * 运行日志（自我排查）的 WS 通路回归。
 *
 * 存在理由：工具出问题时（典型是"目标主动拒绝 TCP 连接"），用户必须能**在界面里**
 * 看到后端到底做了什么判断，而不是只知道一句 ECONNREFUSED。这里锁死三条：
 * ① `log.tail` 必须带回内容，且**包含刚发生、还没到刷盘时间的那几条**（否则用户
 *    打开日志看到的恰好缺掉原因那一行 —— 这是 RollingFileSink 踩过的同一个坑）；
 * ② `log.status` 只带状态、**不能清空已有内容**；
 * ③ 每条 `log.*` 都要回 ack，否则前端会一直等一个不会来的 ack。
 */

const dirs: string[] = [];

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'doip-logrouter-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  setFileLogSink(null);
  for (const d of dirs.splice(0, dirs.length)) rmSync(d, { recursive: true, force: true });
});

type Send = (type: string, payload: unknown) => void;

interface Sent {
  type: string;
  payload: unknown;
}

function makeRouter(sink: FileLogSink): { router: RequestRouter; sent: Sent[] } {
  // ★把进程单例指向测试 sink：RequestRouter 经 logger 写日志，logger 写的是单例
  setFileLogSink(sink);
  const sent: Sent[] = [];
  const noop = (): void => {
    /* stub */
  };
  const deps: RequestRouterDeps = {
    bus: { seqNow: 0, publishStatus: noop, publishError: noop } as never,
    store: { all: () => [], minSeq: 0, maxSeq: 0, clear: noop } as never,
    connections: {
      disconnect: async (): Promise<void> => undefined,
      setTesterPresent: noop,
      setTargetAddress: noop,
      statusOf: () => null,
      connect: async () => ({ state: 'ROUTING_ACTIVE', sessionId: 'default' }),
    } as never,
    sim: {
      start: async () => ({ port: 13401 }),
      stop: async () => undefined,
      getStatus: () => ({ running: false, port: null, entities: [], uptimeMs: 0, isolatedProcess: false }),
      setFaultRules: noop,
    } as never,
    sink: {
      getStatus: () => ({ state: 'stopped' }),
      stop: async () => ({ state: 'stopped' }),
      openDir: () => ({ ok: true, dir: '/tmp/x' }),
    } as never,
    resync: { handleHello: () => ({ mode: 'first' }) } as never,
    library: { get: () => ({}) } as never,
    registry: { listForLevel: () => [], get: () => undefined } as never,
    engine: {} as never,
    security: { resolveId: () => 'x' } as never,
    uds: { sendUdsRequest: async () => ({ ok: true, txnId: 'tx-1', state: 'COMPLETED' }) } as never,
    serverVersion: 'test',
    broadcast: (t: string, p: unknown) => sent.push({ type: t, payload: p }),
    getStatus: () => null,
    getVectors: () => ({ vectors: [], bindings: {} }) as never,
    logSink: sink,
  };
  return { router: new RequestRouter(deps), sent };
}

async function handle(router: RequestRouter, cmd: unknown, sent: Sent[]): Promise<void> {
  // ★必须记录 send 通道：log.info / cmd.ack 都是走它下发的（broadcast 只发服务端事件）
  (router as unknown as { handle(text: string, send: Send): void }).handle(
    JSON.stringify(cmd),
    (type, payload) => {
      sent.push({ type, payload });
    },
  );
}


/**
 * 有界轮询日志，直到出现目标片段。
 *
 * 必要性：`RequestRouter.handle` 是同步方法，连接失败发生在它返回之后的微任务里。
 * 直接断言会"太早"——只看到"收到连接请求"，看不到后面的诊断。
 */
async function waitForLog(sink: FileLogSink, needle: string, timeoutMs = 2000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = (await sink.tail(200)).lines.join('\n');
    if (text.includes(needle)) return text;
    await new Promise((r) => setTimeout(r, 20));
  }
  return text;
}


/**
 * 有界等待某个下行事件出现。
 *
 * 必要性：`handle` 是同步方法，而 `log.tail` 是异步处理（要先等持久化屏障），
 * 因此 `log.info` 与 `cmd.ack` 都会在 handle 返回之后才发出。
 * 直接断言会"太早"，误判成"指令没反应"——这正是当年 D-06 那类问题的形态。
 */
async function waitForSent(sent: Sent[], pred: (s: Sent) => boolean, timeoutMs = 2000): Promise<Sent | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = sent.find(pred);
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  return sent.find(pred);
}

describe('TC-LG05 运行日志 WS 通路', () => {
  it('★log.tail 带回刚写入、尚未到刷盘时间的日志行', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    const { router, sent } = makeRouter(sink);
    // 一条刚落进内存缓冲、尚未定时刷盘的日志（模拟"刚发生的失败原因"）
    sink.write('{"level":"error","mod":"bridge.router","msg":"连接失败","diagnosis":"仿真 ECU 尚未启动"}');

    await handle(router, { type: 'log.tail', id: 'c001', payload: { lines: 100 } }, sent);

    const info = await waitForSent(sent, (x) => x.type === 'log.info');
    expect(info).toBeDefined();
    const p = info?.payload as { status: { dir: string }; lines: string[]; truncated?: boolean };
    expect(p.status.dir).toBe(root);
    expect(p.lines.join('\n')).toContain('仿真 ECU 尚未启动');
    await sink.dispose();
  });

  it('log.status 只回状态，不带 lines（避免前端清空已显示内容）', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    const { router, sent } = makeRouter(sink);
    sink.write('{"msg":"x"}');
    await handle(router, { type: 'log.status', id: 'c002', payload: {} }, sent);

    const info = await waitForSent(sent, (x) => x.type === 'log.info');
    const p = info?.payload as { status: unknown; lines?: string[] };
    expect(p.status).toBeDefined();
    expect(p.lines).toBeUndefined();
    await sink.dispose();
  });

  it('★每条 log.* 都必须回 cmd.ack（否则前端一直等）', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    const { router } = makeRouter(sink);
    const acks: string[] = [];
    const routerAny = router as unknown as {
      handle(text: string, send: Send): void;
    };
    const send = (t: string, p: unknown): void => {
      if (t === 'cmd.ack') acks.push((p as { id: string }).id);
    };
    routerAny.handle(JSON.stringify({ type: 'log.status', id: 'c010', payload: {} }), send);
    routerAny.handle(JSON.stringify({ type: 'log.tail', id: 'c011', payload: { lines: 10 } }), send);
    routerAny.handle(JSON.stringify({ type: 'log.openDir', id: 'c012', payload: {} }), send);
    // log.tail 的 ack 是异步发出的，等它出现再断言
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && acks.length < 3) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // 只要求"每条指令都拿到 ack"，不要求顺序：log.tail 是异步处理、
    // log.status / log.openDir 是同步处理，ack 到达顺序本来就不保证。
    expect([...acks].sort()).toEqual(['c010', 'c011', 'c012']);
    await sink.dispose();
  });

  it('log.tail 请求超大行数被夹紧，不会试图读回无限数据', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    const { router, sent } = makeRouter(sink);
    for (let i = 0; i < 30; i += 1) sink.write(`{"i":${i}}`);
    await handle(router, { type: 'log.tail', id: 'c003', payload: { lines: 9_999_999 } }, sent);
    const p = (await waitForSent(sent, (x) => x.type === 'log.info'))?.payload as { lines: string[] };
    expect(p.lines.length).toBeLessThanOrEqual(5000);
    await sink.dispose();
  });
});

describe('TC-LG06 连接失败必须留下可排查的诊断', () => {
  it('★仿真模式下连接被拒 → 日志明确指出"仿真 ECU 尚未启动"', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    setFileLogSink(sink);
    const sent: Sent[] = [];
    const noop = (): void => {
      /* stub */
    };
    const deps: RequestRouterDeps = {
      bus: { seqNow: 0, publishStatus: noop, publishError: noop } as never,
      store: { all: () => [], minSeq: 0, maxSeq: 0, clear: noop } as never,
      connections: {
        connect: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:13401'), { code: 'ECONNREFUSED' });
        },
      } as never,
      sim: {
        getStatus: () => ({ running: false, port: null, entities: [], uptimeMs: 0, isolatedProcess: false }),
      } as never,
      sink: {} as never,
      resync: {} as never,
      library: {} as never,
      registry: {} as never,
      engine: {} as never,
      security: {} as never,
      uds: {} as never,
      serverVersion: 'test',
      broadcast: (t: string, p: unknown) => sent.push({ type: t, payload: p }),
      getStatus: () => null,
      getVectors: () => ({ vectors: [], bindings: {} }) as never,
      logSink: sink,
    };
    const router = new RequestRouter(deps);
    // handle 是同步方法；内部已把异常转成 error 事件，这里只要求它不抛
    expect(() =>
      (router as unknown as { handle(text: string, send: Send): void }).handle(
        JSON.stringify({
          type: 'connect.request',
          id: 'c020',
          payload: { mode: 'sim', host: '127.0.0.1', port: 13401, sa: '0x0E00', ta: '0x1000' },
        }),
        () => undefined,
      ),
    ).not.toThrow();

    const text = await waitForLog(sink, '连接失败');
    expect(text).toContain('连接失败');
    expect(text).toContain('仿真 ECU 尚未启动');
    expect(text).toContain('simRunning'); // 意图与仿真状态必须同时留痕，否则无法对照
    await sink.dispose();
  });

  it('★端口不一致时，诊断给出"改成仿真实际端口"的具体结论', async () => {
    const root = mkTmp();
    const sink = new FileLogSink({ rootDir: root });
    setFileLogSink(sink);
    const noop = (): void => {
      /* stub */
    };
    const deps: RequestRouterDeps = {
      bus: { seqNow: 0, publishStatus: noop, publishError: noop } as never,
      store: {} as never,
      connections: {
        connect: async () => {
          throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        },
      } as never,
      // 仿真在跑，但实际在 13402，而界面填的是 13401
      sim: {
        getStatus: () => ({ running: true, port: 13402, entities: [], uptimeMs: 1, isolatedProcess: false }),
      } as never,
      sink: {} as never,
      resync: {} as never,
      library: {} as never,
      registry: {} as never,
      engine: {} as never,
      security: {} as never,
      uds: {} as never,
      serverVersion: 'test',
      broadcast: () => undefined,
      getStatus: () => null,
      getVectors: () => ({ vectors: [], bindings: {} }) as never,
      logSink: sink,
    };
    const router = new RequestRouter(deps);
    (router as unknown as { handle(text: string, send: Send): void }).handle(
      JSON.stringify({
        type: 'connect.request',
        id: 'c021',
        payload: { mode: 'sim', host: '127.0.0.1', port: 13401, sa: '0x0E00', ta: '0x1000' },
      }),
      () => undefined,
    );
    const text = await waitForLog(sink, '端口不一致');
    expect(text).toContain('端口不一致');
    expect(text).toContain('13402');
    await sink.dispose();
  });
});
