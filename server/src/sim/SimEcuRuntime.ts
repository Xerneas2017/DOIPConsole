/**
 * 仿真运行时（§3.10 / B11）：启停、端口分配、实体注册、故障注入、（可选）子进程隔离。
 *
 * ★B11：isolatedProcess=true 时用 child_process.fork 隔离运行，
 *   这样仿真侧的注入故障（如 dropConnection 风暴）不会带崩主进程。
 *   P0 就把这条通道打通（成本很低），故障时可一键切换。
 */

import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { BIND_HOST, PORTS, nowMonoMs } from '@doip/shared';
import type { FaultRule, SimEntityConfig, SimStatus } from '@doip/shared';
import { AppError } from '../errors/AppError';
import { getLogger } from '../logging/logger';
import { getTiming } from '../config/defaults';
import { DoipEntityServer } from '../sim/DoipEntityServer';
import { DoipEntityUdp } from '../sim/DoipEntityUdp';
import { FaultInjector } from '../sim/FaultInjector';
import { cloneDefaultSimEntities } from '../sim/simPresets';

export interface SimStartConfig {
  port?: number;
  entities?: SimEntityConfig[];
  /** B11：是否用独立子进程运行仿真（默认 false） */
  isolatedProcess?: boolean;
  host?: string;
  /** 是否发 UDP 公告（默认 true） */
  announce?: boolean;
}

/** 父 → 子（isolatedProcess 模式） */
export type SimChildCommand =
  | { type: 'start'; cfg: { host: string; port: number; entities: SimEntityConfig[]; announce: boolean } }
  | { type: 'setFaultRules'; rules: FaultRule[] }
  | { type: 'patchEntity'; la: string; patch: Partial<SimEntityConfig> }
  | { type: 'stop' };

/** 子 → 父 */
export type SimChildEvent =
  | { type: 'started'; port: number }
  | { type: 'stopped' }
  | { type: 'error'; messageZh: string };

export class SimEcuRuntime {
  private readonly log = getLogger('sim');
  private readonly injector = new FaultInjector();
  private entities: SimEntityConfig[] = cloneDefaultSimEntities();
  private tcp: DoipEntityServer | null = null;
  private udp: DoipEntityUdp | null = null;
  private child: ChildProcess | null = null;
  private running = false;
  private isolated = false;
  private port: number | null = null;
  private startedAtMs = 0;

  getStatus(): SimStatus {
    return {
      running: this.running,
      port: this.port,
      entities: this.entities,
      uptimeMs: this.running ? nowMonoMs() - this.startedAtMs : 0,
      isolatedProcess: this.isolated,
    };
  }

  getEntities(): SimEntityConfig[] {
    return this.entities;
  }

  getInjector(): FaultInjector {
    return this.injector;
  }

