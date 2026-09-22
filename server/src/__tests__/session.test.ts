/**
 * T05 会话层单测（§9.1）：状态机拦截、3E 周期与 S3 倒计时、UDS 会话追踪、
 * 以及 ★「断开后无悬挂 timer、进程可自行退出」的验收。
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIND_HOST } from '@doip/shared';
import type { TraceEntry } from '@doip/shared';
import { SessionStateMachine } from '../session/SessionStateMachine';
import { TesterPresentScheduler } from '../session/TesterPresentScheduler';
import { UdsSessionTracker } from '../session/UdsSessionTracker';
import { ConnectionManager } from '../session/ConnectionManager';
import { SimEcuRuntime } from '../sim/SimEcuRuntime';

const TEST_PORT = 13492;
const SA = 0x0e00;
const GATEWAY = 0x1000;

/* ═══════════════ ① SessionStateMachine ═══════════════ */

describe('SessionStateMachine', () => {
  it('合法迁移被接受，非法迁移被拦截并上报 E_SESSION_INVALID_TRANSITION', () => {
    const errors: string[] = [];
    const changes: Array<{ from: string; to: string; accepted: boolean }> = [];
    const sm = new SessionStateMachine({
      onChange: (r) => changes.push({ from: r.from, to: r.to, accepted: r.accepted }),
      onError: (e) => errors.push(e.code),
    });

    expect(sm.state).toBe('DISCONNECTED');
    // 非法：DISCONNECTED → ROUTING_ACTIVE（必须先 TCP_CONNECTING）
    expect(sm.transition('ROUTING_ACTIVE')).toBe(false);
    expect(sm.state).toBe('DISCONNECTED');
    expect(errors).toEqual(['E_SESSION_INVALID_TRANSITION']);
    expect(changes.at(-1)?.accepted).toBe(false);

    // 合法链路
    expect(sm.transition('TCP_CONNECTING')).toBe(true);
    expect(sm.transition('TCP_CONNECTED')).toBe(true);
    expect(sm.transition('ROUTING_ACTIVATING')).toBe(true);
    expect(sm.transition('ROUTING_ACTIVE')).toBe(true);
    expect(sm.state).toBe('ROUTING_ACTIVE');

    // 停留在原态合法（0x11 场景），不重复记录
    expect(sm.transition('ROUTING_ACTIVATING')).toBe(true);
    expect(sm.transition('ROUTING_ACTIVE')).toBe(true);
    expect(sm.state).toBe('ROUTING_ACTIVE');
    expect(errors).toHaveLength(1);
  });

  it('CLOSED 只能回到 DISCONNECTED', () => {
    const sm = new SessionStateMachine({ initial: 'ROUTING_ACTIVE' });
    expect(sm.transition('CLOSING')).toBe(true);
    expect(sm.transition('CLOSED')).toBe(true);
    expect(sm.transition('TCP_CONNECTING')).toBe(false);
    expect(sm.transition('DISCONNECTED')).toBe(true);
    expect(sm.state).toBe('DISCONNECTED');
  });
});

/* ═══════════════ ② UdsSessionTracker（只由 Trace 事实驱动） ═══════════════ */

describe('UdsSessionTracker', () => {
  it('10 03 正响应 → EXTENDED；7F 10 xx 负响应 → 保持不变', () => {
    const t = new UdsSessionTracker();
    expect(t.session).toBe('DEFAULT');
    t.observeRequest(0x10, 0x03);
    t.observePositiveResponse(0x50, 0x03);
    expect(t.session).toBe('EXTENDED');

    t.observeNegativeResponse(0x10);
    expect(t.session).toBe('EXTENDED'); // ★负响应不改变会话
  });

  it('27 01 取种子 + 67 02 正响应 → 解锁等级 [1]；负响应则不加', () => {
    const t = new UdsSessionTracker();
    t.observeRequest(0x27, 0x01);
    t.observePositiveResponse(0x67, 0x01); // 种子响应，非密钥接受
    expect(t.securityLevels).toEqual([]);
    t.observeRequest(0x27, 0x02);
    t.observePositiveResponse(0x67, 0x02);
    expect(t.securityLevels).toEqual([1]);

    const t2 = new UdsSessionTracker();
    t2.observeRequest(0x27, 0x01);
    t2.observeNegativeResponse(0x27);
    t2.observeRequest(0x27, 0x02);
    t2.observePositiveResponse(0x67, 0x02);
    expect(t2.securityLevels).toEqual([]);
  });

  it('断开/复位 → 回 DEFAULT 且清空解锁等级', () => {
    const t = new UdsSessionTracker();
    t.observeRequest(0x10, 0x03);
    t.observePositiveResponse(0x50, 0x03);
    t.observeRequest(0x27, 0x01);
    t.observePositiveResponse(0x67, 0x01);
    t.observeRequest(0x27, 0x02);
    t.observePositiveResponse(0x67, 0x02);
    expect(t.securityLevels).toEqual([1]);
    t.reset('disconnected');
    expect(t.session).toBe('DEFAULT');
    expect(t.securityLevels).toEqual([]);
  });
});

