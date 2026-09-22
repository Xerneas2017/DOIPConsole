#!/usr/bin/env node
/**
 * QA 资源泄漏探针（不修改任何实现源码）。
 *
 * 目的：判定 smoke.mjs 收尾打印的 `PipeWrap / TCPServerWrap / UDPWrap / TCPSocketWrap / ProcessWrap`
 *      到底是"打印时刻尚未清理完"，还是**真实句柄泄漏**。
 *
 * 判据：本脚本跑完完整生命周期后**不调用 process.exit()**。
 *      - 若能自行退出 → 只是清理时序问题；
 *      - 若挂住 → 真实泄漏（外层用 `timeout` 包一层，退出码 124 即为挂住）。
 *
 * 用法：timeout 25 node scripts/qa-exit-probe.mjs ; echo "exit=$?"
 */

import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SELF = fileURLToPath(import.meta.url);

if (process.env['DOIP_QA_PROBE_BOOTSTRAPPED'] !== '1') {
  const res = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
    stdio: 'inherit',
    env: { ...process.env, DOIP_QA_PROBE_BOOTSTRAPPED: '1' },
  });
  process.exit(typeof res.status === 'number' ? res.status : 1);
}

const { SimEcuRuntime } = await import('../server/src/sim/SimEcuRuntime.ts');
const { DoipClient } = await import('../server/src/doip/DoipClient.ts');
const { TransactionManager } = await import('../server/src/txn/TransactionManager.ts');
const { BIND_HOST, DOIP_DEFAULTS, PORTS } = await import('@doip/shared');

const SA = DOIP_DEFAULTS.TESTER_LOGICAL_ADDRESS;
const GATEWAY_LA = 0x1000;

function dump(tag) {
  const info = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
  const counts = {};
  for (const r of info) counts[r] = (counts[r] ?? 0) + 1;
  console.log(`[${tag}] 活动资源 ${info.length} 个:`, JSON.stringify(counts));
  return counts;
}

async function main() {
  console.log('=== QA 资源泄漏探针：跑完不调 process.exit()，看能否自行退出 ===\n');
  dump('baseline');

  /* ① 同进程模式 */
  console.log('\n--- ① 同进程仿真 ---');
  const runtime = new SimEcuRuntime();
  const { port } = await runtime.start({ port: PORTS.SIM_DEFAULT_TCP_UDP + 20, announce: false });
  console.log(`仿真已启动 port=${port}`);

  let txns;
  let seq = 0;
  const client = new DoipClient({
    protocolVersion: 0x02,
    onAck: (p) => txns?.onDiagnosticMessageAck(p, (seq += 1)),
    onNack: (p) => txns?.onDiagnosticMessageNack(p, (seq += 1)),
    onDiagnosticMessage: (p) => txns?.onDiagnosticMessage(p, (seq += 1)),
  });
  txns = new TransactionManager({
    sa: SA,
    ta: GATEWAY_LA,
    sender: { sendDiagnosticMessage: (sa, ta, ud) => client.sendDiagnosticMessage(sa, ta, ud) },
  });
  await client.connect({ mode: 'sim', host: BIND_HOST, port, sa: '0x0E00', ta: '0x1000' });
  await client.sendRoutingActivation(SA, 0x00);
  const r = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
  console.log(`事务结果: ${r.state} ${r.responseHex ?? ''}`);
  dump('连接中');

  txns.dispose();
  client.close('qa-probe-end');
  await runtime.stop();
  console.log('同进程仿真已停止');
  dump('同进程停止后·立即（对应 smoke 打印时刻）');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterInProc = dump('同进程停止后·300ms 后');

  /* ② fork 隔离模式 */
  console.log('\n--- ② fork 隔离仿真 ---');
  const iso = new SimEcuRuntime();
  const { port: isoPort } = await iso.start({
    port: PORTS.SIM_DEFAULT_TCP_UDP + 21,
    isolatedProcess: true,
    announce: false,
  });
  console.log(`子进程仿真已启动 port=${isoPort}`);
  const isoClient = new DoipClient({ protocolVersion: 0x02 });
  await isoClient.connect({ mode: 'sim', host: BIND_HOST, port: isoPort, sa: '0x0E00', ta: '0x1000' });
  await isoClient.sendRoutingActivation(SA, 0x00);
  isoClient.close('qa-probe-iso-end');
  await iso.stop();
  console.log('子进程仿真已停止');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterFork = dump('fork 停止后');

  console.log('\n=== 结论 ===');
  const verdict = (c) => (Object.keys(c).length === 0 ? '干净' : `残留 ${JSON.stringify(c)}`);
  console.log(`同进程停止后：${verdict(afterInProc)}`);
  console.log(`fork  停止后：${verdict(afterFork)}`);
  console.log('若脚本在此之后仍能自行结束 → 无泄漏；若挂住 → 存在泄漏。');
  /* ★故意不调 process.exit() */
}

main().catch((err) => {
  console.error('探针异常：', err);
  process.exitCode = 2;
});