  /** 启动；返回实际监听端口（端口被占用时自动顺延 13402..13410） */
  async start(cfg: SimStartConfig = {}): Promise<{ port: number }> {
    if (this.running) return { port: this.port ?? 0 };
    if (cfg.entities !== undefined && cfg.entities.length > 0) this.entities = cfg.entities;
    const host = cfg.host ?? BIND_HOST;
    const announce = cfg.announce ?? true;

    if (cfg.isolatedProcess === true) {
      const port = await this.startIsolated(host, cfg.port ?? PORTS.SIM_DEFAULT_TCP_UDP, announce);
      this.running = true;
      this.isolated = true;
      this.port = port;
      this.startedAtMs = nowMonoMs();
      return { port };
    }

    const port = await this.startInProcess(host, cfg.port ?? PORTS.SIM_DEFAULT_TCP_UDP, announce);
    this.running = true;
    this.isolated = false;
    this.port = port;
    this.startedAtMs = nowMonoMs();
    return { port };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    if (this.child !== null) {
      const child = this.child;
      this.child = null;
      child.send({ type: 'stop' } satisfies SimChildCommand);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, getTiming('SIM_STOP_DRAIN_MS'));
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } else {
      await this.stopInProcess();
    }
    this.running = false;
    this.port = null;
    this.log.info('仿真 ECU 已停止');
  }

  setFaultRules(rules: FaultRule[]): void {
    if (this.child !== null) {
      this.child.send({ type: 'setFaultRules', rules } satisfies SimChildCommand);
      return;
    }
    this.injector.setRules(rules);
    this.tcp?.setFaultRules(rules);
  }

  patchEntity(la: string, patch: Partial<SimEntityConfig>): void {
    if (this.child !== null) {
      this.child.send({ type: 'patchEntity', la, patch } satisfies SimChildCommand);
      return;
    }
    this.tcp?.patchEntity(la, patch);
  }

  /* ─────────────── 同进程模式 ─────────────── */

  private async startInProcess(host: string, preferredPort: number, announce: boolean): Promise<number> {
    const candidates = [preferredPort, ...PORTS.SIM_PORT_FALLBACK_RANGE];
    let lastError: unknown = null;
    for (const candidate of candidates) {
      const tcp = new DoipEntityServer({
        host,
        port: candidate,
        entities: this.entities,
        injector: this.injector,
      });
      const udp = new DoipEntityUdp({
        host,
        port: candidate,
        entities: this.entities,
        // 0x4002 实体状态响应里的 currentlyOpenSockets 取真实值，不要糊一个 0
        openSocketCount: () => tcp.connectionCount,
      });
      try {
        const tcpPort = await tcp.start();
        try {
          await udp.start();
        } catch (udpErr) {
          // TCP/UDP 必须同端口（DoIP 要求），UDP 失败则整体顺延
          await tcp.stop();
          throw udpErr;
        }
        this.tcp = tcp;
        this.udp = udp;
        if (announce) udp.announce();
        this.log.info('仿真 ECU 启动完成', { host, port: tcpPort, entities: this.entities.length });
        return tcpPort;
      } catch (err) {
        lastError = err;
        this.log.warn('仿真端口不可用，顺延下一个', {
          port: candidate,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    throw new AppError('E_SIM_START_FAILED', `仿真 ECU 启动失败：候选端口均不可用`, {
      detail: { candidates, message: lastError instanceof Error ? lastError.message : String(lastError) },
    });
  }

  private async stopInProcess(): Promise<void> {
    const udp = this.udp;
    const tcp = this.tcp;
    this.udp = null;
    this.tcp = null;
    if (udp !== null) await udp.stop();
    if (tcp !== null) await tcp.stop();
  }

  /* ─────────────── 子进程隔离模式（B11） ─────────────── */

  private async startIsolated(host: string, preferredPort: number, announce: boolean): Promise<number> {
    const childPath = resolveChildPath();
    const child = fork(childPath, [], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: process.env,
    });
    this.child = child;
    child.on('message', (msg: unknown) => {
      const event = msg as SimChildEvent;
      if (event?.type === 'error') {
        this.log.error('仿真子进程错误', { messageZh: event.messageZh });
      }
    });
    child.on('exit', (code: number | null) => {
      this.log.warn('仿真子进程退出', { code });
      this.running = false;
      this.port = null;
      this.child = null;
    });

    return new Promise<number>((resolve, reject) => {
      const timeoutMs = getTiming('SIM_CHILD_START_TIMEOUT_MS');
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        this.child = null;
        reject(new AppError('E_SIM_START_FAILED', `仿真子进程在 ${timeoutMs}ms 内未就绪`));
      }, timeoutMs);
      const onMessage = (msg: unknown): void => {
        const event = msg as SimChildEvent;
        if (event?.type === 'started') {
          clearTimeout(timer);
          child.off('message', onMessage);
          this.log.info('仿真子进程已就绪', { port: event.port });
          resolve(event.port);
        }
      };
      child.on('message', onMessage);
      child.send({ type: 'start', cfg: { host, port: preferredPort, entities: this.entities, announce } } satisfies SimChildCommand);
    });
  }
}

/** 子进程入口路径：与当前模块同目录、同扩展名（tsx 直跑或 tsc 产出都成立） */
function resolveChildPath(): string {
  const self = fileURLToPath(import.meta.url);
  return self.replace(/SimEcuRuntime\.(ts|js|mjs|cjs)$/, 'simChildProcess.$1');
}
