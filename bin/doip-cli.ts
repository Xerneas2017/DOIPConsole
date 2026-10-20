/**
 * DoIP 诊断控制台 — 命令行工具（doip）
 *
 * 设计约束：
 *  - ★复用现有协议栈（ConnectionManager / UdsService / DoipUdpDiscovery），不重写任何协议逻辑；
 *  - ★Q1：不做自动重连/自动重发，失败即退出并给出错误码与建议；
 *  - ★Q3：超时一律取 shared 的 TIMING，不在 CLI 里裸写；
 *  - stdout 只留业务输出（日志已静音），`--json` 可被管道直接解析；
 *  - 退出码：0 = 成功；1 = 通信失败/无结果；2 = 参数错误。
 *
 * 用法见 `doip --help`。
 */

import { createRequire } from 'node:module';
import { AppError } from '../server/src/errors/AppError';
import { DoipUdpDiscovery } from '../server/src/doip/DoipUdpDiscovery';
import { ConnectionManager } from '../server/src/session/ConnectionManager';
import { UdsService } from '../server/src/uds/UdsService';
import { silenceLogs } from '../server/src/logging/logger';
import {
  ENTITY_NODE_TYPE_NAMES,
  FALLBACK_NRC_TABLE,
  POWER_MODE_NAMES,
  TIMING,
  describeCode,
  normalizeHex,
  parseHex,
} from '@doip/shared';
import type { ConnectConfig, DiscoveredEntity, SendUdsRequest, SendUdsResult } from '@doip/shared';

// ★先静音：后端模块一旦打日志就会混进 stdout（--json 会被污染）
silenceLogs();

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version?: string };
const CLI_VERSION = pkg.version ?? '0.0.0';

/* ─────────────── 输出与颜色 ─────────────── */

interface Palette {
  enabled: boolean;
}

const palette: Palette = { enabled: process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined };

function paint(code: string, text: string): string {
  return palette.enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}
const green = (s: string): string => paint('32', s);
const red = (s: string): string => paint('31', s);
const yellow = (s: string): string => paint('33', s);
const cyan = (s: string): string => paint('36', s);
const dim = (s: string): string => paint('2', s);
const bold = (s: string): string => paint('1', s);

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function errOut(line = ''): void {
  process.stderr.write(`${line}\n`);
}

/* ─────────────── 参数解析 ─────────────── */

interface Opts {
  host: string;
  /** 用户是否显式给了 --host（scan 用：缺省走广播） */
  hostExplicit: boolean;
  port: number;
  sa: string;
  ta: string;
  protocol: string;
  activationType: string;
  timeoutMs: number | null;
  addressing: 'physical' | 'functional';
  json: boolean;
  yes: boolean;
  passive: boolean;
  help: boolean;
  version: boolean;
}

const SHORT_FLAGS: Record<string, string> = {
  '-H': 'host',
  '-p': 'port',
  '-h': 'help',
  '-v': 'version',
};

const BOOLEAN_FLAGS = new Set(['json', 'yes', 'passive', 'help', 'version', 'no-color']);

interface Parsed {
  command: string;
  positional: string[];
  opts: Opts;
  errors: string[];
}

function defaultOpts(): Opts {
  return {
    host: '127.0.0.1',
    hostExplicit: false,
    port: 13400,
    sa: '0x0E00',
    ta: '0x1000',
    protocol: '0x02',
    activationType: '0x00',
    timeoutMs: null,
    addressing: 'physical',
    json: false,
    yes: false,
    passive: false,
    help: false,
    version: false,
  };
}

