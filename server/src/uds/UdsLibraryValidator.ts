/**
 * 服务库校验（§3.5 / T12）。
 *
 * ★用户输入的服务库 JSON 一律当不可信输入：
 *   1) 先用 `JSON.parse` 定位语法错误（带行/列）；
 *   2) 再用 zod 做结构校验，并把 `issue.path` 反查成原始文本的行/列；
 *   3) 最后做语义检查（重复 id / 非法 hex / 短名超长 / 正响应 id 不自洽）。
 *
 * ★任何一条 error 级问题都拒绝入库（绝不写半截库），warn 级只提示不拦截。
 */

import { z } from 'zod';
import { tryParseHex } from '@doip/shared';
import type {
  KeyAlgorithmSpec,
  KeyOp,
  UdsLibrary,
  ValidationIssue,
  ValidationResult,
} from '@doip/shared';

/* ─────────────── JSON 位置索引（把 JSON Pointer 反查为行/列）─────────────── */

export interface JsonPosition {
  line: number;
  column: number;
}

/**
 * 扫描原文，建立 `JSON Pointer → {line, column}` 索引。
 * 语法错误时抛出带位置的错误（由调用方转成 issue）。
 */
export function buildPositionIndex(text: string): Map<string, JsonPosition> {
  const index = new Map<string, JsonPosition>();
  let i = 0;

  const lineColOf = (offset: number): JsonPosition => {
    let line = 1;
    let lastBreak = -1;
    for (let k = 0; k < offset && k < text.length; k += 1) {
      if (text[k] === '\n') {
        line += 1;
        lastBreak = k;
      }
    }
    return { line, column: offset - lastBreak };
  };

  const fail = (msg: string): never => {
    const pos = lineColOf(i);
    const err = new SyntaxError(msg);
    (err as SyntaxError & { position?: JsonPosition }).position = pos;
    throw err;
  };

  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i] ?? '')) i += 1;
  };

  const readString = (): string => {
    if (text[i] !== '"') fail('期望字符串');
    i += 1;
    let out = '';
    while (i < text.length) {
      const ch = text[i] ?? '';
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        return out;
      }
      out += ch;
      i += 1;
    }
    return fail('字符串未闭合');
  };

  const parseValue = (path: string): void => {
    skipWs();
    index.set(path, lineColOf(i));
    const ch = text[i] ?? '';
    if (ch === '{') {
      i += 1;
      skipWs();
      if (text[i] === '}') {
        i += 1;
        return;
      }
      for (;;) {
        skipWs();
        const key = readString();
        skipWs();
        if (text[i] !== ':') fail(`键 "${key}" 后缺少冒号`);
        i += 1;
        parseValue(`${path}/${escapePointer(key)}`);
        skipWs();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === '}') {
          i += 1;
          return;
        }
        fail('对象未闭合或缺少逗号');
      }
    }
    if (ch === '[') {
      i += 1;
      skipWs();
      if (text[i] === ']') {
        i += 1;
        return;
      }
      let idx = 0;
      for (;;) {
        parseValue(`${path}/${idx}`);
        idx += 1;
        skipWs();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === ']') {
          i += 1;
          return;
        }
        fail('数组未闭合或缺少逗号');
      }
    }
    if (ch === '"') {
      readString();
      return;
    }
    // number / true / false / null
    const tok = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    const literal: string | undefined = tok?.[1];
    if (literal === undefined) fail('无法识别的值');
    i += (literal ?? '').length;
  };

  parseValue('');
  return index;
}

