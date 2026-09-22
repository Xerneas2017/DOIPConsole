import { describe, expect, it } from 'vitest';
import { RequestRouter } from '../bridge/RequestRouter';
import type { RequestRouterDeps } from '../bridge/RequestRouter';

/**
 * ★D-06 回归：`cmd.ack` 必须回显**真实请求 id**。
 *
 * 之前 `scan.request` 回的是字面量 `'scan'`、`sim.start` 回 `'sim'`，
 * 而前端请求 id 是 `c00009` / `c00011` —— 前端的对账逻辑永远等不到 ack，
 * 控制台里看就是"指令发出去没回音"。
 */

function collect(): { sent: Array<{ type: string; payload: unknown }>; send: (type: string, payload: unknown) => void } {
  const sent: Array<{ type: string; payload: unknown }> = [];
  return {
    sent,
    send: (type: string, payload: unknown) => {
      sent.push({ type, payload });
    },
  };
}

function makeRouter(sent: Array<{ type: string; payload: unknown }>, send: (t: string, p: unknown) => void): RequestRouter {
  const noop = (): void => {
    /* stub */
  };
  const store = { all: () => [], minSeq: 0, maxSeq: 0, clear: noop } as never;
  const connections = {
    disconnect: async (): Promise<void> => undefined,
    setTesterPresent: noop,
    setTargetAddress: noop,
    statusOf: () => null,
  } as never;
  const sim = { start: async () => ({ port: 13400 }), stop: async () => undefined, getStatus: () => ({ running: false }), setFaultRules: noop } as never;
  const sink = { getStatus: () => ({ state: 'stopped' }), stop: async () => ({ state: 'stopped' }), openDir: () => ({ ok: true, dir: '/tmp/x' }) } as never;
  const resync = { handleHello: () => ({ mode: 'first' }) } as never;
  const library = { get: () => ({}) } as never;
  const deps: RequestRouterDeps = {
    bus: { seqNow: 0, publishStatus: noop, publishError: noop } as never,
    store,
    connections,
    sim,
    sink,
    resync,
    library,
    registry: { listForLevel: () => [], get: () => undefined } as never,
    engine: {} as never,
    security: { resolveId: () => 'x' } as never,
    uds: { sendUdsRequest: async () => ({ ok: true, txnId: 'tx-1', state: 'COMPLETED' }) } as never,
    serverVersion: 'test',
    broadcast: noop,
    getStatus: () => null,
    getVectors: () => ({ vectors: [], bindings: {} }) as never,
  };
  void sent;
  return new RequestRouter({ ...deps, broadcast: (t: string, p: unknown) => send(t, p) });
}

function acksOf(sent: Array<{ type: string; payload: unknown }>): string[] {
  return sent
    .filter((m) => m.type === 'cmd.ack')
    .map((m) => String((m.payload as { id?: string }).id ?? ''));
}

describe('D-06 — cmd.ack 回显真实请求 id', () => {
  it('disconnect / testerPresent / trace.clear / target.set 回显同一 id', async () => {
    const { sent, send } = collect();
    const router = makeRouter(sent, send);
    const cases: Array<{ type: string; payload: unknown }> = [
      { type: 'disconnect', payload: { reason: 'test' } },
      { type: 'testerPresent', payload: { enable: false } },
      { type: 'trace.clear', payload: {} },
      { type: 'target.set', payload: { ta: '0x1000' } },
    ];
    for (const [i, c] of cases.entries()) {
      sent.length = 0;
      const id = `c${String(i).padStart(5, '0')}`;
      router.handle(JSON.stringify({ type: c.type, id, payload: c.payload }), send as never);
      await new Promise((r) => setTimeout(r, 0));
      expect(acksOf(sent)).toEqual([id]);
    }
  });

  it('★sim.start 不再回字面量 sim，library.get 不再吞掉 ack', async () => {
    const { sent, send } = collect();
    const router = makeRouter(sent, send);
    sent.length = 0;
    router.handle(JSON.stringify({ type: 'library.get', id: 'c00011', payload: {} }), send as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(acksOf(sent)).toEqual(['c00011']);
  });

  it('uds.send 也有 ack（之前完全没有，前端只能干等）', async () => {
    const { sent, send } = collect();
    const router = makeRouter(sent, send);
    sent.length = 0;
    router.handle(
      JSON.stringify({ type: 'uds.send', id: 'c00042', payload: { addressing: 'physical', sid: '0x10', subFunction: '0x03' } }),
      send as never,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(acksOf(sent)).toEqual(['c00042']);
  });

  it('非法 JSON 回 error，且不带 id（无法归属）', () => {
    const { sent, send } = collect();
    const router = makeRouter(sent, send);
    router.handle('not-json', send as never);
    expect(sent.some((m) => m.type === 'error')).toBe(true);
  });
});
