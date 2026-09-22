import type { TraceEntry } from '@doip/shared';

/**
 * Wireshark 风格过滤表达式（T10）。
 *
 * 支持：
 *   字段：seq / dir / transport / peer / tag / error /
 *         doip.type / doip.sa / doip.ta / doip.nack / doip.ack /
 *         uds.sid / uds.nrc / uds.did / uds.kind
 *   运算：== != > >= < <= contains
 *   逻辑：&& || ! ()
 *   字面量：数字（支持 0x 前缀）、单/双引号字符串
 *
 * ★非法表达式**不静默丢数据**：`compile()` 返回 null，调用方按"未过滤"处理并提示用户。
 */

export type CompiledFilter = (entry: TraceEntry) => boolean;

type Node =
  | { kind: 'cmp'; field: string; op: string; value: string | number }
  | { kind: 'and'; left: Node; right: Node }
  | { kind: 'or'; left: Node; right: Node }
  | { kind: 'not'; operand: Node };

const FIELD_ACCESSORS: Record<string, (e: TraceEntry) => string | number | null> = {
  seq: (e) => e.seq,
  dir: (e) => e.direction,
  transport: (e) => e.transport,
  peer: (e) => e.peer,
  tag: (e) => e.tags.join(','),
  error: (e) => e.errorCode ?? '',
  'doip.type': (e) => e.doip.payloadType,
  'doip.sa': (e) => e.doip.sourceAddress,
  'doip.ta': (e) => e.doip.targetAddress,
  'doip.nack': (e) => e.doip.nackCode,
  'doip.ack': (e) => e.doip.ackCode,
  'doip.length': (e) => e.doip.payloadLength,
  'uds.sid': (e) => e.uds.serviceId,
  'uds.nrc': (e) => e.uds.nrc,
  'uds.did': (e) => e.uds.did,
  'uds.kind': (e) => e.uds.messageKind,
  'uds.sub': (e) => e.uds.subFunction,
};

/** 取字段值；未知字段返回 undefined（编译期即判非法） */
function isKnownField(field: string): boolean {
  return Object.prototype.hasOwnProperty.call(FIELD_ACCESSORS, field);
}

function toComparable(raw: string | number | null): string | number | null {
  return raw === null ? null : raw;
}

function parseLiteral(token: string): string | number | null {
  const t = token.trim();
  if (t === '') return null;
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  if (/^0[xX][0-9a-fA-F]+$/.test(t)) return Number.parseInt(t, 16);
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  return t; // 裸标识符（如 TX / TCP / request）
}

function compare(left: string | number | null, op: string, right: string | number): boolean {
  // ★`null` 字面量：字段为"无值"时也能写 `uds.nrc != null`
  if (typeof right === 'string' && right.toLowerCase() === 'null') {
    if (op === '==') return left === null;
    if (op === '!=') return left !== null;
    return false;
  }
  if (left === null) return false;
  switch (op) {
    case '==':
      return typeof left === 'number' && typeof right === 'number'
        ? left === right
        : String(left).toLowerCase() === String(right).toLowerCase();
    case '!=':
      return typeof left === 'number' && typeof right === 'number'
        ? left !== right
        : String(left).toLowerCase() !== String(right).toLowerCase();
    case 'contains':
      return String(left).toLowerCase().includes(String(right).toLowerCase());
    case '>':
      return Number(left) > Number(right);
    case '>=':
      return Number(left) >= Number(right);
    case '<':
      return Number(left) < Number(right);
    case '<=':
      return Number(left) <= Number(right);
    default:
      return false;
  }
}

/* ─────────────── 词法 / 语法 ─────────────── */

type Token = { type: 'field' | 'op' | 'lit' | 'and' | 'or' | 'not' | 'lparen' | 'rparen'; text: string };

const OP_RE = /^(==|!=|>=|<=|>|<|contains)/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_.]*/;

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let rest = input;
  while (rest.trim() !== '') {
    const s = rest.trimStart();
    if (s.startsWith('(')) {
      tokens.push({ type: 'lparen', text: '(' });
      rest = s.slice(1);
      continue;
    }
    if (s.startsWith(')')) {
      tokens.push({ type: 'rparen', text: ')' });
      rest = s.slice(1);
      continue;
    }
    if (s.startsWith('&&') || s.startsWith('||')) {
      tokens.push({ type: s.startsWith('&&') ? 'and' : 'or', text: s.slice(0, 2) });
      rest = s.slice(2);
      continue;
    }
    if (s.startsWith('!') && !s.startsWith('!=')) {
      tokens.push({ type: 'not', text: '!' });
      rest = s.slice(1);
      continue;
    }
    const op = OP_RE.exec(s);
    if (op !== null) {
      tokens.push({ type: 'op', text: op[1] ?? '' });
      rest = s.slice((op[1] ?? '').length);
      continue;
    }
    const quoted = /^("[^"]*"|'[^']*')/.exec(s);
    if (quoted !== null) {
      tokens.push({ type: 'lit', text: quoted[1] ?? '' });
      rest = s.slice((quoted[1] ?? '').length);
      continue;
    }
    const field = FIELD_RE.exec(s);
    if (field !== null) {
      tokens.push({ type: 'field', text: field[0] });
      rest = s.slice(field[0].length);
      continue;
    }
    const num = /^(0[xX][0-9a-fA-F]+|-?\d+)/.exec(s);
    if (num !== null) {
      tokens.push({ type: 'lit', text: num[1] ?? '' });
      rest = s.slice((num[1] ?? '').length);
      continue;
    }
    // 兜底：裸值（中文标签「周期3E」、TX/TCP/null 等），不含分隔符与运算符
    const bare = /^[^\s()&|!<>=]+/.exec(s);
    if (bare !== null && bare[0].length > 0) {
      tokens.push({ type: 'lit', text: bare[0] });
      rest = s.slice(bare[0].length);
      continue;
    }
    return null; // 无法识别的字符（或无法推进 → 防死循环）
  }
  return tokens;
}

