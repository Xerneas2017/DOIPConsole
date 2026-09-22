/**
 * UDS 服务库与解码结果类型（§3.5）。
 * 运行时校验（zod + 语义检查）由 T12 的 UdsLibraryValidator 负责。
 */

/* ─────────────── 码表条目 ─────────────── */

export interface CodeEntry {
  code: string; // '0x10'
  name: string; // 'RoutingSuccessfullyActivated'
  nameZh: string; // '路由激活成功'
  /** 处置建议，驱动 ErrorExplainCard */
  hint?: string;
  builtin: boolean;
}

export interface NrcEntry extends CodeEntry {
  severity?: 'error' | 'warn' | 'info';
}

/* ─────────────── 服务定义 ─────────────── */

export type FormFieldRole = 'subFunction' | 'did' | 'data';

export interface FormField {
  name: string;
  role: FormFieldRole;
  offset: number;
  /** -1 表示取到报文结尾 */
  length: number;
  widget: 'select' | 'didSelect' | 'hex' | 'number' | 'text';
  optional?: boolean;
  endian?: 'big' | 'little';
  values?: Array<{ value: string; name: string; nameZh: string }>;
}

export interface ServiceDef {
  id: string; // '0x10'
  name: string; // 'DiagnosticSessionControl'
  nameZh: string; // '诊断会话控制'
  /** ★Q13：Trace 内联短名 */
  shortEn: string; // 'DSC' ≤5 char
  shortZh: string; // '会话控制' ≤6 字
  positiveResponseId: string; // '0x50'
  supportsFunctional: boolean;
  builtin: boolean;
  flow?: 'seedKey' | 'none';
  keyAlgorithmRef?: string;
  enableIn?: 'P0' | 'P1';
  /** ★B17：破坏性服务（0x11/0x14/0x2E/0x31…）发送前必须二次确认 */
  destructive?: boolean;
  form: FormField[];
  positiveResponseForm: FormField[];
}

export interface DidEntry {
  id: string;
  name: string;
  nameZh: string;
  shortEn?: string;
  shortZh?: string;
  codec: 'ascii' | 'hex' | 'uint8' | 'uint16' | 'uint32' | 'bcd' | 'raw';
  length?: number;
  builtin: boolean;
}

export interface DtcEntry {
  code: string; // 'C01234'（3 字节，6 hex 位）
  nameZh: string;
  severity?: 'error' | 'warn' | 'info';
  builtin: boolean;
}

export interface AliasEntry {
  address: string; // '0x1000'
  alias: string; // 'BCM'
  builtin: boolean;
}

/* ─────────────── 服务库校验结果（T12）─────────────── */

/** 一条校验问题；★用户输入是不可信输入，必须给出可定位的 JSON 指针与行号 */
export interface ValidationIssue {
  /** JSON 指针路径，如 '/services/3/form/0/offset' */
  path: string;
  /** 1-based 行号；无法从原文定位时为 0 */
  line: number;
  /** 1-based 列号；未知为 0 */
  column: number;
  messageZh: string;
  severity: 'error' | 'warn';
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** 归一化后的库；ok=false 时为 null（绝不把半截库写进运行时） */
  library: UdsLibrary | null;
}

/* ─────────────── Key 算法（Q7 / §3.9）─────────────── */

export type KeyOp =
  | { op: 'xor'; maskHex: string }
  | { op: 'not' }
  | { op: 'add' | 'sub'; value: number; modulo?: number }
  | { op: 'shiftL' | 'shiftR'; bits: number }
  | { op: 'rotL' | 'rotR'; bits: number }
  | { op: 'swapEndian' }
  | { op: 'reverseBytes' }
  | { op: 'bswap16' | 'bswap32' };

/**
 * 服务库 JSON 中的算法 spec（可编辑部分）。
 *
 * - `ported`  ★主路径（变更 2）：引用 `KeyAlgorithmRegistry` 中的具名移植算法
 * - `constant` / `expression`（位运算）/ `javascript`（vm 沙箱）为通用兜底
 */
export type KeyAlgorithmSpec =
  | { id: string; name: string; type: 'ported'; algorithmId: string; params?: Record<string, unknown> }
  | { id: string; name: string; type: 'constant'; params: { keyHex: string } }
  | {
      id: string;
      name: string;
      type: 'expression';
      params: { wordWidth: 8 | 16 | 32; endian: 'big' | 'little'; steps: KeyOp[] };
    }
  | { id: string; name: string; type: 'javascript'; source: string; params?: Record<string, unknown> };

/** 移植算法元数据（可序列化；`compute` 只在服务端实现里） */
export interface PortedAlgorithm {
  /** 稳定唯一 id，命名规范 `ported.<厂商>.<用途>` */
  id: string;
  nameZh: string;
  appliesToLevels: number[];
  /** null = 不限 */
  seedLengthBytes: number | null;
  /** null = 与 seed 等长 */
  keyLengthBytes: number | null;
  origin: 'customer-c' | 'placeholder';
  verified: boolean;
  notes?: string;
}

/** UI 下拉数据源：注册表里的具名算法 + 服务库里的可编辑算法，统一成一种描述 */
export interface KeyAlgorithmDescriptor extends PortedAlgorithm {
  provider: 'ported' | 'constant' | 'expression' | 'javascript';
  /** 服务库 spec id；`ported` 为 null（源码不在 JSON 里） */
  specId: string | null;
}

/* ─────────────── 测试向量校准（§3.9.2）─────────────── */

export interface KeyTestVector {
  id: string;
  level: number;
  /** 大写、单空格分隔 */
  seedHex: string;
  expectedKeyHex: string;
  source?: string;
  note?: string;
}

export interface KeyVectorsFile {
  schemaVersion: '1.0';
  /** 算法 id → 绑定的向量 id 列表 */
  bindings: Record<string, string[]>;
  vectors: KeyTestVector[];
}

export interface VerifyReport {
  algorithmId: string;
  total: number;
  passed: number;
  failed: number;
  failures: Array<{ vectorId: string; expectedKeyHex: string; actualKeyHex: string }>;
}

/** 0x27 一键解锁结果 */
export interface UnlockResult {
  ok: boolean;
  level: number;
  algorithmId: string;
  seedHex: string | null;
  keyHex: string | null;
  nrc: number | null;
  nrcNameZh: string | null;
  errorCode: string | null;
  note: string | null;
}

/** 算法试算结果（UI 与向量期望值同屏对照） */
export interface KeyTrialResult {
  ok: boolean;
  algorithmId: string;
  level: number;
  seedHex: string;
  keyHex: string | null;
  /** 向量表中同 seed 的期望值；无对照为 null */
  expectedKeyHex: string | null;
  /** null = 无对照向量可比对 */
  matched: boolean | null;
  verified: boolean;
  errorCode: string | null;
  messageZh: string | null;
}

/* ─────────────── 服务库顶层（data/uds-library.json）─────────────── */

export interface UdsLibrary {
  schemaVersion: '1.0';
  meta: { name: string; description: string; updatedAt: string };
  /** ★Q2：DoIP 层码表也放库里，可配置 */
  doipTables: {
    routingActivationCodes: CodeEntry[];
    genericHeaderNackCodes: CodeEntry[];
    diagnosticMessageNackCodes: CodeEntry[];
    ackCodes: CodeEntry[];
  };
  nrcTable: NrcEntry[];
  services: ServiceDef[];
  didTable: DidEntry[];
  dtcTable: DtcEntry[];
  keyAlgorithms: KeyAlgorithmSpec[];
  addressing: {
    testerLogicalAddress: string;
    functionalAddress: string;
    aliases: AliasEntry[];
  };
}