function parseArgv(argv: string[]): Parsed {
  const opts = defaultOpts();
  const positional: string[] = [];
  const errors: string[] = [];

  const applyValue = (key: string, value: string): void => {
    switch (key) {
      case 'host':
        opts.host = value;
        opts.hostExplicit = true;
        return;
      case 'port': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 65535) {
          errors.push(`--port 非法：${value}（应为 1-65535 的整数）`);
          return;
        }
        opts.port = n;
        return;
      }
      case 'sa':
        opts.sa = value;
        return;
      case 'ta':
        opts.ta = value;
        return;
      case 'protocol':
        opts.protocol = value;
        return;
      case 'activation-type':
        opts.activationType = value;
        return;
      case 'timeout': {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          errors.push(`--timeout 非法：${value}（应为正数毫秒）`);
          return;
        }
        opts.timeoutMs = Math.round(n);
        return;
      }
      case 'addressing':
        if (value !== 'physical' && value !== 'functional') {
          errors.push(`--addressing 非法：${value}（physical | functional）`);
          return;
        }
        opts.addressing = value;
        return;
      case 'no-color':
        palette.enabled = false;
        return;
      default:
        errors.push(`未知选项：--${key}`);
    }
  };

  const applyBoolean = (key: string): void => {
    switch (key) {
      case 'json':
        opts.json = true;
        palette.enabled = false; // JSON 输出不允许 ANSI 色码
        return;
      case 'yes':
        opts.yes = true;
        return;
      case 'passive':
        opts.passive = true;
        return;
      case 'help':
        opts.help = true;
        return;
      case 'version':
        opts.version = true;
        return;
      case 'no-color':
        palette.enabled = false;
        return;
      default:
        errors.push(`未知选项：--${key}`);
    }
  };

  let i = 0;
  while (i < argv.length) {
    const raw = argv[i];
    if (raw === undefined) break;
    i += 1;

    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      const key = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
      const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;
      if (BOOLEAN_FLAGS.has(key)) {
        if (inline !== undefined) {
          // 允许 --json=true / --json=false
          const truthy = inline !== 'false' && inline !== '0';
          if (truthy) applyBoolean(key);
          else if (key === 'json') opts.json = false;
        } else {
          applyBoolean(key);
        }
        continue;
      }
      if (inline !== undefined) {
        applyValue(key, inline);
        continue;
      }
      const next = argv[i];
      if (next === undefined || next.startsWith('-')) {
        errors.push(`选项 --${key} 缺少取值`);
        continue;
      }
      i += 1;
      applyValue(key, next);
      continue;
    }

    if (raw.startsWith('-') && raw.length > 1) {
      const mapped = SHORT_FLAGS[raw];
      if (mapped === undefined) {
        errors.push(`未知选项：${raw}`);
        continue;
      }
      if (BOOLEAN_FLAGS.has(mapped)) {
        applyBoolean(mapped);
        continue;
      }
      const next = argv[i];
      if (next === undefined || next.startsWith('-')) {
        errors.push(`选项 ${raw} 缺少取值`);
        continue;
      }
      i += 1;
      applyValue(mapped, next);
      continue;
    }

    positional.push(raw);
  }

  return { command: positional[0] ?? '', positional: positional.slice(1), opts, errors };
}

/* ─────────────── 帮助 ─────────────── */

const HELP = `${bold('doip')} — DoIP 诊断控制台命令行工具 (v${CLI_VERSION})

${bold('用法')}
  doip <命令> [选项]

${bold('命令')}
  scan                  UDP 车辆发现（0x0001 → 0x0004）
  send <hex>            连接 + 路由激活 + 发送一条 UDS（0x8001），打印响应
  alive                 TCP 主动存活检查（0x0007 → 0x0008）
  entity-status         UDP 实体状态（0x4001 → 0x4002）
  power-mode            UDP 电源模式（0x4003 → 0x4004）

${bold('通用选项')}
  -H, --host <ip>       目标地址（默认 127.0.0.1；scan 缺省为广播 + 回环）
  -p, --port <n>        目标端口（默认 13400；连内置仿真用 13401）
      --sa <0xXXXX>     tester 逻辑地址（默认 0x0E00）
      --ta <0xXXXX>     目标逻辑地址（默认 0x1000）
      --protocol <ver>  DoIP 协议版本 0x02 | 0x03（默认 0x02）
      --activation-type <0xNN>
                        路由激活类型（默认 0x00）
      --timeout <ms>    send：P2 响应超时；entity-status/power-mode：UDP 等待超时
      --addressing <mode>
                        send 的寻址方式 physical | functional（默认 physical）
      --passive         scan：同时被动监听 0x0004 公告
      --json            机器可读输出（适合 CI / 管道）
      --yes             危险操作确认（0x11 / 0x14 / 0x2E / 0x31 / 0x27 发送密钥）
      --no-color        关闭彩色输出
  -h, --help            显示帮助
  -v, --version         显示版本

${bold('示例')}
  doip scan --port 13401                              # 发现仿真 ECU
  doip send 22 F1 90 --port 13401                     # 读 VIN
  doip send 10 03 --port 13401                        # 切扩展会话
  doip send 11 01 --port 13401 --yes                  # ECU 复位（危险操作需 --yes）
  doip send 22F190 -H 192.168.1.10 --json             # 连真实 ECU，JSON 输出
  doip alive --port 13401                             # 存活检查
  doip entity-status --port 13401                     # 实体状态
  doip power-mode --port 13401                        # 电源模式

${bold('退出码')}
  0 成功    1 通信失败/无结果    2 参数错误`;

/* ─────────────── 公共装配 ─────────────── */

