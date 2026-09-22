/**
 * 运行时配置（§3.2 Q3 落点）：从 `shared/constants.ts` 的 TIMING/LIMITS 派生，
 * 支持 UI 覆盖（深合并）与重置。
 *
 * ★业务代码禁止裸超时数字字面量，一律走 `getTiming()`。
 */

import { TIMING, LIMITS, PORTS, DOIP_DEFAULTS, BIND_HOST } from '@doip/shared';

export type TimingMap = { -readonly [K in keyof typeof TIMING]: (typeof TIMING)[K] };
export type LimitsMap = { -readonly [K in keyof typeof LIMITS]: (typeof LIMITS)[K] };

export interface FrameReaderSettings {
  /** strict: inverse 校验失败即判失同步；lenient: 仅标记并继续（默认） */
  versionPolicy: 'strict' | 'lenient';
  /** 失同步后是否尝试字节级重同步扫描（默认 false） */
  resyncOnDesync: boolean;
  maxPayloadBytes: number;
  maxBufferBytes: number;
  incompleteFrameTimeoutMs: number;
}

export interface DoipSettings {
  protocolVersion: number;
  testerLogicalAddress: number;
  functionalAddress: number;
  activationType: number;
}

export interface SimSettings {
  host: string;
  defaultPort: number;
  /** B11：是否用 child_process.fork 隔离运行仿真 */
  isolatedProcess: boolean;
}

export interface RuntimeConfig {
  /** ★Q11：写死 127.0.0.1，不可配置 */
  readonly bindHost: string;
  doip: DoipSettings;
  sim: SimSettings;
  frameReader: FrameReaderSettings;
  timing: TimingMap;
  limits: LimitsMap;
}

export interface RuntimeConfigPatch {
  doip?: Partial<DoipSettings>;
  sim?: Partial<SimSettings>;
  frameReader?: Partial<FrameReaderSettings>;
  timing?: Partial<TimingMap>;
  limits?: Partial<LimitsMap>;
}

function cloneTiming(): TimingMap {
  return { ...TIMING };
}

function cloneLimits(): LimitsMap {
  return { ...LIMITS };
}

function createDefaultConfig(): RuntimeConfig {
  return {
    bindHost: BIND_HOST,
    doip: {
      protocolVersion: DOIP_DEFAULTS.PROTOCOL_VERSION,
      testerLogicalAddress: DOIP_DEFAULTS.TESTER_LOGICAL_ADDRESS,
      functionalAddress: DOIP_DEFAULTS.FUNCTIONAL_ADDRESS,
      activationType: DOIP_DEFAULTS.ACTIVATION_TYPE_DEFAULT,
    },
    sim: {
      host: BIND_HOST,
      defaultPort: PORTS.SIM_DEFAULT_TCP_UDP,
      isolatedProcess: false,
    },
    frameReader: {
      versionPolicy: 'lenient', // ★B12：默认 lenient（现实中大量网关填 0xFF）
      resyncOnDesync: false,
      maxPayloadBytes: LIMITS.MAX_PAYLOAD_BYTES,
      maxBufferBytes: LIMITS.MAX_FRAME_READER_BUFFER_BYTES,
      incompleteFrameTimeoutMs: TIMING.FRAME_ASSEMBLY_TIMEOUT_MS,
    },
    timing: cloneTiming(),
    limits: cloneLimits(),
  };
}

let current: RuntimeConfig = createDefaultConfig();

export function getConfig(): RuntimeConfig {
  return current;
}

/** 取某个时序常量（唯一入口） */
export function getTiming<K extends keyof TimingMap>(key: K): TimingMap[K] {
  return current.timing[key];
}

export function getLimits<K extends keyof LimitsMap>(key: K): LimitsMap[K] {
  return current.limits[key];
}

/** UI 覆盖配置（浅合并一层；timing/limits 为扁平结构，合并后立刻生效） */
export function updateConfig(patch: RuntimeConfigPatch): RuntimeConfig {
  current = {
    bindHost: current.bindHost,
    doip: { ...current.doip, ...patch.doip },
    sim: { ...current.sim, ...patch.sim },
    frameReader: { ...current.frameReader, ...patch.frameReader },
    timing: { ...current.timing, ...patch.timing },
    limits: { ...current.limits, ...patch.limits },
  };
  return current;
}

export function resetConfig(): RuntimeConfig {
  current = createDefaultConfig();
  return current;
}

/** 派生出分帧器配置（供 DoipFrameReader / DoipEntityServer 使用） */
export function getFrameReaderSettings(): FrameReaderSettings {
  const cfg = getConfig();
  return {
    versionPolicy: cfg.frameReader.versionPolicy,
    resyncOnDesync: cfg.frameReader.resyncOnDesync,
    maxPayloadBytes: cfg.frameReader.maxPayloadBytes,
    maxBufferBytes: cfg.frameReader.maxBufferBytes,
    incompleteFrameTimeoutMs: cfg.frameReader.incompleteFrameTimeoutMs,
  };
}