/* ═══════════════ ③ TesterPresentScheduler ═══════════════ */

describe('TesterPresentScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('周期 = min(配置周期, S3 × 0.6)，并被 MIN/MAX 夹紧', () => {
    const scheduler = new TesterPresentScheduler({ send: () => true, s3ServerMs: 5000 });
    // min(2000, 5000*0.6=3000) = 2000
    scheduler.start(2000);
    expect(scheduler.periodMs).toBe(2000);
    // S3 很短时按安全因子收紧：min(2000, 1000*0.6=600) = 600
    scheduler.setS3ServerMs(1000);
    expect(scheduler.periodMs).toBe(600);
    scheduler.stop();
  });

  it('按周期发送 3E，stop 后不再发送', async () => {
    let sent = 0;
    const scheduler = new TesterPresentScheduler({
      send: () => {
        sent += 1;
        return true;
      },
      s3ServerMs: 5000,
      now: () => Date.now(),
    });
    scheduler.start(1000);
    expect(scheduler.enabled).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toBe(2);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toBe(2);
    expect(scheduler.nextDueMs).toBeNull();
  });

  it('S3 倒计时随活动刷新；★stop/dispose 后无悬挂 timer', async () => {
    const scheduler = new TesterPresentScheduler({ send: () => true, s3ServerMs: 5000, now: () => Date.now() });
    scheduler.start(2000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scheduler.getS3RemainingMs()).toBe(4000);
    scheduler.notifyActivity();
    expect(scheduler.getS3RemainingMs()).toBe(5000);

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/* ═══════════════ ④ ConnectionManager 端到端（真 socket 仿真） ═══════════════ */

describe('ConnectionManager 端到端（仿真 ECU 真 socket）', () => {
  let sim: SimEcuRuntime;
  let port = TEST_PORT;
  const frames: TraceEntry[] = [];
  let localSeq = 0;

  beforeAll(async () => {
    sim = new SimEcuRuntime();
    const started = await sim.start({ port: TEST_PORT });
    port = started.port;
  }, 30000);

  afterAll(async () => {
    await sim.stop();
  }, 30000);

  it('连接 → 路由激活 → 10 03 → UDS 会话切到 EXTENDED', async () => {
    const mgr = new ConnectionManager({
      onFrame: (_frame, _ctx) => {
        // 模拟 Trace 出口：返回该帧的实际 seq（生产环境由 EventBus.publishTrace 分配）
        localSeq += 1;
        frames.push({ seq: localSeq } as unknown as TraceEntry);
        return localSeq;
      },
    });
    try {
      const status = await mgr.connect({
        mode: 'sim',
        host: BIND_HOST,
        port,
        sa: '0x0E00',
        ta: '0x1000',
      });
      expect(status.state).toBe('ROUTING_ACTIVE');
      expect(status.lastRoutingCode).toBe(0x10);
      expect(status.sa).toBe(SA);
      expect(status.ta).toBe(GATEWAY);

      const res = await mgr.sendUds({ addressing: 'physical', sid: '0x10', subFunction: '0x03' });
      expect(res.ok).toBe(true);
      expect(res.responseHex).toBe('50 03 00 32 01 F4');
      const after = mgr.statusOf();
      expect(after?.udsSession).toBe('EXTENDED');
      expect(after?.counters.tx).toBeGreaterThan(0);

      // ★Q4：切 TA 不重建连接
      mgr.setTargetAddress(0x1010);
      expect(mgr.statusOf()?.ta).toBe(0x1010);
      const still = mgr.statusOf();
      expect(still?.state).toBe('ROUTING_ACTIVE');
      const res2 = await mgr.sendUds({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
      expect(res2.ok).toBe(true);

      mgr.disconnect('test-end');
      expect(mgr.statusOf()?.state).toBe('DISCONNECTED');
    } finally {
      mgr.dispose();
    }
    expect(frames.length).toBeGreaterThan(0);
  }, 30000);

  it('★seq 不断号：一帧只分配一个号，事务记录引用真实 Trace 条目', async () => {
    let seq = 0;
    const seqs: number[] = [];
    const mgr = new ConnectionManager({
      // 模拟 EventBus：帧发布时分配 seq，并把真实值回传给会话层
      onFrame: () => {
        seq += 1;
        seqs.push(seq);
        return seq;
      },
    });
    try {
      await mgr.connect({ mode: 'sim', host: BIND_HOST, port, sa: '0x0E00', ta: '0x1000' });
      const res = await mgr.sendUds({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
      expect(res.ok).toBe(true);

      // ① 号段连续：每个帧恰好消耗一个号
      expect(seqs.length).toBeGreaterThan(3);
      expect(seqs.every((s, i) => s === i + 1)).toBe(true);

      // ② 事务记录引用的是真实 Trace 条目 seq（不再是另一套计数）
      const txn = mgr.get()?.txns.listCompleted().at(-1);
      expect(txn).toBeDefined();
      expect(txn?.seqRequest).not.toBeNull();
      expect(seqs).toContain(txn?.seqRequest ?? -1);
      expect(txn?.seqAck).not.toBeNull();
      expect(seqs).toContain(txn?.seqAck ?? -1);
      for (const s of txn?.seqResponses ?? []) expect(seqs).toContain(s);
    } finally {
      mgr.disconnect('seq-test-end');
      mgr.dispose();
    }
  }, 30000);

  it('★断开后无悬挂 timer 与 socket，进程可自行退出（不需要强制 exit）', async () => {
    // 用一个独立子进程跑"连接→断开"，断言它能自然退出（退出码 0 且未被超时杀掉）
    const dir = mkdtempSync(join(tmpdir(), 'doip-noleak-'));
    const scriptPath = join(dir, 'no-leak.mts');
    // 从测试文件位置反推仓库根，避免依赖 vitest 的 cwd
    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const simPath = join(repoRoot, 'server/src/sim/SimEcuRuntime.ts');
    const mgrPath = join(repoRoot, 'server/src/session/ConnectionManager.ts');
    writeFileSync(
      scriptPath,
      `
import { SimEcuRuntime } from '${simPath}';
import { ConnectionManager } from '${mgrPath}';
const sim = new SimEcuRuntime();
const { port } = await sim.start({ port: ${TEST_PORT + 1} });
const mgr = new ConnectionManager({});
await mgr.connect({ mode: 'sim', host: '${BIND_HOST}', port, sa: '0x0E00', ta: '0x1000' });
await mgr.sendUds({ addressing: 'physical', sid: '0x10', subFunction: '0x03' });
mgr.disconnect('no-leak-end');
mgr.dispose();
await sim.stop();
process.exitCode = 0;
`,
      'utf8',
    );

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
        cwd: repoRoot,
        stdio: 'ignore',
        env: { ...process.env, DOIP_LOG_LEVEL: 'error' },
      });
      // 若存在句柄/定时器泄漏，进程会挂住 → 5s 后被判定为泄漏
      const killer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(-1);
      }, 15000);
      child.on('exit', (code) => {
        clearTimeout(killer);
        resolve(typeof code === 'number' ? code : -2);
      });
    });
    expect(exitCode).toBe(0);
  }, 40000);

  it('未连接时发送 → E_CONN_NOT_CONNECTED（★不自动重连）', async () => {
    const mgr = new ConnectionManager();
    try {
      await expect(mgr.sendUds({ addressing: 'physical', sid: '0x3E', subFunction: '0x80' })).rejects.toThrow();
    } finally {
      mgr.dispose();
    }
  });
});