function escapePointer(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function pointerOf(path: Array<string | number>): string {
  let out = '';
  for (const seg of path) out += `/${escapePointer(String(seg))}`;
  return out;
}

/** 从 `JSON.parse` 的报错里抽出字符偏移（Node 18+ 形如 "at position 123"） */
function offsetFromSyntaxError(message: string): number | null {
  const matched = /position (\d+)/.exec(message);
  if (matched === null || matched[1] === undefined) return null;
  return Number.parseInt(matched[1], 10);
}

function lineColFromOffset(text: string, offset: number): JsonPosition {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastBreak = -1;
  for (let k = 0; k < clamped; k += 1) {
    if (text[k] === '\n') {
      line += 1;
      lastBreak = k;
    }
  }
  return { line, column: clamped - lastBreak };
}

/* ─────────────── zod schema ─────────────── */

const HEX_CODE_RE = /^(0[xX])?[0-9a-fA-F]{1,4}$/;

const CodeEntrySchema = z.object({
  code: z.string().regex(HEX_CODE_RE, 'code 必须是 1~4 位 hex（如 0x10）'),
  name: z.string().min(1),
  nameZh: z.string().min(1),
  hint: z.string().optional(),
  builtin: z.boolean(),
  severity: z.enum(['error', 'warn', 'info']).optional(),
});

const FormFieldSchema = z.object({
  name: z.string().min(1),
  role: z.enum(['subFunction', 'did', 'data']),
  offset: z.number().int().min(0),
  length: z.number().int().min(-1),
  widget: z.enum(['select', 'didSelect', 'hex', 'number', 'text']),
  optional: z.boolean().optional(),
  endian: z.enum(['big', 'little']).optional(),
  values: z
    .array(z.object({ value: z.string(), name: z.string(), nameZh: z.string() }))
    .optional(),
});

const ServiceDefSchema = z.object({
  id: z.string().regex(HEX_CODE_RE, '服务 id 必须是 hex（如 0x10）'),
  name: z.string().min(1),
  nameZh: z.string().min(1),
  shortEn: z.string().min(1),
  shortZh: z.string().min(1),
  positiveResponseId: z.string().regex(HEX_CODE_RE),
  supportsFunctional: z.boolean(),
  builtin: z.boolean(),
  flow: z.enum(['seedKey', 'none']).optional(),
  keyAlgorithmRef: z.string().optional(),
  enableIn: z.enum(['P0', 'P1']).optional(),
  destructive: z.boolean().optional(),
  form: z.array(FormFieldSchema),
  positiveResponseForm: z.array(FormFieldSchema),
});

const DidEntrySchema = z.object({
  id: z.string().regex(HEX_CODE_RE),
  name: z.string().min(1),
  nameZh: z.string().min(1),
  shortEn: z.string().optional(),
  shortZh: z.string().optional(),
  codec: z.enum(['ascii', 'hex', 'uint8', 'uint16', 'uint32', 'bcd', 'raw']),
  length: z.number().int().positive().optional(),
  builtin: z.boolean(),
});

const DtcEntrySchema = z.object({
  code: z.string().regex(/^[0-9a-fA-F]{6}$/, 'DTC 必须是 6 位 hex'),
  nameZh: z.string().min(1),
  severity: z.enum(['error', 'warn', 'info']).optional(),
  builtin: z.boolean(),
});

const AliasEntrySchema = z.object({
  address: z.string().regex(HEX_CODE_RE),
  alias: z.string().min(1),
  builtin: z.boolean(),
});

const KeyOpSchema: z.ZodType<KeyOp> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('xor'), maskHex: z.string().min(1) }),
  z.object({ op: z.literal('not') }),
  z.object({ op: z.enum(['add', 'sub']), value: z.number().int(), modulo: z.number().int().positive().optional() }),
  z.object({ op: z.enum(['shiftL', 'shiftR']), bits: z.number().int().min(0).max(63) }),
  z.object({ op: z.enum(['rotL', 'rotR']), bits: z.number().int().min(0).max(63) }),
  z.object({ op: z.literal('swapEndian') }),
  z.object({ op: z.literal('reverseBytes') }),
  z.object({ op: z.enum(['bswap16', 'bswap32']) }),
]) as unknown as z.ZodType<KeyOp>;

const KeyAlgorithmSpecSchema: z.ZodType<KeyAlgorithmSpec> = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal('ported'),
    algorithmId: z.string().min(1),
    params: z.record(z.unknown()).optional(),
  }),
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal('constant'),
    params: z.object({ keyHex: z.string().min(1) }),
  }),
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal('expression'),
    params: z.object({
      wordWidth: z.union([z.literal(8), z.literal(16), z.literal(32)]),
      endian: z.enum(['big', 'little']),
      steps: z.array(KeyOpSchema),
    }),
  }),
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    type: z.literal('javascript'),
    source: z.string().min(1),
    params: z.record(z.unknown()).optional(),
  }),
]) as unknown as z.ZodType<KeyAlgorithmSpec>;

