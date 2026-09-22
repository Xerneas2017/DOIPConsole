/**
 * T12 服务库用例（§9 TC-L01~L05）。
 *
 * 覆盖：zod 校验失败定位 / 重复 id / 热更新 repatch / 导入导出往返 /
 *      内置项与自定义项合并（升级不覆盖自定义）。
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type { TraceEntry, UdsLibrary } from '@doip/shared';
import { emptyUdsDecodeResult } from '@doip/shared';
import {
  UdsLibraryStore,
  mergeLibraries,
  minimalLibrary,
  findDataDir,
} from '../uds/UdsLibraryStore';
import { UdsDecoder } from '../uds/UdsDecoder';
import { UdsRepatcher, extractUserData } from '../uds/UdsRepatcher';
import { validateLibrary } from '../uds/UdsLibraryValidator';

const BUILTIN = join(findDataDir(), 'uds-library.json');
let tmpRoot: string;

function tempUserPath(name: string): string {
  return join(tmpRoot, `${name}.json`);
}

function makeStore(name: string): UdsLibraryStore {
  return new UdsLibraryStore({ builtinPath: BUILTIN, userPath: tempUserPath(name) });
}

function baseLibrary(): UdsLibrary {
  const store = makeStore('base');
  return JSON.parse(JSON.stringify(store.get())) as UdsLibrary;
}

/** 造一条最小 TraceEntry（seq/rawHex 为事实字段，repatch 绝不改动） */
function makeEntry(seq: number, rawHex: string, payloadType: number): TraceEntry {
  return {
    seq,
    transactionId: null,
    ts: '2026-09-22T10:00:00.000000Z',
    tsRelMs: 0,
    transport: 'TCP',
    direction: 'TX',
    peer: '127.0.0.1:13401',
    sessionId: 'default',
    doip: {
      protocolVersion: 2,
      inverseVersionValid: true,
      payloadType,
      payloadTypeName: 'DiagnosticMessage',
      payloadTypeNameZh: '诊断报文',
      payloadLength: 0,
      sourceAddress: 0x0e00,
      targetAddress: 0x1000,
      sourceAddressName: null,
      targetAddressName: null,
      ackCode: null,
      ackNameZh: null,
      nackCode: null,
      nackNameZh: null,
      activationResponseCode: null,
      activationResponseCodeZh: null,
      vin: null,
      eid: null,
      gid: null,
      headerHex: '02FD800100000006',
    },
    uds: emptyUdsDecodeResult(),
    linkedSeq: null,
    txnRole: null,
    latencyMs: null,
    gatewayForwardLatencyMs: null,
    timeout: false,
    errorCode: null,
    errorNameZh: null,
    tags: [],
    rawHex,
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'doip-lib-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('T12 — 服务库加载与校验', () => {
  it('TC-L01：内置库文件本身必须通过校验', () => {
    const result = validateLibrary(readFileSync(BUILTIN, 'utf8'));
    expect(result.ok).toBe(true);
    expect(result.library?.services.length ?? 0).toBeGreaterThanOrEqual(15);
  });

  it('TC-L01：JSON 语法错误给出行/列', () => {
    const text = '{\n  "schemaVersion": "1.0",\n  "meta": {}\n  "nrcTable": []\n}';
    const result = validateLibrary(text);
    expect(result.ok).toBe(false);
    const issue = result.issues[0];
    expect(issue).toBeDefined();
    expect(issue?.line ?? 0).toBeGreaterThan(0);
    expect(issue?.column ?? 0).toBeGreaterThan(0);
    expect(issue?.messageZh ?? '').toContain('JSON 语法错误');
  });

  it('TC-L01：zod 结构错误给出 JSON 指针与行位置', () => {
    const lib = baseLibrary();
    // 故意把 services[0].shortEn 改成非字符串
    const broken = JSON.parse(JSON.stringify(lib)) as Record<string, unknown>;
    const services = broken['services'] as Array<Record<string, unknown>>;
    services[0] = { ...services[0], shortEn: 12345 };
    const text = JSON.stringify(broken, null, 2);
    const result = validateLibrary(text);
    expect(result.ok).toBe(false);
    const hit = result.issues.find((i) => i.path.includes('/services/0/shortEn'));
    expect(hit).toBeDefined();
    expect(hit?.line ?? 0).toBeGreaterThan(0);
  });

  it('TC-L02：DID / SID / NRC / 别名重复被检出', () => {
    const lib = baseLibrary();
    lib.didTable.push({ ...(lib.didTable[0] as NonNullable<typeof lib.didTable[0]>) });
    lib.services.push({ ...(lib.services[0] as NonNullable<typeof lib.services[0]>) });
    const result = validateLibrary(lib);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.messageZh.includes('DID 重复'))).toBe(true);
    expect(result.issues.some((i) => i.messageZh.includes('服务 id 重复'))).toBe(true);
  });

  it('TC-L02：正响应 id 必须 = 请求 id + 0x40', () => {
    const lib = baseLibrary();
    const svc = lib.services[0];
    if (svc !== undefined) svc.positiveResponseId = '0x99';
    const result = validateLibrary(lib);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.messageZh.includes('正响应 id'))).toBe(true);
  });

  it('TC-L02：★Q13 短名超长被拦截', () => {
    const lib = baseLibrary();
    const svc = lib.services[0];
    if (svc !== undefined) {
      svc.shortEn = 'TOOLONG';
      svc.shortZh = '这个短名超长了';
    }
    const result = validateLibrary(lib);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.messageZh.includes('shortEn'))).toBe(true);
    expect(result.issues.some((i) => i.messageZh.includes('shortZh'))).toBe(true);
  });

  it('TC-L02：★B17 破坏性服务被强制补标 destructive', () => {
    const lib = baseLibrary();
    for (const svc of lib.services) svc.destructive = false;
    const result = validateLibrary(lib);
    expect(result.ok).toBe(true);
    const ids = (result.library?.services ?? [])
      .filter((s) => s.destructive === true)
      .map((s) => s.id.toUpperCase());
    expect(ids).toContain('0X11');
    expect(ids).toContain('0X14');
    expect(ids).toContain('0X2E');
    expect(ids).toContain('0X31');
  });

  it('TC-L03：热更新后解码立即生效 + 最近条目被 repatch', () => {
    const store = makeStore('hot');
    const decoder = new UdsDecoder(store);
    const repatcher = new UdsRepatcher(store, decoder);

    // 0x22 F190（VIN）请求：22 F1 90
    const entry = makeEntry(1, '02 FD 80 01 00 00 00 07 0E 00 10 00 22 F1 90', 0x8001);
    decoder.decode(new Uint8Array([0x22, 0xf1, 0x90]), 'request');
    repatcher.repatchOne(entry);
    expect(entry.uds.did).toBe(0xf190);
    const before = entry.uds.didNameZh;

    // 改名 → 热更新
    const lib = JSON.parse(JSON.stringify(store.get())) as UdsLibrary;
    const did = lib.didTable.find((d) => d.id.toUpperCase() === '0XF190' || d.id.toUpperCase() === '0xF190');
    expect(did).toBeDefined();
    if (did !== undefined) did.nameZh = '车架号（已改名）';
    const updated = store.update(lib);
    expect(updated.ok).toBe(true);

    repatcher.repatchOne(entry);
    expect(entry.uds.didNameZh).toBe('车架号（已改名）');
    expect(entry.uds.didNameZh).not.toBe(before);
    // ★事实字段绝不能被 repatch 改动
    expect(entry.seq).toBe(1);
    expect(entry.rawHex).toBe('02 FD 80 01 00 00 00 07 0E 00 10 00 22 F1 90');
  });

  it('TC-L03：repatch 只回写真正变化的条目', () => {
    const store = makeStore('hot2');
    const decoder = new UdsDecoder(store);
    const repatcher = new UdsRepatcher(store, decoder);
    const a = makeEntry(1, '02 FD 80 01 00 00 00 07 0E 00 10 00 22 F1 90', 0x8001);
    const b = makeEntry(2, '02 FD 80 01 00 00 00 06 0E 00 10 00 10 03', 0x8001);
    repatcher.repatch([a, b]);
    // 第二次 repatch：库没变，不应有条目被改写
    const changed = repatcher.repatch([a, b]);
    expect(changed.length).toBe(0);
  });

  it('TC-L04：导出再导入往返无损', () => {
    const store = makeStore('roundtrip');
    const exported = store.exportJson();
    const result = store.importJson(exported);
    expect(result.ok).toBe(true);
    const again = store.exportJson();
    expect(JSON.parse(again)).toEqual(JSON.parse(exported));
  });

  it('TC-L04：非法 JSON 被拦下，库保持不变', () => {
    const store = makeStore('reject');
    const before = store.exportJson();
    const result = store.importJson('{"schemaVersion": "1.0", "services": "not-an-array"}');
    expect(result.ok).toBe(false);
    expect(store.exportJson()).toBe(before);
  });

  it('TC-L05：升级只合并新增内置项，绝不覆盖自定义项', () => {
    const builtin = minimalLibrary();
    builtin.services.push({
      id: '0x10',
      name: 'DiagnosticSessionControl',
      nameZh: '诊断会话控制',
      shortEn: 'DSC',
      shortZh: '会话控制',
      positiveResponseId: '0x50',
      supportsFunctional: true,
      builtin: true,
      form: [],
      positiveResponseForm: [],
    });
    const user = JSON.parse(JSON.stringify(builtin)) as UdsLibrary;
    const userSvc = user.services[0];
    if (userSvc !== undefined) userSvc.nameZh = '用户改过的名字';
    user.services.push({
      id: '0x22',
      name: 'ReadDataByIdentifier',
      nameZh: '读 DID（用户自建）',
      shortEn: 'RDBI',
      shortZh: '读DID',
      positiveResponseId: '0x62',
      supportsFunctional: true,
      builtin: false,
      form: [],
      positiveResponseForm: [],
    });

    // 模拟"升级"：内置基线新增 0x3E
    const upgraded = JSON.parse(JSON.stringify(builtin)) as UdsLibrary;
    upgraded.services.push({
      id: '0x3E',
      name: 'TesterPresent',
      nameZh: '会话保持',
      shortEn: 'TP',
      shortZh: '会话保持',
      positiveResponseId: '0x7E',
      supportsFunctional: true,
      builtin: true,
      form: [],
      positiveResponseForm: [],
    });

    const merged = mergeLibraries(upgraded, user);
    expect(merged.services.map((s) => s.id.toUpperCase())).toContain('0X3E'); // 新增内置项进来
    const dsc = merged.services.find((s) => s.id.toUpperCase() === '0X10');
    expect(dsc?.nameZh).toBe('用户改过的名字'); // 自定义修改不被覆盖
    const rdbi = merged.services.find((s) => s.id.toUpperCase() === '0X22');
    expect(rdbi?.nameZh).toBe('读 DID（用户自建）'); // 自建项保留
  });

  it('TC-L05：用户文件与内置基线合并后条目数 = 内置 ∪ 用户', () => {
    const store = makeStore('merge');
    const lib = JSON.parse(JSON.stringify(store.get())) as UdsLibrary;
    const builtinCount = lib.services.length;
    lib.services.push({
      id: '0x2F',
      name: 'InputOutputControlByIdentifier',
      nameZh: 'IO 控制（用户自建）',
      shortEn: 'IOCBI',
      shortZh: 'IO控制',
      positiveResponseId: '0x6F',
      supportsFunctional: false,
      builtin: false,
      form: [],
      positiveResponseForm: [],
    });
    expect(store.update(lib).ok).toBe(true);
    expect(store.services().length).toBe(builtinCount + 1);
    // 重新 new 一个 store（模拟重启）→ 自定义项仍在
    const reloaded = new UdsLibraryStore({
      builtinPath: BUILTIN,
      userPath: tempUserPath('merge'),
    });
    expect(reloaded.services().length).toBe(builtinCount + 1);
    expect(reloaded.serviceBySid(0x2f)?.builtin).toBe(false);
    reloaded.dispose();
  });

  it('Q13：Trace 解码产出短名，且完整名进详情', () => {
    const store = makeStore('q13');
    const decoder = new UdsDecoder(store);
    const result = decoder.decode(new Uint8Array([0x10, 0x03]), 'request');
    expect(result.shortEn).toBe('DSC');
    expect(result.shortZh).toBe('会话控制');
    expect(result.serviceName).toBe('DiagnosticSessionControl');
    expect(result.subFunctionNameZh).toBe('扩展会话');
    expect(result.tree?.children?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('负响应：NRC 中文名与处置建议来自库', () => {
    const store = makeStore('nrc');
    const decoder = new UdsDecoder(store);
    const result = decoder.decode(new Uint8Array([0x7f, 0x22, 0x31]), 'response');
    expect(result.messageKind).toBe('negative');
    expect(result.nrc).toBe(0x31);
    expect(result.nrcNameZh).toBe('请求越界');
    expect(result.nrcHint).toContain('DID');
  });

  it('Q2：0x8003 NACK 码表取自库文件（库可改）', () => {
    const store = makeStore('nack');
    const table = store.diagnosticMessageNackCodes();
    expect(table.length).toBeGreaterThan(0);
    const entry = table.find((e) => e.code.toUpperCase() === '0X02');
    expect(entry?.nameZh).toBe('源地址无效');
  });

  it('repatch 保持 seq/ts 不变（事实字段不可被派生字段污染）', () => {
    const store = makeStore('facts');
    const decoder = new UdsDecoder(store);
    const repatcher = new UdsRepatcher(store, decoder);
    const entry = makeEntry(77, '02 FD 80 01 00 00 00 07 0E 00 10 00 22 F1 90', 0x8001);
    repatcher.repatchOne(entry);
    expect(entry.seq).toBe(77);
    expect(entry.ts).toBe('2026-09-22T10:00:00.000000Z');
  });

  it('extractUserData 只认 0x8001，其余返回 null', () => {
    const ok = makeEntry(1, '02 FD 80 01 00 00 00 07 0E 00 10 00 22 F1 90', 0x8001);
    expect(extractUserData(ok)).not.toBeNull();
    const nack = makeEntry(2, '02 FD 80 03 00 00 00 05 0E 00 10 00 02', 0x8003);
    expect(extractUserData(nack)).toBeNull();
  });

  it('dispose 后 store 仍可读（关闭的是监听句柄）', () => {
    const store = makeStore('dispose');
    store.dispose();
    expect(store.services().length).toBeGreaterThan(0);
  });

  it('「重置内置」回到内置基线', () => {
    const store = makeStore('reset');
    const lib = JSON.parse(JSON.stringify(store.get())) as UdsLibrary;
    const svc = lib.services[0];
    if (svc !== undefined) svc.nameZh = '改坏了';
    expect(store.update(lib).ok).toBe(true);
    expect(store.services()[0]?.nameZh).toBe('改坏了');
    store.resetBuiltin();
    expect(store.services()[0]?.nameZh).not.toBe('改坏了');
  });

  it('用户文件路径可被外部改写后 reload 生效', () => {
    const path = tempUserPath('external');
    const store = new UdsLibraryStore({ builtinPath: BUILTIN, userPath: path });
    const lib = JSON.parse(JSON.stringify(store.get())) as UdsLibrary;
    const svc = lib.services[0];
    if (svc !== undefined) svc.nameZh = '外部改写';
    writeFileSync(path, JSON.stringify(lib, null, 2), 'utf8');
    store.reload();
    expect(store.services()[0]?.nameZh).toBe('外部改写');
    store.dispose();
  });
});
