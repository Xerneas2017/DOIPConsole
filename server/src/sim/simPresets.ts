/**
 * 仿真 ECU 预置（§3.10）：默认 3 个扁平逻辑地址的虚拟 ECU。
 *
 * ★关于 Seed/Key：P0 的 Key 算法引擎（T14）尚未接入，
 *   这里提供一个**确定性的占位变换**（逐字节 XOR 掩码）供链路验证使用；
 *   仿真侧只校验"客户端算出的 Key 是否等于 expectedKeyHex"，
 *   与真实算法无关 —— 换成真算法时只需改 keyAlgorithmId/expectedKeyHex。
 */

import { PORTS, asciiToHex, formatHexCompact, parseHex } from '@doip/shared';
import type { SimEntityConfig } from '@doip/shared';

/** 占位算法的 XOR 掩码（写死在预置里，便于复现与对照） */
export const SIM_SEED_KEY_MASK = 0x5a;

/**
 * ★仿真 ECU 期望的 Key 算法 id（对应 `data/uds-library.json` 中的
 *   `lib.expression.xor5a`「逐字节异或 0x5A」）。
 *
 * 为什么必须把它导出出去：仿真只校验"客户端算出的 Key == expectedKeyHex"，
 *   而前端默认若选中别的算法（占位算法 / 常量密钥），一键解锁必然吃 NRC 0x35，
 *   连试几次还会触发 0x36（超过尝试次数）。新人第一分钟就撞墙。
 *   后端把它作为 `library.algorithms.recommendedId` 下发，前端据此默认选中。
 */
export const SIM_KEY_ALGORITHM_ID = 'lib.expression.xor5a';

/** 占位 Seed→Key 变换：逐字节 XOR 掩码 */
export function simSeedKey(seed: Uint8Array): Uint8Array {
  return Uint8Array.from(seed, (b) => (b ^ SIM_SEED_KEY_MASK) & 0xff);
}

/** hex 版（供预置表与冒烟脚本共用，保证两侧口径一致） */
export function simSeedKeyHex(seedHex: string): string {
  return formatHexCompact(simSeedKey(parseHex(seedHex)));
}

export const DEFAULT_SIM_PORT: number = PORTS.SIM_DEFAULT_TCP_UDP;

const COMMON_SIDS = ['0x10', '0x11', '0x14', '0x19', '0x22', '0x27', '0x2E', '0x3E'];

function baseTiming(): SimEntityConfig['timing'] {
  return { s3ServerMs: 5000, p2ServerMs: 50, responseDelayMs: 0 };
}

function makeEcu(params: {
  la: string;
  vin: string;
  eid: string;
  gid: string;
  nodeType: 'gateway' | 'node';
  serial: string;
  dids: Record<string, { codec: SimEntityConfig['dids'][string]['codec']; valueHex: string }>;
  dtcs: SimEntityConfig['dtcs'];
  supportedSids: string[];
  seedHex: string;
}): SimEntityConfig {
  return {
    logicalAddress: params.la,
    vin: params.vin,
    eid: params.eid,
    gid: params.gid,
    nodeType: params.nodeType,
    furtherActionRequired: 0,
    vinGidSyncStatus: 0,
    dids: {
      '0xF190': { codec: 'ascii', valueHex: asciiToHex(params.vin) },
      '0xF18C': { codec: 'ascii', valueHex: asciiToHex(params.serial) },
      ...params.dids,
    },
    dtcs: params.dtcs,
    timing: baseTiming(),
    security: {
      levels: {
        1: {
          seedHex: params.seedHex,
          expectedKeyHex: simSeedKeyHex(params.seedHex),
          maxAttempts: 3,
          lockoutMs: 10000,
        },
      },
    },
    supportedSids: params.supportedSids,
    routingActivation: { accept: true },
  };
}

/** 默认 3 个虚拟 ECU（0x1000 网关 + 0x1010 / 0x1020 节点），扁平多逻辑地址 */
export const DEFAULT_SIM_ENTITIES: SimEntityConfig[] = [
  makeEcu({
    la: '0x1000',
    vin: 'LSVAM1234N2000001',
    eid: '010203040506',
    gid: '111213141516',
    nodeType: 'gateway',
    serial: 'GW-SIM-0001',
    dids: {
      '0xF191': { codec: 'ascii', valueHex: asciiToHex('DOIP-SIM') },
      '0xF1A0': { codec: 'hex', valueHex: '0201' },
    },
    dtcs: [
      { code: 'C01234', nameZh: '电池电压过低', status: 0x2c },
      { code: 'C05678', nameZh: '与 BCM 通信丢失', status: 0x0c },
    ],
    supportedSids: COMMON_SIDS,
    seedHex: '12345678',
  }),
  makeEcu({
    la: '0x1010',
    vin: 'LSVAM1234N2000002',
    eid: '010203040507',
    gid: '111213141517',
    nodeType: 'node',
    serial: 'BCM-SIM-0002',
    dids: {
      '0xF191': { codec: 'ascii', valueHex: asciiToHex('DOIP-SIM') },
    },
    dtcs: [{ code: 'C10101', nameZh: '雨量传感器信号异常', status: 0x2c }],
    supportedSids: COMMON_SIDS,
    seedHex: 'A5A5A5A5',
  }),
  makeEcu({
    la: '0x1020',
    vin: 'LSVAM1234N2000003',
    eid: '010203040508',
    gid: '111213141518',
    nodeType: 'node',
    serial: 'IPC-SIM-0003',
    // 刻意不提供 0xF18C：用于演示 NRC 0x31（DID 不存在）
    dids: {
      '0xF191': { codec: 'ascii', valueHex: asciiToHex('DOIP-SIM') },
    },
    dtcs: [{ code: 'C20202', nameZh: '仪表背光驱动故障', status: 0x24 }],
    // 刻意不支持 0x2E / 0x27：用于演示 NRC 0x11（服务不支持）
    supportedSids: ['0x10', '0x19', '0x22', '0x3E'],
    seedHex: '5A5A5A5A',
  }),
];

/** 深拷贝一份预置（避免热改数据集污染模块级常量） */
export function cloneDefaultSimEntities(): SimEntityConfig[] {
  return DEFAULT_SIM_ENTITIES.map((e) => ({
    ...e,
    dids: Object.fromEntries(Object.entries(e.dids).map(([k, v]) => [k, { ...v }])),
    dtcs: e.dtcs.map((d) => ({ ...d })),
    timing: { ...e.timing },
    security: {
      levels: Object.fromEntries(
        Object.entries(e.security.levels).map(([k, v]) => [k, { ...v }]),
      ),
    },
    supportedSids: [...e.supportedSids],
    routingActivation: { ...e.routingActivation },
  }));
}
