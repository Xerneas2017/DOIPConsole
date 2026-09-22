#!/usr/bin/env node
/**
 * ★端到端冒烟（§9.3）：无 UI，CI 可跑。
 *
 *   起仿真 ECU(真 socket) → UDP 发现 → TCP 连接 → 路由激活
 *   → 10 03 → 27 解锁 → 22 F190 → 19 02 → 3E 80
 *   → 功能寻址 → 四类故障注入 → 子进程隔离模式(B11)
 *
 * 用法：`node scripts/smoke.mjs`
 *   首次进入会自动以 `--import tsx` 重新拉起自身（因为后端是 TypeScript 源码直跑），
 *   之后所有 import 都在 tsx loader 下执行。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

if (process.env['DOIP_SMOKE_BOOTSTRAPPED'] !== '1') {
  const res = spawnSync(process.execPath, ['--import', 'tsx', SELF], {
    stdio: 'inherit',
    env: { ...process.env, DOIP_SMOKE_BOOTSTRAPPED: '1' },
  });
  process.exit(typeof res.status === 'number' ? res.status : 1);
}

/* ───────────────────────── 以下是真实脚本 ───────────────────────── */

const { SimEcuRuntime } = await import('../server/src/sim/SimEcuRuntime.ts');
const { DoipClient } = await import('../server/src/doip/DoipClient.ts');
const { DoipUdpDiscovery } = await import('../server/src/doip/DoipUdpDiscovery.ts');
const { TransactionManager } = await import('../server/src/txn/TransactionManager.ts');
const { simSeedKeyHex } = await import('../server/src/sim/simPresets.ts');
const { BIND_HOST, DOIP_DEFAULTS, PORTS, formatHex, hexToAscii, payloadTypeNameZh, sleep } =
  await import('@doip/shared');
const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { bootstrap } = await import('../server/src/index.ts');
const { TraceStore } = await import('../server/src/trace/TraceStore.ts');
const { runExport } = await import('../server/src/trace/exporters/index.ts');

const SA = DOIP_DEFAULTS.TESTER_LOGICAL_ADDRESS; // 0x0E00
const GATEWAY_LA = 0x1000;
const FUNCTIONAL_TA = DOIP_DEFAULTS.FUNCTIONAL_ADDRESS; // 0x1FFF
const SIM_PORT = PORTS.SIM_DEFAULT_TCP_UDP; // 13401
const ISO_PORT = 13402;

const results = [];
let seq = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function fmtNum(v, digits = 1) {
  return typeof v === 'number' ? v.toFixed(digits) : '-';
}

const rows = [];
function record(step, reqHex, r, extra = '') {
  rows.push({
    step,
    req: reqHex,
    state: r.state,
    latency: r.latencyMs,
    gw: r.gatewayForwardLatencyMs,
    note: r.note ?? extra ?? '',
  });
  console.log(
    `  ${pad(step, 14)} ${pad(reqHex, 12)} ${pad(r.state, 20)} ${pad(fmtNum(r.latencyMs), 9)} ${pad(
      fmtNum(r.gatewayForwardLatencyMs),
      11,
    )} ${r.note ?? ''}`,
  );
}

function pad(s, n) {
  const str = String(s ?? '');
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}

function hexWords(hex) {
  return String(hex ?? '');
}

/**
 * 活动句柄**按类型计数**。
 * ★不能用"活动资源必须为 0"判泄漏：stdin/stdout/stderr 本身就是 2~3 个 PipeWrap，
 *   是 Node 进程的固有基线（stdout 是管道时尤其明显）。正确做法是"启动基线 vs 收尾"的增量比对。
 */
function activeCounts() {
  const info =
    typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
  const counts = new Map();
  for (const type of info) counts.set(type, (counts.get(type) ?? 0) + 1);
  return counts;
}

function fmtCounts(counts) {
  const parts = [];
  for (const [type, n] of counts) parts.push(`${type}×${n}`);
  return parts.length > 0 ? parts.join(' ') : '(无)';
}

/** 人为注入一次失败，用于验证"FAIL → 退出码非 0"这条门禁本身有效（`DOIP_SMOKE_FORCE_FAIL=1`） */
const FORCE_FAIL = process.env['DOIP_SMOKE_FORCE_FAIL'] === '1';

/**
 * 人为泄漏探针（`DOIP_SMOKE_LEAK_PROBE=1`）：故意留一个不清的 timer，
 * 用于验证"句柄守卫"真的能抓到泄漏（否则这条断言可能永远 PASS，形同虚设）。
 */
const LEAK_PROBE = process.env['DOIP_SMOKE_LEAK_PROBE'] === '1';

/** stdout 冲刷（管道场景下 process.exit 会截断未写完的输出，导致 FAIL 明细丢失） */
function flushStdout() {
  return new Promise((resolve) => {
    const out = process.stdout;
    if (typeof out.write !== 'function') {
      resolve();
      return;
    }
    out.write('', () => resolve());
  });
}