const UdsLibrarySchema = z.object({
  schemaVersion: z.literal('1.0'),
  meta: z.object({ name: z.string(), description: z.string(), updatedAt: z.string() }),
  doipTables: z.object({
    routingActivationCodes: z.array(CodeEntrySchema),
    genericHeaderNackCodes: z.array(CodeEntrySchema),
    diagnosticMessageNackCodes: z.array(CodeEntrySchema),
    ackCodes: z.array(CodeEntrySchema),
  }),
  nrcTable: z.array(CodeEntrySchema),
  services: z.array(ServiceDefSchema),
  didTable: z.array(DidEntrySchema),
  dtcTable: z.array(DtcEntrySchema),
  keyAlgorithms: z.array(KeyAlgorithmSpecSchema),
  addressing: z.object({
    testerLogicalAddress: z.string().regex(HEX_CODE_RE),
    functionalAddress: z.string().regex(HEX_CODE_RE),
    aliases: z.array(AliasEntrySchema),
  }),
});

/* ─────────────── 语义检查 ─────────────── */

function hexValue(text: string): number | null {
  const bytes = tryParseHex(text.replace(/^0[xX]/, ''));
  if (bytes === null || bytes.length === 0) return null;
  let value = 0;
  for (const b of bytes) value = (value << 8) | (b & 0xff);
  return value;
}

/** ★B17 口径：这些服务会改变 ECU 状态/数据，发送前必须二次确认 */
export const DESTRUCTIVE_SERVICE_IDS: readonly number[] = [0x11, 0x14, 0x2e, 0x31];

function semanticChecks(library: UdsLibrary, issues: ValidationIssue[]): void {
  const seenServices = new Set<string>();
  library.services.forEach((svc, i) => {
    const key = String(hexValue(svc.id) ?? svc.id);
    if (seenServices.has(key)) {
      issues.push({
        path: `/services/${i}/id`,
        line: 0,
        column: 0,
        messageZh: `服务 id 重复：${svc.id}`,
        severity: 'error',
      });
    }
    seenServices.add(key);

    const sid = hexValue(svc.id);
    if (sid !== null) {
      const expectPositive = sid + 0x40;
      const actual = hexValue(svc.positiveResponseId);
      if (actual !== expectPositive) {
        issues.push({
          path: `/services/${i}/positiveResponseId`,
          line: 0,
          column: 0,
          messageZh: `正响应 id 应为 0x${expectPositive.toString(16).toUpperCase()}（= 请求 id + 0x40）`,
          severity: 'error',
        });
      }
      if (DESTRUCTIVE_SERVICE_IDS.includes(sid) && svc.destructive !== true) {
        svc.destructive = true; // ★强制补标，绝不放任破坏性服务裸发
      }
    } else {
      issues.push({
        path: `/services/${i}/id`,
        line: 0,
        column: 0,
        messageZh: `服务 id 非法：${svc.id}`,
        severity: 'error',
      });
    }

    // ★Q13：短名口径（Trace 列渲染 `DSC(0x10) 诊断会话控制`）
    if (svc.shortEn.length > 5) {
      issues.push({
        path: `/services/${i}/shortEn`,
        line: 0,
        column: 0,
        messageZh: `shortEn "${svc.shortEn}" 超长（≤5 字符）`,
        severity: 'error',
      });
    }
    if (svc.shortZh.length > 6) {
      issues.push({
        path: `/services/${i}/shortZh`,
        line: 0,
        column: 0,
        messageZh: `shortZh "${svc.shortZh}" 超长（≤6 个字）`,
        severity: 'error',
      });
    }
  });

  const checkUnique = (
    items: Array<{ keyOf: () => string; label: string }>,
    basePath: string,
  ): void => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      const key = item.keyOf();
      if (seen.has(key)) {
        issues.push({
          path: `${basePath}/${i}`,
          line: 0,
          column: 0,
          messageZh: `${item.label} 重复：${key}`,
          severity: 'error',
        });
      }
      seen.add(key);
    });
  };

  checkUnique(
    library.nrcTable.map((e) => ({ keyOf: () => String(hexValue(e.code) ?? e.code), label: 'NRC 码' })),
    '/nrcTable',
  );
  checkUnique(
    library.didTable.map((e) => ({ keyOf: () => String(hexValue(e.id) ?? e.id), label: 'DID' })),
    '/didTable',
  );
  checkUnique(
    library.addressing.aliases.map((e) => ({
      keyOf: () => String(hexValue(e.address) ?? e.address),
      label: '地址别名',
    })),
    '/addressing/aliases',
  );
  checkUnique(
    library.keyAlgorithms.map((e) => ({ keyOf: () => e.id, label: 'Key 算法 id' })),
    '/keyAlgorithms',
  );

  library.keyAlgorithms.forEach((algo, i) => {
    if (algo.type === 'constant' && tryParseHex(algo.params.keyHex) === null) {
      issues.push({
        path: `/keyAlgorithms/${i}/params/keyHex`,
        line: 0,
        column: 0,
        messageZh: `常量密钥非法 hex：${algo.params.keyHex}`,
        severity: 'error',
      });
    }
    if (algo.type === 'javascript' && /\b(require|process|child_process|fs|net)\b/.test(algo.source)) {
      issues.push({
        path: `/keyAlgorithms/${i}/source`,
        line: 0,
        column: 0,
        messageZh: 'JS 算法源码出现宿主访问关键字（沙箱内不可用）',
        severity: 'error',
      });
    }
  });

  for (const [name, table] of Object.entries(library.doipTables)) {
    table.forEach((entry, i) => {
      if (hexValue(entry.code) === null) {
        issues.push({
          path: `/doipTables/${name}/${i}/code`,
          line: 0,
          column: 0,
          messageZh: `码值非法 hex：${entry.code}`,
          severity: 'error',
        });
      }
    });
  }
}

