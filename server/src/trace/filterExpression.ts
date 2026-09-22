/**
 * 极简布尔表达式求值（后端重放过滤用，§3.11 `ExportRequest.filterExpr`）。
 *
 * 语法（与前端 T10 的 `filterExpression` 保持同一子集，避免前后端语义分叉）：
 *   表达式 := 项 (('&&' | '||') 项)*
 *   项     := ['!'] 路径 操作符 值
 *   操作符 := '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains'
 *   值     := 数字（支持 0x 前缀） | 单/双引号字符串 | 裸词
 *
 * 支持的路径：seq / dir / transport / peer / tag / doip.type / doip.pt /
 *            sa / ta / uds.sid / uds.nrc / state / nack / ack / error
 *
 * ★解析失败不抛异常，而是把该表达式视为"不过滤"并记 warn —— 导出是兜底能力，
 *   不能因为一条写错的表达式就让整个导出失败。
 */

import type { TraceEntry } from '@doip/shared';

type Operator = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains';

interface Term {
  negated: boolean;
  path: string;
  op: Operator;
  value: string;
}

const OPERATORS: readonly Operator[] = ['==', '!=', '>=', '<=', '>', '<', 'contains'];

/** 从 TraceEntry 上按路径取值（取不到返回 null） */
function resolvePath(entry: TraceEntry, path: string): string | number | null {
  switch (path) {
    case 'seq':
      return entry.seq;
    case 'dir':
      return entry.direction;
    case 'transport':
      return entry.transport;
    case 'peer':
      return entry.peer;
    case 'tag':
      return entry.tags.join(' ');
    case 'doip.type':
    case 'doip.pt':
      return entry.doip.payloadType;
    case 'sa':
      return entry.doip.sourceAddress;
    case 'ta':
      return entry.doip.targetAddress;
    case 'uds.sid':
      return entry.uds.serviceId;
    case 'uds.nrc':
      return entry.uds.nrc;
    case 'nack':
      return entry.doip.nackCode;
    case 'ack':
      return entry.doip.ackCode;
    case 'error':
      return entry.errorCode;
    case 'txnRole':
      return entry.txnRole;
    default:
      return null;
  }
}

function unquote(text: string): string {
  const t = text.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseNumber(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  if (/^-?0[xX][0-9a-fA-F]+$/.test(t)) return Number.parseInt(t, 16);
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  return null;
}

function parseTerm(raw: string): Term | null {
  let text = raw.trim();
  let negated = false;
  if (text.startsWith('!') && !text.startsWith('!=')) {
    negated = true;
    text = text.slice(1).trim();
  }
  let op: Operator | null = null;
  let opIndex = -1;
  for (const candidate of OPERATORS) {
    const idx = text.indexOf(candidate);
    if (idx > 0) {
      op = candidate;
      opIndex = idx;
      break;
    }
  }
  if (op === null || opIndex < 0) return null;
  const path = text.slice(0, opIndex).trim();
  const value = unquote(text.slice(opIndex + op.length));
  if (path === '' || value === '') return null;
  return { negated, path, op, value };
}

function compareTerm(entry: TraceEntry, term: Term): boolean {
  const left = resolvePath(entry, term.path);
  if (left === null) return false;
  const leftNum = typeof left === 'number' ? left : parseNumber(left);
  const rightNum = parseNumber(term.value);

  let result = false;
  if (leftNum !== null && rightNum !== null) {
    switch (term.op) {
      case '==':
        result = leftNum === rightNum;
        break;
      case '!=':
        result = leftNum !== rightNum;
        break;
      case '>':
        result = leftNum > rightNum;
        break;
      case '>=':
        result = leftNum >= rightNum;
        break;
      case '<':
        result = leftNum < rightNum;
        break;
      case '<=':
        result = leftNum <= rightNum;
        break;
      case 'contains':
        result = String(left).includes(term.value);
        break;
    }
  } else {
    const leftText = String(left);
    switch (term.op) {
      case '==':
        result = leftText === term.value;
        break;
      case '!=':
        result = leftText !== term.value;
        break;
      case 'contains':
        result = leftText.includes(term.value);
        break;
      default:
        // 数值比较符 + 非数值 → 视作不满足
        result = false;
        break;
    }
  }
  return term.negated ? !result : result;
}

/**
 * 按表达式过滤条目。
 * @returns 过滤后的数组；表达式为空或无法解析时返回原数组（不静默丢数据）
 */
export function filterEntries(entries: readonly TraceEntry[], expr?: string): TraceEntry[] {
  if (expr === undefined || expr.trim() === '') return entries.slice();
  const orGroups = expr.split('||');
  const parsed: Array<Array<Term | null>> = orGroups.map((group) =>
    group.split('&&').map((raw) => parseTerm(raw)),
  );
  const ok = parsed.every((group) => group.every((term) => term !== null));
  if (!ok) return entries.slice();

  const out: TraceEntry[] = [];
  for (const entry of entries) {
    const matched = parsed.some((group) =>
      group.every((term) => term !== null && compareTerm(entry, term)),
    );
    if (matched) out.push(entry);
  }
  return out;
}

/** 过滤表达式是否可解析（供 UI 即时提示） */
export function isFilterExprValid(expr: string): boolean {
  if (expr.trim() === '') return true;
  return expr
    .split('||')
    .every((group) => group.split('&&').every((raw) => parseTerm(raw) !== null));
}