async function main() {
  console.log('════════════════════════════════════════════════════════════════════');
  console.log(' DoIP 诊断控制台 — M1+M2 端到端冒烟（仿真 ECU 为真 TCP/UDP socket）');
  console.log('════════════════════════════════════════════════════════════════════');

  /* ★句柄基线：脚本启动即刻采集（含 stdio 的 2 个 PipeWrap 等固有资源），收尾做增量比对 */
  const HANDLE_BASELINE = activeCounts();
  console.log(`        启动基线句柄：${fmtCounts(HANDLE_BASELINE)}`);
  if (LEAK_PROBE) {
    // 故意泄漏：不保存句柄、不 clear —— 收尾的基线比对必须报 Timeout+1
    setInterval(() => undefined, 1000);
  }

  /* ① 起仿真 */
  console.log('\n[1] 启动仿真 ECU（net.createServer + dgram，绑定 127.0.0.1）');
  const runtime = new SimEcuRuntime();
  const t0 = Date.now();
  const { port } = await runtime.start({ port: SIM_PORT });
  const startMs = Date.now() - t0;
  check(`仿真启动（实际端口 ${port}）`, port > 0, `耗时 ${startMs}ms，实体 ${runtime.getEntities().length} 个`);
  check('仿真启动耗时 ≤ 3s（PRD US-1）', startMs <= 3000, `${startMs}ms`);

  /* ② UDP 发现 */
  console.log('\n[2] UDP 车辆发现（0x0001 → 0x0004）');
  const discovery = new DoipUdpDiscovery({ port });
  const entities = await discovery.unicastRequest(BIND_HOST, 2000, port);
  check('至少发现 3 个仿真实体', entities.length >= 3, `实际 ${entities.length} 个`);
  for (const e of entities) {
    console.log(
      `        LA=${e.logicalAddress} VIN=${e.vin} EID=${e.eid} GID=${e.gid} node=${e.nodeType} ip=${e.ip}:${e.port} 仿真=${e.isSimulated}`,
    );
  }
  discovery.stopPassiveListen();

  /* ③ TCP 连接 + 路由激活 */
  console.log('\n[3] TCP 连接 + 路由激活（0x0005 → 0x0006）');
  const frames = [];
  let txns;
  const client = new DoipClient({
    protocolVersion: 0x02,
    onFrame: (frame, dir) => {
      frames.push({ dir, type: frame.header.payloadType, hex: formatHex(frame.raw) });
    },
    onAck: (p) => txns.onDiagnosticMessageAck(p, (seq += 1)),
    onNack: (p) => txns.onDiagnosticMessageNack(p, (seq += 1)),
    onDiagnosticMessage: (p) => txns.onDiagnosticMessage(p, (seq += 1)),
  });
  txns = new TransactionManager({
    sa: SA,
    ta: GATEWAY_LA,
    sender: { sendDiagnosticMessage: (sa, ta, ud) => client.sendDiagnosticMessage(sa, ta, ud) },
    seqSource: { next: () => (seq += 1) },
  });

  await client.connect({ mode: 'sim', host: BIND_HOST, port, sa: '0x0E00', ta: '0x1000' });
  check('TCP 已连接', client.isConnected());
  const ra = await client.sendRoutingActivation(SA, 0x00);
  check('路由激活成功 code=0x10', ra.code === 0x10, `${ra.codeNameZh}（0x${ra.code.toString(16)}）`);

  /* ④ 主流程事务 */
  console.log('\n[4] 主流程事务（打印 state / latencyMs / gatewayForwardLatencyMs / note）');
  console.log(
    `  ${pad('步骤', 14)} ${pad('请求', 12)} ${pad('state', 20)} ${pad('latencyMs', 9)} ${pad(
      'gwFwdMs',
      11,
    )} note`,
  );
  console.log('  ' + '-'.repeat(104));

  const r1003 = await txns.send({ addressing: 'physical', sid: '0x10', subFunction: '0x03' });
  record('10 03 扩展会话', '10 03', r1003);
  check('10 03 → COMPLETED', r1003.state === 'COMPLETED' && r1003.ok, r1003.responseHex ?? '');
  check('10 03 记录了网关转发耗时', typeof r1003.gatewayForwardLatencyMs === 'number');

  // 27 解锁：取种子 → 用预置占位算法算 Key → 发密钥
  const seedRes = await txns.send({ addressing: 'physical', sid: '0x27', subFunction: '0x01' });
  record('27 01 取种子', '27 01', seedRes);
  check('27 01 取到种子', seedRes.ok && (seedRes.responseHex ?? '').startsWith('67 01'));
  const seedWords = (seedRes.responseHex ?? '').split(' ').slice(2);
  const seedHex = seedWords.join('');
  const keyHex = simSeedKeyHex(seedHex);
  console.log(`        seed=${seedWords.join(' ')} → key=${hexWords(keyHex)}`);
  const keyRes = await txns.send({
    addressing: 'physical',
    sid: '0x27',
    subFunction: '0x02',
    dataHex: keyHex,
  });
  record('27 02 发密钥', `27 02 ${keyHex}`, keyRes);
  check('27 解锁成功', keyRes.ok && keyRes.responseHex === '67 02', keyRes.responseHex ?? '');

  const r22 = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
  record('22 F190 读VIN', '22 F1 90', r22);
  const vinBody = (r22.responseHex ?? '').slice('62 F1 90 '.length).replace(/ /g, '');
  check('22 F190 返回 17 字节 VIN', r22.ok && vinBody.length === 34, `VIN=${hexToAscii(vinBody)}`);

  const r19 = await txns.send({
    addressing: 'physical',
    sid: '0x19',
    subFunction: '0x02',
    dataHex: 'FF',
  });
  record('19 02 读DTC', '19 02 FF', r19);
  check('19 02 返回 DTC 列表', r19.ok && (r19.responseHex ?? '').startsWith('59 02 FF'), r19.responseHex ?? '');

  const r3e = await txns.send({ addressing: 'physical', rawHex: '3E80' });
  record('3E 80 抑制正响应', '3E 80', r3e);
  check('3E 80 → SUPPRESSED 且不报超时', r3e.state === 'SUPPRESSED' && r3e.errorCode === undefined);

  /* ⑤ 功能寻址 */
  console.log('\n[5] 功能寻址（TA=0x1FFF，多响应按 SA 聚合）');
  txns.setAddresses(SA, FUNCTIONAL_TA);
  const rFunc = await txns.send({ addressing: 'functional', sid: '0x22', dids: ['0xF190'] });
  record('功能寻址 22', '22 F1 90', rFunc);
  check(
    '功能寻址聚合 ≥2 条响应',
    (rFunc.functionalResponses?.length ?? 0) >= 2,
    `按 SA 分组：${(rFunc.functionalResponses ?? []).map((x) => `0x${x.sa.toString(16).toUpperCase()}`).join(', ')}`,
  );
  txns.setAddresses(SA, GATEWAY_LA);

  /* ⑥ 故障注入四类 */
  console.log('\n[6] 故障注入（nrc / noResponse / nack / delayMs）');

  runtime.setFaultRules([
    { id: 'nrc31', enabled: true, match: { sid: '0x22', did: '0xF190' }, action: { kind: 'nrc', code: '0x31' }, remaining: null },
  ]);
  const rNrc = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
  record('注入 NRC 0x31', '22 F1 90', rNrc);
  check('NRC 0x31 → COMPLETED 且 nrc=0x31', rNrc.state === 'COMPLETED' && rNrc.nrc === 0x31, rNrc.nrcNameZh ?? '');

  runtime.setFaultRules([
    { id: 'silent', enabled: true, match: { sid: '0x22', did: '0xF191' }, action: { kind: 'noResponse' }, remaining: null },
  ]);
  const rSilent = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF191'] });
  record('注入不响应', '22 F1 91', rSilent);
  check(
    '★noResponse → FAILED_UDS_TIMEOUT（而非 FAILED_ACK_TIMEOUT）',
    rSilent.state === 'FAILED_UDS_TIMEOUT',
    rSilent.note ?? '',
  );

  runtime.setFaultRules([
    { id: 'nack', enabled: true, match: { sid: '0x19' }, action: { kind: 'nack', code: '0x03' }, remaining: null },
  ]);
  const rNack = await txns.send({ addressing: 'physical', sid: '0x19', subFunction: '0x02', dataHex: 'FF' });
  record('注入 NACK', '19 02 FF', rNack);
  check(
    'NACK → FAILED_NACK 且 note 含"网关未转发"',
    rNack.state === 'FAILED_NACK' && (rNack.note ?? '').includes('网关未转发'),
    rNack.note ?? '',
  );

  runtime.setFaultRules([
    { id: 'delay', enabled: true, match: { sid: '0x22', did: '0xF1A0' }, action: { kind: 'delayMs', ms: 800 }, remaining: null },
  ]);
  const tDelay = Date.now();
  const rDelay = await txns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF1A0'] });
  const delayCost = Date.now() - tDelay;
  record('注入 delay 800ms', '22 F1 A0', rDelay);
  check(
    'delayMs → 先 7F xx 78 再最终响应（P2* 链路）',
    rDelay.state === 'COMPLETED' && delayCost >= 800,
    `实际等待 ${delayCost}ms`,
  );
  runtime.setFaultRules([]);

  /* ⑦ ACK 超时分支（对不存在的 TA 且不让网关回 NACK 的场景由单元测试覆盖，此处打印对照） */
  console.log('\n[7] 两种超时的区分（断言文案不同）');
  const ackTimeoutNote = '网关未在 2000ms 内返回 ACK/NACK，请求可能未进入网关';
  const udsTimeoutNote = rows.find((r) => r.state === 'FAILED_UDS_TIMEOUT')?.note ?? '';
  check(
    'FAILED_UDS_TIMEOUT 文案含"网关已收下并转发"',
    udsTimeoutNote.includes('网关已收下并转发'),
    udsTimeoutNote,
  );
  console.log(`        对照 ACK 超时文案：${ackTimeoutNote}`);

  /* ⑧ 报文合规性抽查 */
  console.log('\n[8] 报文合规性抽查（前若干帧 raw hex）');
  for (const f of frames.slice(0, 8)) {
    console.log(`        ${f.dir} 0x${f.type.toString(16).toUpperCase().padStart(4, '0')} ${payloadTypeNameZh(f.type)} | ${f.hex}`);
  }

  /* ⑨ B11：子进程隔离模式 */
  console.log('\n[9] B11 子进程隔离模式（child_process.fork）');
  const iso = new SimEcuRuntime();
  const { port: isoPort } = await iso.start({ port: ISO_PORT, isolatedProcess: true });
  check(`仿真子进程启动（端口 ${isoPort}）`, isoPort > 0, `isolatedProcess=${iso.getStatus().isolatedProcess}`);
  const isoClient = new DoipClient({
    protocolVersion: 0x02,
    onAck: (p) => isoTxns.onDiagnosticMessageAck(p, (seq += 1)),
    onNack: (p) => isoTxns.onDiagnosticMessageNack(p, (seq += 1)),
    onDiagnosticMessage: (p) => isoTxns.onDiagnosticMessage(p, (seq += 1)),
  });
  let isoTxns;
  isoTxns = new TransactionManager({
    sa: SA,
    ta: GATEWAY_LA,
    sender: { sendDiagnosticMessage: (sa, ta, ud) => isoClient.sendDiagnosticMessage(sa, ta, ud) },
  });
  await isoClient.connect({ mode: 'sim', host: BIND_HOST, port: isoPort, sa: '0x0E00', ta: '0x1000' });
  const isoRa = await isoClient.sendRoutingActivation(SA, 0x00);
  const isoR = await isoTxns.send({ addressing: 'physical', sid: '0x22', dids: ['0xF190'] });
  check('子进程仿真同样走通 22 F190', isoRa.code === 0x10 && isoR.ok, `${isoR.responseHex ?? ''}（子进程）`);
  isoTxns.dispose();
  isoClient.close('smoke-iso-end');
  await iso.stop();
  check('子进程已停止', iso.getStatus().running === false);

  /* ⑩ 收尾（M1 部分） */
  console.log('\n[10] 收尾（M1：主链路）');
  txns.dispose();
  client.close('smoke-end');
  await runtime.stop();
  check('主仿真已停止', runtime.getStatus().running === false);

  /* ══════════════ M2：会话层 / Trace / WS 桥接 / 落盘 ══════════════ */

  console.log('\n[11] M2 后端引导（bootstrap：HTTP+WS 绑定 127.0.0.1）');
  const recordDir = mkdtempSync(join(tmpdir(), 'doip-smoke-rec-'));
  const app = await bootstrap({ port: PORTS.BACKEND_HTTP, recordRootDir: recordDir });
  check(`后端已监听 ${app.url}`, app.port > 0, `WS: ws://${BIND_HOST}:${app.port}`);
  const health = await fetch(`${app.url}/api/health`).then((r) => r.json());
  check('/api/health 返回 ok 且 bindHost 为 127.0.0.1', health.ok === true && health.bindHost === BIND_HOST, JSON.stringify(health));

  console.log('\n[12] 会话层：连接 → 激活 → 10 03 → 3E 周期');
  const sim2 = new SimEcuRuntime();
  const { port: port2 } = await sim2.start({ port: SIM_PORT });
  const st1 = await app.connections.connect({ mode: 'sim', host: BIND_HOST, port: port2, sa: '0x0E00', ta: '0x1000' });
  check('ConnectionManager 连接后 state=ROUTING_ACTIVE', st1.state === 'ROUTING_ACTIVE', `lastRoutingCode=${st1.lastRoutingCode}`);
  const m2a = await app.connections.sendUds({ addressing: 'physical', sid: '0x10', subFunction: '0x03' });
  check('10 03 → COMPLETED 且 UDS 会话切到 EXTENDED',
    m2a.ok && app.connections.statusOf()?.udsSession === 'EXTENDED',
    `${m2a.responseHex} / ${app.connections.statusOf()?.udsSession}`);

  /* ★D-02：事务字段必须真回填到 Trace 条目（耗时列 / 事务高亮 / CSV 事务列都靠它） */
  const reqEntry = app.store
    .all()
    .filter((e) => e.direction === 'TX' && e.uds.serviceId === 0x10)
    .at(-1);
  check(
    '★D-02 请求条目已回填 transactionId / txnRole=request',
    reqEntry !== undefined && reqEntry.transactionId !== null && reqEntry.txnRole === 'request',
    reqEntry === undefined
      ? '未找到 10 03 请求条目'
      : `txn=${String(reqEntry.transactionId)} role=${String(reqEntry.txnRole)}`,
  );
  check(
    '★D-02 请求条目有真实耗时（D 区「耗时(ms)」不再显示 -）',
    reqEntry !== undefined && reqEntry.latencyMs !== null && reqEntry.latencyMs > 0,
    reqEntry === undefined ? '-' : `latencyMs=${String(reqEntry.latencyMs)}`,
  );
  check(
    '★D-02 请求条目 linkedSeq 指向响应条目（事务配对成立）',
    reqEntry !== undefined &&
      reqEntry.linkedSeq !== null &&
      (app.store.bySeq(reqEntry.linkedSeq)?.txnRole ?? null) === 'response',
    reqEntry === undefined
      ? '-'
      : `linkedSeq=${String(reqEntry.linkedSeq)} → ${String(app.store.bySeq(reqEntry.linkedSeq ?? -1)?.txnRole)}`,
  );
  const ackEntry = app.store.all().find((e) => e.txnRole === 'ack');
  check(
    '★D-02 ACK 条目挂到同一事务且带网关转发耗时',
    ackEntry !== undefined &&
      ackEntry.transactionId === reqEntry?.transactionId &&
      ackEntry.gatewayForwardLatencyMs !== null,
    ackEntry === undefined
      ? '未找到 ACK 条目'
      : `txn=${String(ackEntry.transactionId)} gw=${String(ackEntry.gatewayForwardLatencyMs)}ms`,
  );

  /* ★D-05：相对时间基准 = 连接建立时刻，不是后端进程启动时刻 */
  const relFirst = app.store.all()[0]?.tsRelMs ?? null;
  check(
    '★D-05 首条报文相对时间以连接时刻为基准（< 60 s，不是进程启动至今）',
    relFirst !== null && relFirst >= 0 && relFirst < 60_000,
    `tsRelMs=${String(relFirst)}`,
  );

  app.connections.setTesterPresent(true, 500);
  await sleep(1700);
  app.connections.setTesterPresent(false);
  const tpCount = app.store.all().filter((e) => e.tags.includes('周期3E')).length;
  check('3E 周期任务产生 ≥2 条 tag=周期3E', tpCount >= 2, `${tpCount} 条`);

  console.log('\n[13] WS 桥接：hello / 补齐 / trace.batch');
  const wsUrl = `ws://${BIND_HOST}:${app.port}`;
  const { default: WebSocket } = await import('ws');
  const wsMsgs = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const got = [];
    const timer = setTimeout(() => { ws.terminate(); resolve(got); }, 4000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'session.hello', id: 'h1', payload: { lastSeq: 0 } }));
    });
    ws.on('message', (raw) => {
      const env = JSON.parse(String(raw));
      got.push(env);
      if (got.length >= 2) { clearTimeout(timer); ws.close(); resolve(got); }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  }).catch((err) => {
    check('WS 连接可用', false, String(err));
    return [];
  });
  const types = wsMsgs.map((m) => m.type);
  check('WS 收到 hello 事件', types.includes('hello'), types.join(','));
  check('WS 收到可重放流（status / trace.batch）',
    types.includes('status') || types.includes('trace.batch'), types.join(','));

  console.log('\n[14] 导出四种格式（CSV 带 BOM）');
  const entries = app.store.all();
  for (const format of ['csv', 'json', 'jsonl', 'hexdump']) {
    const res = runExport(entries, { format, scope: 'all' });
    check(`导出 ${format} 成功（${res.count} 条 / ${res.buffer.length} 字节）`, res.buffer.length > 0);
    if (format === 'csv') {
      const bom = [res.buffer[0], res.buffer[1], res.buffer[2]];
      check('CSV 首字节为 UTF-8 BOM（EF BB BF）', bom[0] === 0xef && bom[1] === 0xbb && bom[2] === 0xbf, bom.join(','));
      const head = res.buffer.toString('utf8').replace(/^\uFEFF/, '').split('\r\n')[0];
      check('CSV 首行为中文列名', head.includes('时间戳') && head.includes('网关转发耗时(ms)'), head.slice(0, 40) + '…');
      // ★QA 终验缺陷 2：16 位字段不得被掩成 1 字节（否则 0x8001 与 0x0001 撞车，Excel 筛选失效）
      const body = res.buffer.toString('utf8').replace(/^\uFEFF/, '');
      check('★CSV PayloadType 保留 4 位（0x8001 不退化成 0x01）', body.includes('0x8001'));
      check('★CSV SA/TA 保留 4 位（0x0E00 / 0x1000 不退化成 0x00）',
        body.includes('0x0E00') && body.includes('0x1000'));
    }
  }

  console.log('\n[15] ★变更 1：长挂机滚动落盘');
  const recBefore = app.sink.getStatus();
  check('自动录盘已开启（RECORDING.AUTO_START）', recBefore.state === 'recording', recBefore.sessionDir ?? '');
  await app.sink.flush(2000);
  let diskLines = 0;
  let parsed = 0;
  const shardFiles = readdirSync(recBefore.sessionDir ?? '').filter((f) => f.endsWith('.jsonl'));
  for (const f of shardFiles) {
    for (const line of readFileSync(join(recBefore.sessionDir ?? '', f), 'utf8').split('\n')) {
      if (line === '') continue;
      diskLines += 1;
      JSON.parse(line);
      parsed += 1;
    }
  }
  check('分片逐行 JSON.parse 全成功', diskLines > 0 && diskLines === parsed, `${diskLines} 行`);
  check('落盘条数 == Trace 条数（WS 背压不影响落盘）',
    diskLines === recBefore.entriesWritten,
    `磁盘 ${diskLines} / 缓冲 ${app.store.size} / 已写 ${recBefore.entriesWritten}`);
  const idx = JSON.parse(readFileSync(join(recBefore.sessionDir ?? '', 'index.json'), 'utf8'));
  check('index.json 记录分片清单', Array.isArray(idx.files) && idx.entriesWritten === recBefore.entriesWritten,
    `${idx.files.length} 个分片`);
  // ★§3.12：seq 全局单调、一帧一号、不断号
  const seqs = app.store.all().map((e) => e.seq);
  const contiguous = seqs.every((s, i) => s === i + 1);
  check('seq 连续不断号（一帧恰好一个号）', contiguous && app.bus.seqNow === seqs.length,
    `seqNow=${app.bus.seqNow} / 条目=${seqs.length} / 末号=${seqs.at(-1)}`);

  console.log('\n[16] 100 k 条内存回归（§9.4：≤ 300 MB）');
  const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null;
  if (gc !== null) gc();
  const heap0 = process.memoryUsage().heapUsed;
  const bigStore = new TraceStore();
  const tpl = app.store.all()[0];
  for (let i = 1; i <= 100_000; i += 1) {
    bigStore.append(tpl === undefined ? { seq: i, rawHex: '00' } : { ...tpl, seq: i, transactionId: null });
  }
  if (gc !== null) gc();
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1024 / 1024;
  check('100 k 条堆内存增量 ≤ 300 MB', heapMb <= 300, `${heapMb.toFixed(1)} MB，缓冲 ${bigStore.size} 条`);
  bigStore.clear();

  /* ⑰ M3 前端：dev server 起得来 + WS 代理 + 前端 store 摄入 + 过滤表达式 */
  console.log('\n[17] M3 前端（Vite dev + WS 代理 + 前端 store）');
  const { spawn } = await import('node:child_process');

  /**
   * ★自己起一支 Vite，并且**显式把它的代理目标指向本次冒烟的后端端口**。
   *
   * 为什么不能复用外部已占着 5273 的 dev server：那支 dev server 的 `/ws` 代理
   * 指向的是 8787 上**另一支**后端进程，连上去拿到的是别人的 hello，
   * "WS 经代理连通"这条会给出毫无意义的假红（实测踩过）。
   * 所以：5273 空闲就用 5273，被占就退到 5299，但代理目标永远 = `app.port`。
   */
  const VITE_DEFAULT_ORIGIN = 'http://127.0.0.1:5273';
  let vitePort = 5273;
  try {
    const probe = await fetch(`${VITE_DEFAULT_ORIGIN}/`);
    if (probe.ok) vitePort = 5299; // 5273 上已经是别人的 dev server
  } catch {
    /* 5273 空闲 */
  }
  const VITE_ORIGIN = `http://127.0.0.1:${vitePort}`;

  // ★直接起 vite（不经 npm 包装）：避免产生子进程 stdio 管道句柄干扰收尾的句柄基线比对
  const viteBin = join(process.cwd(), 'node_modules/vite/bin/vite.js');
  const vite = spawn(
    process.execPath,
    [viteBin, '--port', String(vitePort), '--strictPort'],
    {
      cwd: join(process.cwd(), 'web'),
      stdio: 'ignore',
      // ★DOIP_BACKEND_PORT：让 dev server 的 /api 与 /ws 代理指向本次冒烟的后端
      env: { ...process.env, DOIP_SMOKE_BOOTSTRAPPED: '1', DOIP_BACKEND_PORT: String(app.port) },
    },
  );

  let viteReady = false;
  for (let i = 0; i < 60 && !viteReady; i += 1) {
    await sleep(300);
    try {
      const res = await fetch(`${VITE_ORIGIN}/`);
      if (res.ok) viteReady = true;
    } catch {
      /* 还没起来 */
    }
  }
  check(
    `npm run dev 起得来（Vite ${vitePort} 返回 200，代理指向后端 ${app.port}）`,
    viteReady,
    viteReady
      ? `${VITE_ORIGIN}${vitePort === 5299 ? '（5273 被外部 dev server 占用，已改用 5299）' : ''}`
      : `dev server 未在 18s 内就绪（端口 ${vitePort}，可手动 \`npm run dev\` 排查）`,
  );

  // ② 经 Vite 代理连后端 WS（/ws → 8787），验证前后端通路
  let proxyMsgs = [];
  try {
    proxyMsgs = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${vitePort}/ws`);
      const got = [];
      const timer = setTimeout(() => {
        ws.terminate();
        resolve(got);
      }, 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'session.hello', id: 'p1', payload: { lastSeq: 0 } }));
      });
      ws.on('message', (raw) => {
        got.push(JSON.parse(String(raw)));
        if (got.length >= 3) {
          clearTimeout(timer);
          ws.close();
          resolve(got);
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (err) {
    check('WS 经 Vite 代理连通', false, String(err));
  }
  check(
    'WS 经 Vite 代理连通（hello + 状态/报文）',
    proxyMsgs.some((m) => m.type === 'hello') && proxyMsgs.length >= 2,
    proxyMsgs.map((m) => m.type).join(','),
  );

  // ③ 前端 store 摄入真实条目：断号检测 + 环形追加
  const { useTraceStore } = await import('../web/src/store/useTraceStore.ts');
  const { compileFilter } = await import('../web/src/decode/filterExpression.ts');
  const feEntries = app.store.all().slice(0, 20);
  useTraceStore.getState().clear();
  useTraceStore.setState({ paused: false, gaps: [] });
  useTraceStore.getState().ingest(feEntries);
  check(
    '前端 store 摄入条数一致且无缺口',
    useTraceStore.getState().entries.length === feEntries.length &&
      useTraceStore.getState().gaps.length === 0,
    `摄入 ${useTraceStore.getState().entries.length} / 缺口 ${useTraceStore.getState().gaps.length}`,
  );
  // 人为抽掉中间一段 → 前端必须登记灰条
  useTraceStore.getState().clear();
  useTraceStore.setState({ gaps: [] });
  useTraceStore.getState().ingest(feEntries.slice(0, 3));
  useTraceStore.getState().ingest(feEntries.slice(6, 9));
  check(
    '★前端断号即登记缺口（重连补齐前显示灰条）',
    useTraceStore.getState().gaps.length === 1,
    JSON.stringify(useTraceStore.getState().gaps[0] ?? null),
  );

  /* ★D-01：灰条必须插到"它本该在的位置"，且后续条目到达后不消失 */
  const { mergeGapRows } = await import('../web/src/components/trace/gapMerge.ts');
  const visible = useTraceStore.getState().entries;
  const mergedOnce = mergeGapRows(visible, useTraceStore.getState().gaps);
  const gapRows = mergedOnce.filter((r) => r.kind === 'gap');
  check(
    '★D-01 缺口灰条插在两条可见行之间（不是只在尾部）',
    gapRows.length === 1 &&
      mergedOnce.findIndex((r) => r.kind === 'gap') > 0 &&
      mergedOnce.findIndex((r) => r.kind === 'gap') < mergedOnce.length - 1,
    mergedOnce.map((r) => (r.kind === 'gap' ? `G${r.seq}+${r.count}` : `E${r.seq}`)).join(' '),
  );
  // 后续条目继续到达 → 灰条必须还在（这是浏览器实测抓到的"刚出现就消失"）
  useTraceStore.getState().ingest(feEntries.slice(9, 12));
  const mergedLater = mergeGapRows(useTraceStore.getState().entries, useTraceStore.getState().gaps);
  check(
    '★D-01 后续条目到达后灰条仍在（不会消失）',
    mergedLater.filter((r) => r.kind === 'gap').length === 1,
    mergedLater.map((r) => (r.kind === 'gap' ? `G${r.seq}+${r.count}` : `E${r.seq}`)).join(' '),
  );
  useTraceStore.getState().clear();

  // ④ 前端过滤表达式对真实条目求值
  const fn = compileFilter('doip.type == 0x8001');
  const hit = typeof fn === 'function' ? feEntries.filter((e) => fn(e)).length : -1;
  check('前端过滤表达式命中 0x8001 诊断报文', hit > 0, `${hit} / ${feEntries.length} 条`);
  check('非法表达式判定为 invalid（不静默丢行）', compileFilter('doip.type ==') === 'invalid');

  vite.kill('SIGTERM');
  await sleep(800);
  check('Vite dev 已停止', vite.exitCode !== null || vite.killed, `exitCode=${String(vite.exitCode)}`);

  /* ══════════════ M4：服务库 / 请求区 / Key 算法 ══════════════ */

  console.log('\n[18] M4 服务库（T12）：加载 / Q13 短名 / 热更新 repatch / 校验定位');
  const { UdsLibraryStore, findDataDir } = await import('../server/src/uds/UdsLibraryStore.ts');
  const { UdsDecoder } = await import('../server/src/uds/UdsDecoder.ts');
  const { UdsRepatcher } = await import('../server/src/uds/UdsRepatcher.ts');
  const { validateLibrary } = await import('../server/src/uds/UdsLibraryValidator.ts');

  const libUserTmp = join(tmpdir(), `doip-smoke-lib-${Date.now().toString(36)}.json`);
  const smokeLib = new UdsLibraryStore({
    builtinPath: join(findDataDir(), 'uds-library.json'),
    userPath: libUserTmp,
  });
  check(
    '内置库加载成功（服务 ≥ 15 条、NRC ≥ 30 条、DID ≥ 20 条）',
    smokeLib.services().length >= 15 && smokeLib.nrcTable().length >= 30 && smokeLib.didTable().length >= 20,
    `服务 ${smokeLib.services().length} / NRC ${smokeLib.nrcTable().length} / DID ${smokeLib.didTable().length}`,
  );

  // ★Q13：Trace 列渲染 `DSC(0x10) 诊断会话控制`
  const smokeDecoder = new UdsDecoder(smokeLib);
  const dsc = smokeDecoder.decode(Uint8Array.from([0x10, 0x03]), 'request');
  check(
    '★Q13：解码产出短名 DSC(0x10) 诊断会话控制',
    dsc.shortEn === 'DSC' && dsc.shortZh === '会话控制' && dsc.serviceName === 'DiagnosticSessionControl',
    `${dsc.shortEn}(0x10) ${dsc.serviceName} / ${dsc.subFunctionNameZh}`,
  );
  const rdbi = smokeDecoder.decode(Uint8Array.from([0x22, 0xf1, 0x90]), 'request');
  check('DID 0xF190 解析出中文名', rdbi.did === 0xf190 && (rdbi.didNameZh ?? '').length > 0, String(rdbi.didNameZh));

  // 热更新 → repatch 最近条目
  const smokeRepatcher = new UdsRepatcher(smokeLib, smokeDecoder);
  const repatchEntry = {
    seq: 1,
    transactionId: null,
    ts: '2026-09-22T00:00:00.000000Z',
    tsRelMs: 0,
    transport: 'TCP',
    direction: 'TX',
    peer: '127.0.0.1:13401',
    sessionId: 'default',
    doip: {
      protocolVersion: 2, inverseVersionValid: true, payloadType: 0x8001,
      payloadTypeName: 'DiagnosticMessage', payloadTypeNameZh: '诊断报文', payloadLength: 7,
      sourceAddress: 0x0e00, targetAddress: 0x1000, sourceAddressName: null, targetAddressName: null,
      ackCode: null, ackNameZh: null, nackCode: null, nackNameZh: null,
      activationResponseCode: null, activationResponseCodeZh: null,
      vin: null, eid: null, gid: null, headerHex: '02FD800100000007',
    },
    uds: { decoded: false },
    linkedSeq: null, txnRole: null, latencyMs: null, gatewayForwardLatencyMs: null,
    timeout: false, errorCode: null, errorNameZh: null, tags: [],
    rawHex: '02 FD 80 01 00 00 00 07 0E 00 10 00 22 F1 90',
  };
  smokeRepatcher.repatchOne(repatchEntry);
  const nameBefore = repatchEntry.uds.didNameZh;
  const editedLib = JSON.parse(smokeLib.exportJson());
  const vinDid = editedLib.didTable.find((d) => String(d.id).toUpperCase().endsWith('F190'));
  if (vinDid !== undefined) vinDid.nameZh = '车架号（冒烟改名）';
  const updResult = smokeLib.update(editedLib);
  smokeRepatcher.repatchOne(repatchEntry);
  check(
    '★P0-10：库热更新后最近条目被 repatch（改名立即生效）',
    updResult.ok === true && repatchEntry.uds.didNameZh === '车架号（冒烟改名）' && repatchEntry.seq === 1,
    `${String(nameBefore)} → ${String(repatchEntry.uds.didNameZh)}（seq 保持 ${repatchEntry.seq}）`,
  );

  // 校验失败必须给出行位置
  const brokenJson = '{\n  "schemaVersion": "1.0",\n  "meta": {}\n  "nrcTable": []\n}';
  const brokenResult = validateLibrary(brokenJson);
  check(
    '非法库 JSON 被拦下并给出行/列',
    brokenResult.ok === false && (brokenResult.issues[0]?.line ?? 0) > 0,
    `第 ${String(brokenResult.issues[0]?.line ?? 0)} 行第 ${String(brokenResult.issues[0]?.column ?? 0)} 列`,
  );
  smokeLib.dispose();

  console.log('\n[19] M4 Key 算法（T14）：四类 provider / 占位标记 / 三坑');
  const { KeyAlgorithmRegistry } = await import('../server/src/uds/algorithms/KeyAlgorithmRegistry.ts');
  const { KeyAlgorithmEngine } = await import('../server/src/uds/KeyAlgorithmEngine.ts');
  const { KeyVectorVerifier } = await import('../server/src/uds/KeyVectorVerifier.ts');

  const reg = new KeyAlgorithmRegistry(true);
  const eng = new KeyAlgorithmEngine(reg);
  const hexOf = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');

  check(
    'ported 占位算法可算出 Key（seed A1B2C3D4 → 8E99E8FB）',
    hexOf(eng.computeById('ported.placeholder.seedkey', { level: 1, seed: Uint8Array.from([0xa1, 0xb2, 0xc3, 0xd4]) })) === '8E 99 E8 FB',
    hexOf(eng.computeById('ported.placeholder.seedkey', { level: 1, seed: Uint8Array.from([0xa1, 0xb2, 0xc3, 0xd4]) })),
  );
  check(
    'expression provider：逐字节异或 0x5A',
    hexOf(
      eng.compute(
        { id: 'e', name: 'xor', type: 'expression', params: { wordWidth: 8, endian: 'big', steps: [{ op: 'xor', maskHex: '5A' }] } },
        { level: 1, seed: Uint8Array.from([0x00, 0xff]) },
      ),
    ) === '5A A5',
  );
  check(
    'javascript provider（vm 沙箱）可用',
    hexOf(
      eng.compute(
        { id: 'j', name: 'js', type: 'javascript', source: 'var o=new Uint8Array(seed.length);for(var i=0;i<seed.length;i++){o[i]=helpers.toU8(helpers.xor(seed[i],0x5A));}return o;' },
        { level: 1, seed: Uint8Array.from([0x00, 0xff]) },
      ),
    ) === '5A A5',
  );
  let jsTimeoutOk = false;
  try {
    eng.compute({ id: 'j2', name: 'loop', type: 'javascript', source: 'while(true){}' }, { level: 1, seed: Uint8Array.from([0x00]) });
  } catch (err) {
    jsTimeoutOk = true;
  }
  check('javascript 死循环被沙箱超时掐断', jsTimeoutOk);

  const vecFile = KeyVectorVerifier.load(join(findDataDir(), 'key-algo-vectors.json'));
  const reports = reg.verifyAll(vecFile.bindings, KeyVectorVerifier.reporter(vecFile));
  const ph = reg.get('ported.placeholder.seedkey');
  check(
    '★TC-K10：占位算法 origin=placeholder 且未通过向量校验（verified=false）',
    ph?.origin === 'placeholder' && ph?.verified === false && (reports.find((r) => r.algorithmId === ph?.id)?.total ?? -1) === 0,
    `origin=${String(ph?.origin)} verified=${String(ph?.verified)}`,
  );

  // ★C→JS 移植三坑
  check('★坑1：>> 带符号、>>> 无符号（0x80000000）', (0x80000000 >> 24) === -128 && (0x80000000 >>> 24) === 0x80);
  check('★坑2：char 符号扩展（0x80 → -128 vs & 0xFF → 128）', ((0x80 << 24) >> 24) === -128 && (0x80 & 0xff) === 128);
  check('★坑3：无自动截断（0xFF+1 = 256，(0xFF+1)&0xFF = 0）', 0xff + 1 === 256 && ((0xff + 1) & 0xff) === 0);

  // 前端库 store 的排序口径
  const { useLibraryStore, algorithmsForLevel, serviceLabel } = await import('../web/src/store/useLibraryStore.ts');
  useLibraryStore.getState().setAlgorithms(reg.listForLevel(1), vecFile.vectors);
  const ordered = algorithmsForLevel(useLibraryStore.getState().algorithms, 1);
  const svc10 = smokeLib.serviceBySid(0x10);
  check(
    '前端算法下拉：placeholder 排最后；服务标签形如 DSC(0x10) 诊断会话控制',
    ordered[ordered.length - 1]?.origin === 'placeholder' &&
      (svc10 === null || serviceLabel(svc10) === 'DSC(0x10) 诊断会话控制'),
    `${ordered.map((a) => a.id).join(',')} | ${svc10 === null ? 'n/a' : serviceLabel(svc10)}`,
  );

  /* ⑳ ★QA 终验 4 条缺陷回归 */
  console.log('\n[20] ★QA 终验缺陷回归：功能寻址 / CSV 截断 / 解锁默认算法 / 缺口自愈');

  // ① QA-1（P0-05）：真实链路（ConnectionManager → DoipSession → TransactionManager）发功能寻址
  await app.connections.sendUds({ addressing: 'functional', sid: '0x3E', subFunction: '0x00' });
  const funcTx = app.store
    .all()
    .filter((e) => e.direction === 'TX' && e.uds.serviceId === 0x3e)
    .at(-1);
  check(
    '★QA-1 P0-05：功能寻址发出的帧 TA=0x1FFF（不是物理 TA 0x1000）',
    funcTx?.doip.targetAddress === 0x1fff,
    funcTx === undefined
      ? '未找到功能寻址 TX 帧'
      : `TA=0x${(funcTx.doip.targetAddress ?? 0).toString(16).toUpperCase()} · ${funcTx.rawHex}`,
  );

  check(
    '★QA-观察②：手动发的 3E 00 不打「周期3E」标签（只有周期任务才打）',
    funcTx !== undefined && !funcTx.tags.includes('周期3E'),
    funcTx === undefined ? '-' : `tags=[${funcTx.tags.join(',')}]`,
  );

  // ② QA-2（P0-04）：CSV 的 PayloadType / SA / TA 不得被掩成 1 字节
  const csv2 = runExport(app.store.all(), { format: 'csv', scope: 'all' });
  const csvText = csv2.buffer.toString('utf8');
  const csvHits = ['0x8001', '0x0E00', '0x1000'].map((s) => `${s}:${csvText.includes(s) ? '有' : '缺'}`);
  check(
    '★QA-2 P0-04：CSV 保留 16 位 PayloadType/SA/TA（0x8001/0x0E00/0x1000）',
    csvText.includes('0x8001') && csvText.includes('0x0E00') && csvText.includes('0x1000'),
    csvHits.join(' '),
  );

  // ③ QA-3（P0-07）：一键解锁的默认算法必须与仿真期望密钥一致
  const { default: Ws } = await import('ws');
  const wsAsk = (type, payload, want) =>
    new Promise((resolve) => {
      const sock = new Ws(`ws://${BIND_HOST}:${app.port}`);
      const timer = setTimeout(() => {
        sock.terminate();
        resolve(null);
      }, 8000);
      sock.on('open', () => sock.send(JSON.stringify({ type, id: `qa-${type}`, payload })));
      sock.on('message', (raw) => {
        let env = null;
        try {
          env = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (env !== null && env.type === want) {
          clearTimeout(timer);
          sock.close();
          resolve(env);
        }
      });
      sock.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

  await app.sim.start({ port: SIM_PORT + 1 });
  const algoEnv = await wsAsk('keyAlgo.list', { level: 1 }, 'library.algorithms');
  const recId = algoEnv?.payload?.recommendedId ?? null;
  check(
    '★QA-3 P0-07：keyAlgo.list 回 recommendedId（仿真在跑 → 逐字节异或 0x5A）',
    recId === 'lib.expression.xor5a',
    `recommendedId=${String(recId)}（共 ${String(algoEnv?.payload?.algorithms?.length ?? 0)} 个算法）`,
  );
  const unlockEnv = await wsAsk('security.unlock', { level: 1, keyAlgorithmId: recId }, 'security.unlocked');
  check(
    '★QA-3：用推荐算法一键解锁成功（不再开箱吃 NRC 0x35）',
    unlockEnv?.payload?.ok === true,
    unlockEnv === null
      ? '未收到 security.unlocked'
      : `ok=${String(unlockEnv.payload.ok)} nrc=${String(unlockEnv.payload.nrc)} seed=${String(unlockEnv.payload.seedHex)} key=${String(unlockEnv.payload.keyHex)}`,
  );

  // ④ QA-4（P0-11）：补齐起点 = 最靠前缺口起点-1，而不是 lastSeq；补齐后缺口消失
  const { resyncBaseSeq } = await import('../web/src/ws/useResync.ts');
  const { useTraceStore: qaTrace } = await import('../web/src/store/useTraceStore.ts');
  qaTrace.getState().clear();
  const seedEntry = app.store.all()[0];
  const mkE = (seq) => ({ ...(seedEntry ?? {}), seq });
  qaTrace.getState().ingest([mkE(41), mkE(42), mkE(43), mkE(44)]);
  qaTrace.getState().ingest([mkE(60)]);
  const qaState = qaTrace.getState();
  const baseSeq = resyncBaseSeq(qaState);
  check(
    '★QA-4 P0-11：hello 的 lastSeq 取缺口起点-1（44），不是已摄入最大值（60）',
    baseSeq === 44 && qaState.lastSeq === 60 && (qaState.gaps[0]?.fromSeq ?? 0) === 45,
    `hello.lastSeq=${baseSeq}（lastSeq=${qaState.lastSeq}，缺口 ${String(qaState.gaps[0]?.fromSeq)}–${String(qaState.gaps[0]?.toSeq)}）`,
  );
  const backfill = [];
  for (let s2 = 45; s2 <= 59; s2 += 1) backfill.push(mkE(s2));
  qaTrace.getState().ingest(backfill);
  check(
    '★QA-4：补齐回填后缺口计数归零（自愈闭环成立）',
    qaTrace.getState().gaps.length === 0 && qaTrace.getState().entries.length === 20,
    `gaps=${qaTrace.getState().gaps.length} entries=${qaTrace.getState().entries.length}`,
  );
  qaTrace.getState().clear();

  // ⑤ QA-观察①：录制状态的分片清单必须含"正在写的分片"
  const recLive = app.sink.getStatus();
  check(
    '★QA-观察①：录制中分片清单含当前分片（磁盘已有 jsonl 时不显示 0 片）',
    recLive.state === 'recording' && recLive.files.length >= 1 && recLive.entriesWritten > 0,
    `state=${recLive.state} files=${recLive.files.length} entries=${recLive.entriesWritten} bytes=${recLive.bytesWritten}`,
  );

  /* ㉑ 收尾：★不强制 exit —— 若存在句柄/定时器泄漏，进程会挂住，由看门狗判定失败 */
  console.log('\n[21] 收尾：优雅关闭 + 自行退出（无强制 exit）');
  await app.sink.stop();
  check('录盘已停止', app.sink.getStatus().state === 'stopped', `${app.sink.getStatus().files.length} 个分片`);
  await app.connections.disconnect('smoke-m2-end');
  await sim2.stop();
  await app.stop();
  check('后端已停止', true, `端口 ${app.port} 已释放`);
  const getActive = () =>
    typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [];
  const fmt = (arr) => (arr.length > 0 ? arr.join(', ') : '(无)');
  console.log(`        关闭瞬间活动资源：${fmt(getActive())}`);
  // 让在途的 close/GC 回调跑完，再看一次：仍存在的才叫"泄漏"
  await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setImmediate(r));
  console.log(`        静默 300ms 后：${fmt(getActive())}`);

  // ★判据 = 与启动基线的**增量**；基线里的 stdio PipeWrap 本来就有，不算泄漏
  const after = activeCounts();
  const added = [];
  for (const [type, n] of after) {
    const base = HANDLE_BASELINE.get(type) ?? 0;
    if (n > base) added.push(`${type}+${n - base}`);
  }
  check(
    '关闭后无新增悬挂句柄（与启动基线比对）',
    added.length === 0,
    added.length === 0 ? `基线 ${fmtCounts(HANDLE_BASELINE)} → 收尾 ${fmtCounts(after)}` : `新增 ${added.join(', ')}（基线 ${fmtCounts(HANDLE_BASELINE)}）`,
  );

  /* 汇总 */
  if (FORCE_FAIL) {
    check('★门禁自检：DOIP_SMOKE_FORCE_FAIL=1 时本条必须 FAIL', false, '人为失败，用于验证退出码非 0');
  }
  const failed = results.filter((r) => !r.ok);
  console.log('\n════════════════════════════════════════════════════════════════════');
  console.log(` 冒烟结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`   FAIL: ${f.name} — ${f.detail}`);
  }
  console.log('════════════════════════════════════════════════════════════════════');

  if (failed.length > 0) {
    // ★先置 exitCode（自然退出也会带出非 0），再冲刷 stdout，最后立即退出：
    //   绝不靠"打印了 FAIL"就算数 —— CI 只看退出码。
    process.exitCode = 1;
    await flushStdout();
    process.exit(1);
  }
  console.log(`        退出码：${process.exitCode ?? 0}`);
  // ★不调用 process.exit：若还有悬挂 timer/socket，进程会挂住 —— 由看门狗判定为"句柄泄漏"
  const watchdog = setTimeout(() => {
    console.error('\n✗ 进程在 5s 内未能自行退出 → 存在悬挂 timer/socket（句柄泄漏）');
    process.exit(1);
  }, 5000);
  watchdog.unref();
}

main().catch((err) => {
  console.error('\n冒烟脚本异常：', err);
  process.exit(1);
});