function buildConnectConfig(o: Opts): ConnectConfig {
  const cfg: ConnectConfig = {
    mode: 'real',
    host: o.host,
    port: o.port,
    sa: o.sa,
    ta: o.ta,
  };
  if (o.protocol.trim() !== '') cfg.protocolVersion = o.protocol;
  if (o.activationType.trim() !== '') cfg.activationType = o.activationType;
  return cfg;
}

function printError(err: unknown, json: boolean): void {
  const appErr = err instanceof AppError ? err : null;
  const messageZh = appErr !== null ? appErr.message : err instanceof Error ? err.message : String(err);
  const code = appErr?.code ?? 'E_IMPL_UNEXPECTED';
  if (json) {
    out(
      JSON.stringify(
        {
          ok: false,
          error: {
            code,
            messageZh,
            ...(appErr?.hintZh === undefined ? {} : { hintZh: appErr.hintZh }),
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  errOut(red(`[FAIL] ${messageZh}`));
  errOut(dim(`  错误码：${code}`));
  if (appErr?.hintZh !== undefined) errOut(dim(`  建议：${appErr.hintZh}`));
}

/* ─────────────── scan ─────────────── */

async function cmdScan(o: Opts): Promise<number> {
  const discovery = new DoipUdpDiscovery({ port: o.port });
  const targetIp = o.hostExplicit ? o.host : null;
  try {
    if (!o.json) {
      const where = targetIp ?? '255.255.255.255 + 127.0.0.1';
      out(dim(`正在发现车辆（UDP ${where}:${o.port}${o.passive ? '，含被动监听' : ''}）...`));
    }
    const result = await discovery.scan({
      port: o.port,
      ...(targetIp === null ? {} : { targetIp }),
      ...(o.timeoutMs === null ? {} : { timeoutMs: o.timeoutMs }),
      ...(o.passive ? { passive: true } : {}),
    });
    if (o.json) {
      out(JSON.stringify({ ok: result.entities.length > 0, partial: result.partial, entities: result.entities }, null, 2));
      return result.entities.length > 0 ? 0 : 1;
    }
    if (result.entities.length === 0) {
      errOut(yellow('未发现任何实体：确认目标已上电、同一网段，且 DoIP 服务已启动'));
      return 1;
    }
    out(green(`发现 ${String(result.entities.length)} 个实体${result.partial ? '（结果可能不全）' : ''}：`));
    result.entities.forEach((e: DiscoveredEntity, idx: number) => {
      const via = e.viaAnnouncement ? 'announcement' : 'request';
      out(
        `  [${String(idx + 1)}] ${bold(e.logicalAddress)}  ${e.ip}:${String(e.port)}  ` +
          `VIN ${e.vin}  EID ${e.eid}  GID ${e.gid}  ${dim(`${via}${e.isSimulated ? ' / sim' : ''}`)}`,
      );
    });
    return 0;
  } finally {
    discovery.stopPassiveListen();
    discovery.cancelPending();
  }
}

/* ─────────────── send ─────────────── */

/** 22 F1 90 → 62 F1 90 时把 VIN 解出来（最常用的自检场景） */
function tryDecodeVin(requestHex: string, responseHex: string | undefined): string | null {
  if (responseHex === undefined) return null;
  const req = requestHex.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const resp = responseHex.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!req.startsWith('22F190') || !resp.startsWith('62F190')) return null;
  try {
    const bytes = parseHex(resp.slice(6));
    const text = Buffer.from(bytes).toString('ascii');
    return /^[\x20-\x7e]{1,64}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function describeResult(result: SendUdsResult, requestHex: string, o: Opts): number {
  if (o.json) {
    out(
      JSON.stringify(
        {
          ok: result.state === 'COMPLETED',
          state: result.state,
          txnId: result.txnId,
          requestHex,
          ...(result.responseHex === undefined ? {} : { responseHex: result.responseHex }),
          ...(result.nrc === undefined ? {} : { nrc: result.nrc }),
          ...(result.nrcNameZh === undefined ? {} : { nrcNameZh: result.nrcNameZh }),
          ...(result.nackCode === undefined ? {} : { nackCode: result.nackCode }),
          ...(result.nackNameZh === undefined ? {} : { nackNameZh: result.nackNameZh }),
          ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
          ...(result.gatewayForwardLatencyMs === undefined
            ? {}
            : { gatewayForwardLatencyMs: result.gatewayForwardLatencyMs }),
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
          ...(result.note === undefined ? {} : { note: result.note }),
          ...(result.functionalResponses === undefined ? {} : { functionalResponses: result.functionalResponses }),
        },
        null,
        2,
      ),
    );
    // ★通信层完成即算成功（NRC 是 ECU 的正常回答，不是通信失败）
    return result.state === 'COMPLETED' ? 0 : 1;
  }

  out(`${cyan('→')} ${requestHex}`);
  if (result.responseHex !== undefined) out(`${cyan('←')} ${result.responseHex}`);

  const timing: string[] = [];
  if (result.latencyMs !== undefined) timing.push(`耗时 ${String(Math.round(result.latencyMs))} ms`);
  if (result.gatewayForwardLatencyMs !== undefined) {
    timing.push(`网关转发 ${String(Math.round(result.gatewayForwardLatencyMs))} ms`);
  }
  const timingText = timing.length > 0 ? `  ${dim(timing.join('，'))}` : '';

  if (result.state === 'COMPLETED' && result.nrc === undefined) {
    out(`${green('[OK]')} ${result.state}${timingText}`);
  } else if (result.nrc !== undefined) {
    const desc = describeCode(FALLBACK_NRC_TABLE, result.nrc);
    const codeHex = `0x${result.nrc.toString(16).toUpperCase().padStart(2, '0')}`;
    out(`${yellow('[NRC]')} ${desc.nameZh}（${codeHex}）${timingText}`);
    if (desc.hint !== null) out(dim(`  建议：${desc.hint}`));
  } else {
    const name = result.nackNameZh ?? result.errorCode ?? '';
    out(`${red('[FAIL]')} ${result.state}  ${result.note ?? name}`);
    if (result.nackCode !== undefined) {
      out(dim(`  NACK 码：0x${result.nackCode.toString(16).toUpperCase().padStart(2, '0')}（网关未转发，非 UDS 层错误）`));
    }
  }

  const vin = tryDecodeVin(requestHex, result.responseHex);
  if (vin !== null) out(`${dim('VIN =')} ${bold(vin)}`);

  return result.state === 'COMPLETED' ? 0 : 1;
}

async function cmdSend(o: Opts, hexArg: string): Promise<number> {
  let requestHex: string;
  try {
    requestHex = normalizeHex(hexArg);
  } catch {
    errOut(red(`[FAIL] 非法 hex：${hexArg || '(空)'}`));
    errOut(dim('  示例：doip send 22 F1 90'));
    return 2;
  }
  if (requestHex === '') {
    errOut(red('[FAIL] 缺少要发送的 UDS 数据'));
    return 2;
  }

  const manager = new ConnectionManager({});
  const uds = new UdsService(manager);
  try {
    if (!o.json) out(dim(`连接 ${o.host}:${o.port}（SA ${o.sa} → TA ${o.ta}，协议 ${o.protocol}）...`));
    const status = await manager.connect(buildConnectConfig(o));
    if (status.state !== 'ROUTING_ACTIVE') {
      throw new AppError('E_ROUTING_DENIED', `路由激活未成功（状态 ${status.state}）`);
    }
    if (!o.json) out(dim(`路由已激活（0x${(status.lastRoutingCode ?? 0).toString(16).toUpperCase()}）`));

    const req: SendUdsRequest = { addressing: o.addressing, rawHex: requestHex };
    if (o.yes) req.confirmed = true;
    if (o.timeoutMs !== null) req.p2TimeoutMs = o.timeoutMs;

    const result = await uds.sendUdsRequest(req);
    return describeResult(result, requestHex, o);
  } catch (err) {
    printError(err, o.json);
    return 1;
  } finally {
    manager.dispose();
  }
}

/* ─────────────── alive ─────────────── */

async function cmdAlive(o: Opts): Promise<number> {
  const manager = new ConnectionManager({});
  try {
    if (!o.json) out(dim(`连接 ${o.host}:${o.port} 并激活路由...`));
    await manager.connect(buildConnectConfig(o));
    const result = await manager.aliveCheck();
    if (o.json) {
      out(
        JSON.stringify(
          {
            ok: true,
            sourceAddress: `0x${result.sourceAddress.toString(16).toUpperCase().padStart(4, '0')}`,
            latencyMs: Math.round(result.latencyMs),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    out(
      `${green('[OK]')} 存活检查通过：实体 SA=0x${result.sourceAddress
        .toString(16)
        .toUpperCase()
        .padStart(4, '0')}，往返 ${String(Math.round(result.latencyMs))} ms`,
    );
    return 0;
  } catch (err) {
    printError(err, o.json);
    return 1;
  } finally {
    manager.dispose();
  }
}

/* ─────────────── entity-status / power-mode ─────────────── */

async function cmdEntityStatus(o: Opts): Promise<number> {
  const discovery = new DoipUdpDiscovery({ port: o.port });
  try {
    const status = await discovery.requestEntityStatus(
      o.host,
      o.timeoutMs ?? TIMING.UDP_UNICAST_RESPONSE_TIMEOUT_MS,
      o.port,
    );
    if (status === null) {
      throw new AppError('E_UDP_TIMEOUT', `实体状态请求超时：${o.host}:${String(o.port)} 无响应`);
    }
    const nodeTypeZh =
      ENTITY_NODE_TYPE_NAMES[status.nodeType] ?? `未知(0x${status.nodeType.toString(16).toUpperCase()})`;
    if (o.json) {
      out(
        JSON.stringify(
          {
            ok: true,
            from: status.from,
            latencyMs: Math.round(status.latencyMs),
            nodeType: status.nodeType,
            nodeTypeNameZh: nodeTypeZh,
            maxConcurrentSockets: status.maxConcurrentSockets,
            currentlyOpenSockets: status.currentlyOpenSockets,
            maxDataSize: status.maxDataSize,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    out(`${green('[OK]')} 实体状态  来自 ${status.from}，${String(Math.round(status.latencyMs))} ms`);
    out(`  节点类型      ${nodeTypeZh}（0x${status.nodeType.toString(16).toUpperCase().padStart(2, '0')}）`);
    out(`  并发 socket   ${String(status.currentlyOpenSockets)} / ${String(status.maxConcurrentSockets)}`);
    out(`  最大数据长度  ${(status.maxDataSize / (1024 * 1024)).toFixed(1)} MiB`);
    return 0;
  } catch (err) {
    printError(err, o.json);
    return 1;
  } finally {
    discovery.stopPassiveListen();
    discovery.cancelPending();
  }
}

async function cmdPowerMode(o: Opts): Promise<number> {
  const discovery = new DoipUdpDiscovery({ port: o.port });
  try {
    const result = await discovery.requestPowerMode(
      o.host,
      o.timeoutMs ?? TIMING.UDP_UNICAST_RESPONSE_TIMEOUT_MS,
      o.port,
    );
    if (result === null) {
      throw new AppError('E_UDP_TIMEOUT', `电源模式请求超时：${o.host}:${String(o.port)} 无响应`);
    }
    const nameZh = POWER_MODE_NAMES[result.powerMode] ?? `未知(0x${result.powerMode.toString(16).toUpperCase()})`;
    if (o.json) {
      out(
        JSON.stringify(
          {
            ok: true,
            powerMode: result.powerMode,
            powerModeNameZh: nameZh,
            from: result.from,
            latencyMs: Math.round(result.latencyMs),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    out(
      `${green('[OK]')} 电源模式：${bold(nameZh)}（0x${result.powerMode
        .toString(16)
        .toUpperCase()
        .padStart(2, '0')}）  来自 ${result.from}，${String(Math.round(result.latencyMs))} ms`,
    );
    return 0;
  } catch (err) {
    printError(err, o.json);
    return 1;
  } finally {
    discovery.stopPassiveListen();
    discovery.cancelPending();
  }
}

/* ─────────────── main ─────────────── */

async function main(): Promise<number> {
  const parsed = parseArgv(process.argv.slice(2));
  const { command, positional, opts } = parsed;

  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) errOut(red(`[FAIL] ${message}`));
    errOut(dim('运行 doip --help 查看用法'));
    return 2;
  }
  if (opts.help || command === 'help') {
    out(HELP);
    return 0;
  }
  if (opts.version || command === 'version') {
    out(`doip-cli ${CLI_VERSION}`);
    return 0;
  }

  switch (command) {
    case '':
      out(HELP);
      return 0;
    case 'scan':
      return cmdScan(opts);
    case 'send':
      return cmdSend(opts, positional.join(' '));
    case 'alive':
      return cmdAlive(opts);
    case 'entity-status':
      return cmdEntityStatus(opts);
    case 'power-mode':
      return cmdPowerMode(opts);
    default:
      errOut(red(`[FAIL] 未知命令：${command}`));
      errOut(dim('可用命令：scan | send | alive | entity-status | power-mode（doip --help 查看详情）'));
      return 2;
  }
}

const exitCode = await main();
process.exitCode = exitCode;
/**
 * 兜底：正常情况下各命令已释放 socket/timer，事件循环自然退出。
 * 若平台差异导致句柄残留，5 秒后强制退出——unref 保证它不阻止正常退出。
 */
setTimeout(() => {
  process.exit(exitCode);
}, 5000).unref();