/* ─────────────── 对外入口 ─────────────── */

/**
 * 校验服务库。
 * @param input 已解析或待解析的输入（对象或 JSON 文本）
 */
export function validateLibrary(input: unknown | string): ValidationResult {
  const issues: ValidationIssue[] = [];

  let text: string | null = null;
  let value: unknown = input;
  if (typeof input === 'string') {
    text = input;
    try {
      value = JSON.parse(input) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const offset = offsetFromSyntaxError(message);
      const pos = offset === null ? { line: 0, column: 0 } : lineColFromOffset(text, offset);
      issues.push({
        path: '',
        line: pos.line,
        column: pos.column,
        messageZh: `JSON 语法错误（第 ${pos.line} 行第 ${pos.column} 列）：${message}`,
        severity: 'error',
      });
      return { ok: false, issues, library: null };
    }
  }

  const parsed = UdsLibrarySchema.safeParse(value);
  if (!parsed.success) {
    const index = text === null ? null : safePositionIndex(text);
    for (const issue of parsed.error.issues) {
      const pointer = pointerOf(issue.path.map((p) => String(p)));
      const pos = index?.get(pointer) ?? { line: 0, column: 0 };
      issues.push({
        path: pointer,
        line: pos.line,
        column: pos.column,
        messageZh: `${issue.message}${pos.line > 0 ? `（第 ${pos.line} 行第 ${pos.column} 列）` : ''}`,
        severity: 'error',
      });
    }
    return { ok: false, issues, library: null };
  }

  // zod 已保证结构；这里断言成业务类型（避免 zod 推断类型与手写接口重复维护）
  const library = parsed.data as unknown as UdsLibrary;
  semanticChecks(library, issues);

  if (issues.some((i) => i.severity === 'error')) {
    // 行位置补全：语义检查阶段没有原文位置，尽力用索引回填
    if (text !== null) {
      const idx = safePositionIndex(text);
      if (idx !== null) {
        for (const issue of issues) {
          if (issue.line === 0) {
            const pos = idx.get(issue.path);
            if (pos !== undefined) {
              issue.line = pos.line;
              issue.column = pos.column;
            }
          }
        }
      }
    }
    return { ok: false, issues, library: null };
  }

  return { ok: true, issues, library };
}

function safePositionIndex(text: string): Map<string, JsonPosition> | null {
  try {
    return buildPositionIndex(text);
  } catch {
    return null;
  }
}

/** 只做"能否入库"的快速判断（测试与内部使用） */
export function isLibraryValid(input: unknown | string): boolean {
  return validateLibrary(input).ok;
}
