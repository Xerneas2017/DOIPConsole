/**
 * 仿真 ECU 的独立子进程入口（B11）。
 *
 * 由 SimEcuRuntime(isolatedProcess=true) 用 child_process.fork 拉起，
 * 内部以「同进程模式」运行 DoipEntityServer + DoipEntityUdp（真 socket）。
 * 好处：① Wireshark 可抓到独立进程流量；② 注入的崩溃不会带崩主进程。
 */

import { SimEcuRuntime } from './SimEcuRuntime';
import type { SimChildCommand, SimChildEvent } from './SimEcuRuntime';
import type { SimEntityConfig } from '@doip/shared';
import { getLogger } from '../logging/logger';

const log = getLogger('sim.child');
const runtime = new SimEcuRuntime();

function reply(event: SimChildEvent): void {
  process.send?.(event);
}

async function handleStart(cfg: {
  host: string;
  port: number;
  entities: SimEntityConfig[];
  announce: boolean;
}): Promise<void> {
  const { port } = await runtime.start({
    host: cfg.host,
    port: cfg.port,
    entities: cfg.entities,
    announce: cfg.announce,
    isolatedProcess: false, // 子进程内不再嵌套 fork
  });
  log.info('仿真子进程已启动', { port });
  reply({ type: 'started', port });
}

process.on('message', (msg: unknown) => {
  const cmd = msg as SimChildCommand;
  if (cmd === null || typeof cmd !== 'object' || typeof cmd.type !== 'string') return;
  switch (cmd.type) {
    case 'start':
      handleStart(cmd.cfg).catch((err: unknown) => {
        reply({ type: 'error', messageZh: err instanceof Error ? err.message : String(err) });
        process.exit(1);
      });
      return;
    case 'setFaultRules':
      runtime.setFaultRules(cmd.rules);
      return;
    case 'patchEntity':
      runtime.patchEntity(cmd.la, cmd.patch);
      return;
    case 'stop':
      runtime
        .stop()
        .then(() => {
          reply({ type: 'stopped' });
          process.exit(0);
        })
        .catch(() => process.exit(1));
      return;
    default:
      return;
  }
});

process.on('uncaughtException', (err: Error) => {
  log.error('仿真子进程未捕获异常', { message: err.message, stack: err.stack });
  reply({ type: 'error', messageZh: err.message });
});

process.on('unhandledRejection', (reason: unknown) => {
  log.error('仿真子进程未处理 Promise 拒绝', { reason: String(reason) });
  reply({ type: 'error', messageZh: String(reason) });
});

log.info('仿真子进程已就绪，等待启动指令');