/** 递归下降：or := and ('||' and)* ；and := not ('&&' not)* ；not := '!' primary | primary */
function parse(tokens: Token[]): Node | null {
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const eat = (): Token | undefined => {
    const t = tokens[pos];
    pos += 1;
    return t;
  };

  function parsePrimary(): Node | null {
    const t = peek();
    if (t === undefined) return null;
    if (t.type === 'lparen') {
      eat();
      const inner = parseOr();
      if (inner === null) return null;
      const close = eat();
      if (close === undefined || close.type !== 'rparen') return null;
      return inner;
    }
    if (t.type === 'not') {
      eat();
      const operand = parsePrimary();
      if (operand === null) return null;
      return { kind: 'not', operand };
    }
    if (t.type === 'field') {
      eat();
      const field = t.text;
      if (!isKnownField(field)) return null;
      const opTok = eat();
      if (opTok === undefined || opTok.type !== 'op') return null;
      const litTok = eat();
      if (litTok === undefined) return null;
      // ★值位置允许"裸标识符"：null / TX / TCP / 中文标签（周期3E）都无需引号
      if (litTok.type !== 'lit' && litTok.type !== 'field') return null;
      const value = parseLiteral(litTok.text);
      if (value === null) return null;
      return { kind: 'cmp', field, op: opTok.text, value };
    }
    return null;
  }

  function parseNot(): Node | null {
    return parsePrimary();
  }

  function parseAnd(): Node | null {
    let left = parseNot();
    if (left === null) return null;
    while (peek()?.type === 'and') {
      eat();
      const right = parseNot();
      if (right === null) return null;
      left = { kind: 'and', left, right };
    }
    return left;
  }

  function parseOr(): Node | null {
    let left = parseAnd();
    if (left === null) return null;
    while (peek()?.type === 'or') {
      eat();
      const right = parseAnd();
      if (right === null) return null;
      left = { kind: 'or', left, right };
    }
    return left;
  }

  const ast = parseOr();
  if (ast === null || pos !== tokens.length) return null;
  return ast;
}

function evaluate(node: Node, entry: TraceEntry): boolean {
  switch (node.kind) {
    case 'cmp': {
      const accessor = FIELD_ACCESSORS[node.field];
      if (accessor === undefined) return false;
      return compare(toComparable(accessor(entry)), node.op, node.value);
    }
    case 'and':
      return evaluate(node.left, entry) && evaluate(node.right, entry);
    case 'or':
      return evaluate(node.left, entry) || evaluate(node.right, entry);
    case 'not':
      return !evaluate(node.operand, entry);
    default:
      return true;
  }
}

/**
 * 编译表达式。
 * @returns 谓词函数；表达式为空返回 null（表示"不过滤"）；**语法/字段错误返回 'invalid'**。
 */
export function compileFilter(expr: string): CompiledFilter | null | 'invalid' {
  const trimmed = expr.trim();
  if (trimmed === '') return null;
  const tokens = tokenize(trimmed);
  if (tokens === null || tokens.length === 0) return 'invalid';
  const ast = parse(tokens);
  if (ast === null) return 'invalid';
  return (entry: TraceEntry): boolean => {
    try {
      return evaluate(ast, entry);
    } catch {
      return true; // 求值异常时不静默丢行
    }
  };
}

/** 供 UI 实时校验：true=可解析 */
export function isFilterExprValid(expr: string): boolean {
  const compiled = compileFilter(expr);
  return compiled !== 'invalid';
}

/** 预设 chips（PRD §6.2 C 区） */
export const FILTER_PRESETS: Array<{ label: string; expr: string }> = [
  { label: '仅错误', expr: 'error != ""' },
  { label: '仅 NRC', expr: 'uds.nrc != null' },
  { label: '仅诊断报文', expr: 'doip.type == 0x8001' },
  { label: '隐藏周期 3E', expr: '!tag contains 周期3E' },
  { label: '仅读 DID(0x22)', expr: 'doip.type == 0x8001 && uds.sid == 0x22' },
];
