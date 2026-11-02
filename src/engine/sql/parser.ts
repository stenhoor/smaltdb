/**
 * SQL parser: hand-written recursive descent over the token arrays produced by `tokenize`, with
 * precedence climbing for expressions. Produces the node shapes defined in `ast.ts`.
 *
 * Expression precedence (SQLite, loosest first): OR; AND; prefix NOT; `= == != <> IS IN LIKE GLOB
 * MATCH REGEXP BETWEEN ISNULL NOTNULL NOT NULL`; `< <= > >=`; ESCAPE; `& | << >>`; `+ -`;
 * `* / %`; `|| -> ->>`; prefix `~ + -` and postfix COLLATE.
 */
import type * as A from './ast.js';
import { SmaltError } from '../errors.js';
import type { SqlValue } from '../values.js';
import {
  tokenize,
  TK_BLOB,
  TK_EOF,
  TK_FLOAT,
  TK_ID,
  TK_ILLEGAL,
  TK_INT,
  TK_KW,
  TK_NKW,
  TK_OP,
  TK_PARAM,
  TK_QID,
  TK_STRING,
  type TokenValue,
} from './lexer.js';

/** A SQL syntax error, with SQLite-style message plus ` (line L, column C)`. */
export class SqlSyntaxError extends SmaltError {
  /** 0-based source offset of the offending token. */
  readonly position: number;
  /** 1-based line and column (in UTF-16 code units) of `position`. */
  readonly line: number;
  readonly column: number;
  /** The message without the location suffix, e.g. `near "FORM": syntax error`. */
  readonly reason: string;

  constructor(reason: string, sql: string, position: number) {
    let line = 1;
    let lineStart = 0;
    for (let i = 0; i < position && i < sql.length; i++) {
      if (sql.charCodeAt(i) === 0x0a) {
        line++;
        lineStart = i + 1;
      }
    }
    const column = position - lineStart + 1;
    super('SMALT_SYNTAX', `${reason} (line ${line}, column ${column})`);
    this.name = 'SqlSyntaxError';
    this.position = position;
    this.line = line;
    this.column = column;
    this.reason = reason;
  }
}

/** Parse a script of `;`-separated statements. Empty statements are skipped. */
export function parse(sql: string): A.ParsedStatement[] {
  const p = new Parser(sql);
  const out: A.ParsedStatement[] = [];
  for (;;) {
    while (p.acceptOp(';'));
    if (p.atEof()) return out;
    out.push(p.parsedStatement());
    if (!p.atEof() && !p.isOp(';')) p.fail();
  }
}

/** Parse exactly one statement (a trailing `;` is allowed). */
export function parseOne(sql: string): A.ParsedStatement {
  const p = new Parser(sql);
  while (p.acceptOp(';'));
  const st = p.parsedStatement();
  while (p.acceptOp(';'));
  if (!p.atEof()) p.fail();
  return st;
}

/** Parse a standalone expression. */
export function parseExpr(sql: string): A.Expr {
  const p = new Parser(sql);
  const e = p.expr();
  if (!p.atEof()) p.fail();
  return e;
}

// Binding powers.
const P_OR = 1;
const P_AND = 2;
const P_NOT = 3;
const P_EQ = 4;
const P_CMP = 5;
const P_ESCAPE = 6;
const P_BIT = 7;
const P_ADD = 8;
const P_MUL = 9;
const P_CONCAT = 10;
const P_UNARY = 11;

const BIG_INT64_MIN = -(1n << 63n);
const BIG_INT64_MAX = (1n << 63n) - 1n;
const BIG_MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const BIG_MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_VARIABLE_NUMBER = 32766;

function opPrec(op: string): number {
  switch (op) {
    case '||':
    case '->':
    case '->>':
      return P_CONCAT;
    case '*':
    case '/':
    case '%':
      return P_MUL;
    case '+':
    case '-':
      return P_ADD;
    case '&':
    case '|':
    case '<<':
    case '>>':
      return P_BIT;
    case '<':
    case '<=':
    case '>':
    case '>=':
      return P_CMP;
    case '=':
    case '!=':
      return P_EQ;
    default:
      return 0;
  }
}

/** Integer literal value (after an optional unary minus): int64 -> number/bigint, beyond -> REAL. */
function intLiteral(v: number | bigint, negate: boolean, pos: number, end: number): A.LiteralExpr {
  if (typeof v === 'number') return { kind: 'literal', pos, value: negate ? 0 - v : v, isReal: undefined, end };
  const r = negate ? -v : v;
  if (r < BIG_INT64_MIN || r > BIG_INT64_MAX) return { kind: 'literal', pos, value: Number(r), isReal: true, end };
  return { kind: 'literal', pos, value: r >= BIG_MIN_SAFE && r <= BIG_MAX_SAFE ? Number(r) : r, isReal: undefined, end };
}

function isSelectStartKw(kw: string): boolean {
  return kw === 'SELECT' || kw === 'WITH' || kw === 'VALUES';
}

const CONFLICT_ACTIONS: ReadonlySet<string> = new Set(['ROLLBACK', 'ABORT', 'FAIL', 'IGNORE', 'REPLACE']);
/** Keywords that start a statement explainable with `EXPLAIN ANALYZE`. */
const STATEMENT_START: ReadonlySet<string> = new Set(['SELECT', 'VALUES', 'WITH', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE']);
/** Non-reserved keywords that may not be used as an implicit (AS-less) alias. */
const NO_IMPLICIT_ALIAS: ReadonlySet<string> = new Set(['WINDOW', 'WITH']);

class Parser {
  private readonly src: string;
  private readonly kinds: number[];
  private readonly starts: number[];
  private readonly ends: number[];
  private readonly vals: TokenValue[];
  private readonly kws: string[];
  /** Current token index. */
  private p = 0;
  /** Highest parameter slot used in the current statement. */
  private nVar = 0;
  private paramNames = new Map<string, number>();

  constructor(src: string) {
    this.src = src;
    const t = tokenize(src);
    this.kinds = t.kinds;
    this.starts = t.starts;
    this.ends = t.ends;
    this.vals = t.vals;
    this.kws = t.kws;
  }

  // ---------------------------------------------------------------- token helpers

  atEof(): boolean {
    return this.kinds[this.p] === TK_EOF;
  }

  isOp(op: string): boolean {
    return this.kinds[this.p] === TK_OP && this.vals[this.p] === op;
  }

  private isOpAt(i: number, op: string): boolean {
    return this.kinds[i] === TK_OP && this.vals[i] === op;
  }

  acceptOp(op: string): boolean {
    if (this.kinds[this.p] === TK_OP && this.vals[this.p] === op) {
      this.p++;
      return true;
    }
    return false;
  }

  private expectOp(op: string): void {
    if (this.kinds[this.p] === TK_OP && this.vals[this.p] === op) this.p++;
    else this.fail();
  }

  private isKw(kw: string): boolean {
    return this.kws[this.p] === kw;
  }

  private acceptKw(kw: string): boolean {
    if (this.kws[this.p] === kw) {
      this.p++;
      return true;
    }
    return false;
  }

  private expectKw(kw: string): void {
    if (this.kws[this.p] === kw) this.p++;
    else this.fail();
  }

  private pos(): number {
    return this.starts[this.p];
  }

  /** Throw a syntax error at token `at` (default: the current token). */
  fail(at: number = this.p): never {
    const kind = this.kinds[at];
    const start = this.starts[at];
    if (kind === TK_EOF) throw new SqlSyntaxError('incomplete input', this.src, start);
    if (kind === TK_ILLEGAL) throw new SqlSyntaxError(this.vals[at] as string, this.src, start);
    throw new SqlSyntaxError(`near "${this.src.slice(start, this.ends[at])}": syntax error`, this.src, start);
  }

  private error(message: string, at: number = this.p): never {
    throw new SqlSyntaxError(message, this.src, this.starts[at]);
  }

  /** Token `i` can be used as an identifier (plain, quoted, or non-reserved keyword). */
  private isNameAt(i: number): boolean {
    const k = this.kinds[i];
    return k === TK_ID || k === TK_QID || k === TK_NKW;
  }

  /** Consume an identifier. */
  private name(): string {
    const k = this.kinds[this.p];
    if (k === TK_ID || k === TK_QID || k === TK_NKW) return this.vals[this.p++] as string;
    this.fail();
  }

  /** Identifier or string literal (SQLite's `nm`/`ids` in alias and collation positions). */
  private nameOrString(): string {
    if (this.kinds[this.p] === TK_STRING) return this.vals[this.p++] as string;
    return this.name();
  }

  private qualifiedName(): { schema?: string; name: string } {
    const first = this.name();
    if (this.acceptOp('.')) return { schema: first, name: this.name() };
    return { schema: undefined, name: first };
  }

  private nameList(): string[] {
    this.expectOp('(');
    const out = [this.name()];
    while (this.acceptOp(',')) out.push(this.name());
    this.expectOp(')');
    return out;
  }

  /** `[AS] alias` after a result column or FROM item. */
  private optAlias(): string | undefined {
    if (this.acceptKw('AS')) return this.nameOrString();
    const k = this.kinds[this.p];
    if (k === TK_ID || k === TK_QID || k === TK_STRING) return this.vals[this.p++] as string;
    if (k === TK_NKW && !NO_IMPLICIT_ALIAS.has(this.kws[this.p])) return this.vals[this.p++] as string;
    return undefined;
  }

  // ---------------------------------------------------------------- statements

  parsedStatement(): A.ParsedStatement {
    this.nVar = 0;
    this.paramNames = new Map();
    const first = this.p;
    const stmt = this.statement();
    const start = this.starts[first];
    const end = this.ends[this.p - 1];
    // Positions become relative to the statement's own text (what is stored for DDL and used to
    // name result columns), not to the multi-statement source it came from.
    if (start !== 0) rebase(stmt, start);
    return {
      stmt,
      text: this.src.slice(start, end),
      start,
      end,
      paramCount: this.nVar,
      paramNames: this.paramNames,
    };
  }

  private statement(): A.Stmt {
    switch (this.kws[this.p]) {
      case 'SELECT':
      case 'VALUES':
        return this.selectStmt(undefined);
      case 'WITH':
        return this.withStmt();
      case 'INSERT':
      case 'REPLACE':
        return this.insertStmt(undefined);
      case 'UPDATE':
        return this.updateStmt(undefined);
      case 'DELETE':
        return this.deleteStmt(undefined);
      case 'CREATE':
        return this.createStmt();
      case 'DROP':
        return this.dropStmt();
      case 'ALTER':
        return this.alterStmt();
      case 'REFRESH':
        return this.refreshStmt();
      case 'BEGIN':
        return this.beginStmt();
      case 'COMMIT':
      case 'END': {
        const pos = this.pos();
        this.p++;
        if (this.acceptKw('TRANSACTION') && this.isNameAt(this.p)) this.p++;
        return { kind: 'commit', pos, end: this.ends[this.p - 1] };
      }
      case 'ROLLBACK':
        return this.rollbackStmt();
      case 'SAVEPOINT': {
        const pos = this.pos();
        this.p++;
        return { kind: 'savepoint', pos, name: this.name(), end: this.ends[this.p - 1] };
      }
      case 'RELEASE': {
        const pos = this.pos();
        this.p++;
        if (this.isKw('SAVEPOINT') && this.isNameAt(this.p + 1)) this.p++;
        return { kind: 'release', pos, name: this.name(), end: this.ends[this.p - 1] };
      }
      case 'EXPLAIN':
        return this.explainStmt();
      case 'PRAGMA':
        return this.pragmaStmt();
      case 'ANALYZE': {
        const pos = this.pos();
        this.p++;
        let target: string | undefined;
        let schema: string | undefined;
        if (this.isNameAt(this.p)) {
          const q = this.qualifiedName();
          target = q.name;
          schema = q.schema;
        }
        return { kind: 'analyze', pos, target, schema, end: this.ends[this.p - 1] };
      }
      case 'VACUUM': {
        const pos = this.pos();
        this.p++;
        return { kind: 'vacuum', pos, end: this.ends[this.p - 1] };
      }
      default:
        this.fail();
    }
  }

  /** WITH-prefixed SELECT / INSERT / UPDATE / DELETE. */
  private withStmt(): A.Stmt {
    const w = this.withClause();
    switch (this.kws[this.p]) {
      case 'SELECT':
      case 'VALUES':
        return this.selectStmt(w);
      case 'INSERT':
      case 'REPLACE':
        return this.insertStmt(w);
      case 'UPDATE':
        return this.updateStmt(w);
      case 'DELETE':
        return this.deleteStmt(w);
      default:
        this.fail();
    }
  }

  private withClause(): A.WithClause {
    const pos = this.pos();
    this.expectKw('WITH');
    const recursive = this.acceptKw('RECURSIVE');
    const ctes: A.WithClause['ctes'] = [];
    do {
      const name = this.name();
      const columns = this.isOp('(') ? this.nameList() : undefined;
      this.expectKw('AS');
      let materialized: boolean | undefined;
      if (this.acceptKw('MATERIALIZED')) materialized = true;
      else if (this.isKw('NOT')) {
        this.p++;
        this.expectKw('MATERIALIZED');
        materialized = false;
      }
      this.expectOp('(');
      const select = this.selectStmt(undefined);
      this.expectOp(')');
      ctes.push({ name, columns, materialized, select });
    } while (this.acceptOp(','));
    return { pos, recursive, ctes, end: this.ends[this.p - 1] };
  }

  /** Full SELECT (or VALUES) statement; `w` is an already-parsed WITH clause. */
  private selectStmt(w: A.WithClause | undefined): A.SelectStmt {
    if (w === undefined && this.isKw('WITH')) w = this.withClause();
    const pos = w !== undefined ? w.pos : this.pos();
    const core = this.selectCore();
    const compound: A.SelectStmt['compound'] = [];
    for (;;) {
      let op: 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT';
      if (this.acceptKw('UNION')) op = this.acceptKw('ALL') ? 'UNION ALL' : 'UNION';
      else if (this.acceptKw('INTERSECT')) op = 'INTERSECT';
      else if (this.acceptKw('EXCEPT')) op = 'EXCEPT';
      else break;
      compound.push({ op, core: this.selectCore() });
    }
    const orderBy = this.optOrderBy();
    const { limit, offset } = this.optLimit();
    return { kind: 'select', pos, with: w, core, compound, orderBy, limit, offset, end: this.ends[this.p - 1] };
  }

  private selectCore(): A.SelectCore {
    const pos = this.pos();
    if (this.acceptKw('VALUES')) {
      const rows: A.Expr[][] = [];
      do {
        this.expectOp('(');
        rows.push(this.exprList());
        this.expectOp(')');
      } while (this.acceptOp(','));
      return { kind: 'values', pos, rows, end: this.ends[this.p - 1] };
    }
    this.expectKw('SELECT');
    let distinct = false;
    if (this.acceptKw('DISTINCT')) distinct = true;
    else this.acceptKw('ALL');
    const columns = this.resultColumns();
    const from = this.acceptKw('FROM') ? this.fromClause() : undefined;
    const where = this.acceptKw('WHERE') ? this.expr() : undefined;
    let groupBy: A.Expr[] = [];
    if (this.acceptKw('GROUP')) {
      this.expectKw('BY');
      groupBy = this.exprList();
    }
    const having = this.acceptKw('HAVING') ? this.expr() : undefined;
    const windows: A.SelectCoreSelect['windows'] = [];
    if (this.acceptKw('WINDOW')) {
      do {
        const name = this.name();
        this.expectKw('AS');
        windows.push({ name, spec: this.windowSpec() });
      } while (this.acceptOp(','));
    }
    return { kind: 'select', pos, distinct, columns, from, where, groupBy, having, windows, end: this.ends[this.p - 1] };
  }

  private resultColumns(): A.ResultColumn[] {
    const out: A.ResultColumn[] = [];
    do {
      const pos = this.pos();
      if (this.acceptOp('*')) {
        out.push({ kind: 'star', pos, end: this.ends[this.p - 1] });
      } else if (this.isNameAt(this.p) && this.isOpAt(this.p + 1, '.') && this.isOpAt(this.p + 2, '*')) {
        const table = this.vals[this.p] as string;
        this.p += 3;
        out.push({ kind: 'tableStar', pos, table, end: this.ends[this.p - 1] });
      } else {
        const expr = this.expr();
        out.push({ kind: 'expr', pos, expr, alias: this.optAlias(), end: this.ends[this.p - 1] });
      }
    } while (this.acceptOp(','));
    return out;
  }

  private optOrderBy(): A.OrderingTerm[] {
    if (!this.isKw('ORDER')) return [];
    this.p++;
    this.expectKw('BY');
    return this.orderingTerms();
  }

  private orderingTerms(): A.OrderingTerm[] {
    const out: A.OrderingTerm[] = [];
    do {
      const pos = this.pos();
      const expr = this.expr();
      let desc = false;
      if (this.acceptKw('DESC')) desc = true;
      else this.acceptKw('ASC');
      let nulls: 'FIRST' | 'LAST' | undefined;
      if (this.acceptKw('NULLS')) {
        if (this.acceptKw('FIRST')) nulls = 'FIRST';
        else {
          this.expectKw('LAST');
          nulls = 'LAST';
        }
      }
      out.push({ pos, expr, desc, nulls, end: this.ends[this.p - 1] });
    } while (this.acceptOp(','));
    return out;
  }

  /** `LIMIT x [OFFSET y]` or SQLite's `LIMIT y, x`. */
  private optLimit(): { limit?: A.Expr; offset?: A.Expr } {
    if (!this.acceptKw('LIMIT')) return { limit: undefined, offset: undefined };
    const first = this.expr();
    if (this.acceptKw('OFFSET')) return { limit: first, offset: this.expr() };
    if (this.acceptOp(',')) return { limit: this.expr(), offset: first };
    return { limit: first, offset: undefined };
  }

  // ---------------------------------------------------------------- FROM

  private fromClause(): A.FromItem {
    let left = this.tableOrSubquery();
    for (;;) {
      const pos = left.pos;
      if (this.acceptOp(',')) {
        const right = this.tableOrSubquery();
        left = this.joinConstraint({ kind: 'join', pos, joinType: 'CROSS', natural: false, left, right, on: undefined, using: undefined, end: this.ends[this.p - 1] });
        continue;
      }
      const save = this.p;
      const natural = this.acceptKw('NATURAL');
      let joinType: A.JoinType = 'INNER';
      switch (this.kws[this.p]) {
        case 'LEFT':
        case 'RIGHT':
        case 'FULL':
          joinType = this.kws[this.p] as A.JoinType;
          this.p++;
          this.acceptKw('OUTER');
          break;
        case 'INNER':
          this.p++;
          break;
        case 'CROSS':
          joinType = 'CROSS';
          this.p++;
          break;
      }
      if (!this.acceptKw('JOIN')) {
        if (this.p === save) return left;
        this.fail();
      }
      const right = this.tableOrSubquery();
      left = this.joinConstraint({ kind: 'join', pos, joinType, natural, left, right, on: undefined, using: undefined, end: this.ends[this.p - 1] });
    }
  }

  private joinConstraint(j: A.JoinRef): A.JoinRef {
    if (this.isKw('ON') && this.kws[this.p + 1] !== 'CONFLICT') {
      this.p++;
      j.on = this.expr();
    } else if (this.acceptKw('USING')) {
      j.using = this.nameList();
    }
    j.end = this.ends[this.p - 1];
    return j;
  }

  private tableOrSubquery(): A.FromItem {
    const pos = this.pos();
    if (this.isOp('(')) {
      if (isSelectStartKw(this.kws[this.p + 1])) {
        this.p++;
        const select = this.selectStmt(undefined);
        this.expectOp(')');
        return { kind: 'subquery', pos, select, alias: this.optAlias(), end: this.ends[this.p - 1] };
      }
      this.p++;
      const inner = this.fromClause();
      this.expectOp(')');
      if (inner.kind !== 'join') {
        const alias = this.optAlias();
        if (alias !== undefined) inner.alias = alias;
      }
      inner.pos = pos;
      inner.end = this.ends[this.p - 1];
      return inner;
    }
    const q = this.qualifiedName();
    if (this.acceptOp('(')) {
      // Positional arguments, then named ones (`header => false`).
      const args: A.Expr[] = [];
      let named: Record<string, A.Expr> | undefined;
      if (!this.isOp(')')) {
        do {
          if ((this.isNameAt(this.p) || this.kws[this.p]) && this.isOpAt(this.p + 1, '=>')) {
            // Any word names an option, keywords included (`null => 'NA'`).
            const key = String(this.vals[this.p++]).toLowerCase();
            this.p++; // =>
            (named ??= {})[key] = this.expr();
          } else {
            if (named) this.fail(); // positional after named
            args.push(this.expr());
          }
        } while (this.acceptOp(','));
      }
      this.expectOp(')');
      const name = q.schema !== undefined ? `${q.schema}.${q.name}` : q.name;
      const ref: A.FunctionRef = { kind: 'function', pos, name: name.toLowerCase(), args, alias: this.optAlias(), end: this.ends[this.p - 1] };
      if (named) ref.named = named;
      return ref;
    }
    const alias = this.optAlias();
    return { kind: 'table', pos, schema: q.schema, name: q.name, alias, indexedBy: this.optIndexedBy(), end: this.ends[this.p - 1] };
  }

  private optIndexedBy(): string | null | undefined {
    if (this.acceptKw('INDEXED')) {
      this.expectKw('BY');
      return this.name();
    }
    if (this.isKw('NOT') && this.kws[this.p + 1] === 'INDEXED') {
      this.p += 2;
      return null;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- DML

  private conflictAction(): A.ConflictAction {
    const kw = this.kws[this.p];
    if (!CONFLICT_ACTIONS.has(kw)) this.fail();
    this.p++;
    return kw as A.ConflictAction;
  }

  private optOr(): A.ConflictAction | undefined {
    return this.acceptKw('OR') ? this.conflictAction() : undefined;
  }

  private insertStmt(w: A.WithClause | undefined): A.InsertStmt {
    const pos = w !== undefined ? w.pos : this.pos();
    let or: A.ConflictAction | undefined;
    if (this.acceptKw('REPLACE')) or = 'REPLACE';
    else {
      this.expectKw('INSERT');
      or = this.optOr();
    }
    this.expectKw('INTO');
    const q = this.qualifiedName();
    const alias = this.acceptKw('AS') ? this.name() : undefined;
    const columns = this.isOp('(') ? this.nameList() : undefined;
    let source: A.InsertStmt['source'];
    if (this.acceptKw('DEFAULT')) {
      this.expectKw('VALUES');
      source = { kind: 'default' };
    } else {
      const select = this.selectStmt(undefined);
      if (
        select.core.kind === 'values' &&
        select.with === undefined &&
        select.compound.length === 0 &&
        select.orderBy.length === 0 &&
        select.limit === undefined
      ) {
        source = { kind: 'values', rows: select.core.rows };
      } else {
        source = { kind: 'select', select };
      }
    }
    const upsert: A.UpsertClause[] = [];
    // SQLite's grammar has no upsert clause after DEFAULT VALUES.
    while (source.kind !== 'default' && this.isKw('ON') && this.kws[this.p + 1] === 'CONFLICT') upsert.push(this.upsertClause());
    const returning = this.optReturning();
    return { kind: 'insert', pos, with: w, or, schema: q.schema, table: q.name, alias, columns, source, upsert, returning, end: this.ends[this.p - 1] };
  }

  private upsertClause(): A.UpsertClause {
    const pos = this.pos();
    this.p += 2; // ON CONFLICT
    let target: A.UpsertClause['target'];
    if (this.acceptOp('(')) {
      const columns = this.indexedColumns();
      this.expectOp(')');
      target = { columns, where: this.acceptKw('WHERE') ? this.expr() : undefined };
    }
    this.expectKw('DO');
    if (this.acceptKw('NOTHING')) return { pos, target, action: { kind: 'nothing' }, end: this.ends[this.p - 1] };
    this.expectKw('UPDATE');
    this.expectKw('SET');
    const set = this.setClauses();
    const where = this.acceptKw('WHERE') ? this.expr() : undefined;
    return { pos, target, action: { kind: 'update', set, where }, end: this.ends[this.p - 1] };
  }

  private setClauses(): A.SetClause[] {
    const out: A.SetClause[] = [];
    do {
      const pos = this.pos();
      const columns = this.isOp('(') ? this.nameList() : [this.name()];
      this.expectOp('=');
      out.push({ pos, columns, value: this.expr(), end: this.ends[this.p - 1] });
    } while (this.acceptOp(','));
    return out;
  }

  private optReturning(): A.ResultColumn[] | undefined {
    return this.acceptKw('RETURNING') ? this.resultColumns() : undefined;
  }

  private updateStmt(w: A.WithClause | undefined): A.UpdateStmt {
    const pos = w !== undefined ? w.pos : this.pos();
    this.expectKw('UPDATE');
    const or = this.optOr();
    const q = this.qualifiedName();
    const alias = this.acceptKw('AS') ? this.name() : undefined;
    const indexedBy = this.optIndexedBy();
    this.expectKw('SET');
    const set = this.setClauses();
    const from = this.acceptKw('FROM') ? this.fromClause() : undefined;
    const where = this.acceptKw('WHERE') ? this.expr() : undefined;
    const returning = this.optReturning();
    const orderBy = this.optOrderBy();
    const { limit, offset } = this.optLimit();
    return {
      kind: 'update',
      pos,
      with: w,
      or,
      schema: q.schema,
      table: q.name,
      alias,
      set,
      from,
      where,
      returning,
      orderBy,
      limit,
      offset,
      indexedBy,
      end: this.ends[this.p - 1],
    };
  }

  private deleteStmt(w: A.WithClause | undefined): A.DeleteStmt {
    const pos = w !== undefined ? w.pos : this.pos();
    this.expectKw('DELETE');
    this.expectKw('FROM');
    const q = this.qualifiedName();
    const alias = this.acceptKw('AS') ? this.name() : undefined;
    const indexedBy = this.optIndexedBy();
    const where = this.acceptKw('WHERE') ? this.expr() : undefined;
    const returning = this.optReturning();
    const orderBy = this.optOrderBy();
    const { limit, offset } = this.optLimit();
    return { kind: 'delete', pos, with: w, schema: q.schema, table: q.name, alias, where, returning, orderBy, limit, offset, indexedBy, end: this.ends[this.p - 1] };
  }

  // ---------------------------------------------------------------- DDL

  private optIfNotExists(): boolean {
    if (this.isKw('IF') && this.kws[this.p + 1] === 'NOT') {
      this.p += 2;
      this.expectKw('EXISTS');
      return true;
    }
    return false;
  }

  private optIfExists(): boolean {
    if (this.isKw('IF') && this.kws[this.p + 1] === 'EXISTS') {
      this.p += 2;
      return true;
    }
    return false;
  }

  private createStmt(): A.Stmt {
    const pos = this.pos();
    this.p++; // CREATE
    const temp = this.acceptKw('TEMP') || this.acceptKw('TEMPORARY');
    switch (this.kws[this.p]) {
      case 'TABLE':
        this.p++;
        return this.createTable(pos, temp);
      case 'VIEW':
        this.p++;
        return this.createView(pos, temp, false);
      case 'MATERIALIZED':
        if (temp) this.fail();
        this.p++;
        this.expectKw('VIEW');
        return this.createView(pos, false, true);
      case 'UNIQUE':
      case 'INDEX': {
        if (temp) this.fail();
        const unique = this.acceptKw('UNIQUE');
        this.expectKw('INDEX');
        return this.createIndex(pos, unique);
      }
      default:
        if (!temp && this.acceptWord('CONNECTION')) return this.createConnection(pos);
        if (!temp && this.acceptWord('EXTERNAL')) {
          this.expectKw('TABLE');
          return this.createExternalTable(pos);
        }
        this.fail();
    }
  }

  private createTable(pos: number, temp: boolean): A.CreateTableStmt {
    const ifNotExists = this.optIfNotExists();
    const q = this.qualifiedName();
    const stmt: A.CreateTableStmt = {
      kind: 'createTable',
      pos,
      temp,
      ifNotExists,
      schema: q.schema,
      name: q.name,
      columns: [],
      constraints: [],
      options: { strict: false, loose: false, withoutRowid: false },
      with: undefined,
      asSelect: undefined,
      end: 0,
    };
    if (this.acceptKw('AS')) {
      stmt.asSelect = this.selectStmt(undefined);
      stmt.end = this.ends[this.p - 1];
      return stmt;
    }
    this.expectOp('(');
    let more = true;
    while (more && !this.isTableConstraintStart()) {
      stmt.columns.push(this.columnDef());
      more = this.acceptOp(',');
    }
    if (more) {
      if (stmt.columns.length === 0) this.fail();
      for (;;) {
        stmt.constraints.push(this.tableConstraint());
        if (this.acceptOp(',') || this.isTableConstraintStart()) continue;
        break;
      }
    }
    this.expectOp(')');
    // Table options: comma-separated STRICT | LOOSE | WITHOUT ROWID | WITH (...)
    for (;;) {
      if (this.acceptKw('STRICT')) stmt.options.strict = true;
      else if (this.acceptKw('LOOSE')) stmt.options.loose = true;
      else if (this.isKw('WITHOUT')) {
        this.p++;
        if (this.kinds[this.p] !== TK_ID || (this.vals[this.p] as string).toUpperCase() !== 'ROWID') this.fail();
        this.p++;
        stmt.options.withoutRowid = true;
      } else if (this.isKw('WITH')) {
        this.p++;
        stmt.with = this.withOptions();
      } else break;
      if (!this.acceptOp(',')) break;
      if (!this.isKw('STRICT') && !this.isKw('LOOSE') && !this.isKw('WITHOUT') && !this.isKw('WITH')) this.fail();
    }
    stmt.end = this.ends[this.p - 1];
    return stmt;
  }

  /** A contextual word (an identifier, not a keyword) such as CONNECTION or EXTERNAL. */
  private acceptWord(word: string): boolean {
    if (this.kinds[this.p] === TK_ID && (this.vals[this.p] as string).toUpperCase() === word) {
      this.p++;
      return true;
    }
    return false;
  }

  /** `CREATE CONNECTION [IF NOT EXISTS] name WITH (options)` (M8). */
  private createConnection(pos: number): A.CreateConnectionStmt {
    const ifNotExists = this.optIfNotExists();
    const name = this.name();
    this.expectKw('WITH');
    const w = this.withOptions();
    return { kind: 'createConnection', pos, ifNotExists, name, with: w, end: this.ends[this.p - 1] };
  }

  /** `CREATE EXTERNAL TABLE [IF NOT EXISTS] name [(column type, …)] WITH (options)` (M8). */
  private createExternalTable(pos: number): A.CreateExternalTableStmt {
    const ifNotExists = this.optIfNotExists();
    const q = this.qualifiedName();
    if (q.schema !== undefined && q.schema.toLowerCase() !== 'main') this.fail();
    const columns: A.ColumnDef[] = [];
    if (this.acceptOp('(')) {
      do columns.push(this.columnDef());
      while (this.acceptOp(','));
      this.expectOp(')');
    }
    this.expectKw('WITH');
    const w = this.withOptions();
    return { kind: 'createExternalTable', pos, ifNotExists, name: q.name, columns, with: w, end: this.ends[this.p - 1] };
  }

  /**
   * smaltdb `( key = literal, ... )` storage options (after WITH). Keys are lower-cased; a key may
   * be a keyword (`null = 'NA'`), as option names are not column names.
   */
  private withOptions(): Record<string, SqlValue> {
    const out: Record<string, SqlValue> = {};
    this.expectOp('(');
    do {
      const key = (this.kinds[this.p] === TK_KW ? this.src.slice(this.starts[this.p], this.ends[this.p++]) : this.name()).toLowerCase();
      this.expectOp('=');
      out[key] = this.optionValue().value;
    } while (this.acceptOp(','));
    this.expectOp(')');
    return out;
  }

  /** Literal option value: signed number, string, blob, NULL/TRUE/FALSE, or identifier/keyword as a string. */
  private optionValue(): A.LiteralExpr {
    const pos = this.pos();
    const lit = this.signedNumber();
    if (lit !== undefined) return lit;
    const k = this.kinds[this.p];
    if (k === TK_STRING || k === TK_BLOB) return { kind: 'literal', pos, value: this.vals[this.p++] as SqlValue, isReal: undefined, end: this.ends[this.p - 1] };
    if (this.kws[this.p] === 'NULL') {
      this.p++;
      return { kind: 'literal', pos, value: null, isReal: undefined, end: this.ends[this.p - 1] };
    }
    if (this.kws[this.p] === 'TRUE' || this.kws[this.p] === 'FALSE') {
      const v = this.kws[this.p] === 'TRUE' ? 1 : 0;
      this.p++;
      return { kind: 'literal', pos, value: v, isReal: undefined, end: this.ends[this.p - 1] };
    }
    if (this.isNameAt(this.p)) return { kind: 'literal', pos, value: this.vals[this.p++] as string, isReal: undefined, end: this.ends[this.p - 1] };
    if (this.kinds[this.p] === TK_KW) {
      // Reserved keywords (e.g. `ON`) as option values become strings.
      return { kind: 'literal', pos, value: this.src.slice(this.starts[this.p], this.ends[this.p++]), isReal: undefined, end: this.ends[this.p - 1] };
    }
    this.fail();
  }

  /** `[+|-] number` as a literal, or undefined if the current token does not start one. */
  private signedNumber(): A.LiteralExpr | undefined {
    const pos = this.pos();
    let negate = false;
    let i = this.p;
    if (this.isOpAt(i, '-')) {
      negate = true;
      i++;
    } else if (this.isOpAt(i, '+')) i++;
    const k = this.kinds[i];
    if (k !== TK_INT && k !== TK_FLOAT) {
      if (i !== this.p) this.fail(i);
      return undefined;
    }
    this.p = i + 1;
    if (k === TK_FLOAT) {
      const v = this.vals[i] as number;
      return { kind: 'literal', pos, value: negate ? -v : v, isReal: true, end: this.ends[this.p - 1] };
    }
    return intLiteral(this.vals[i] as number | bigint, negate, pos, this.ends[i]);
  }

  private isTableConstraintStart(): boolean {
    switch (this.kws[this.p]) {
      case 'CONSTRAINT':
      case 'PRIMARY':
      case 'UNIQUE':
      case 'CHECK':
      case 'FOREIGN':
        return true;
      default:
        return false;
    }
  }

  /** Type name: one or more identifiers plus optional `(n)` / `(n, m)`, normalized. */
  private typeName(): string | undefined {
    let out = '';
    while (this.isNameAt(this.p) && this.kws[this.p] !== 'GENERATED') {
      const word = (this.vals[this.p++] as string).toUpperCase();
      out = out === '' ? word : `${out} ${word}`;
    }
    if (out === '') return undefined;
    if (this.acceptOp('(')) {
      out += '(' + this.typeArg();
      if (this.acceptOp(',')) out += ',' + this.typeArg();
      this.expectOp(')');
      out += ')';
    }
    return out;
  }

  private typeArg(): string {
    const start = this.p;
    if (this.signedNumber() === undefined) this.fail();
    let s = '';
    for (let i = start; i < this.p; i++) s += this.src.slice(this.starts[i], this.ends[i]);
    return s;
  }

  private columnDef(): A.ColumnDef {
    const pos = this.pos();
    const name = this.name();
    const type = this.typeName();
    return { pos, name, type, constraints: this.columnConstraints(), end: this.ends[this.p - 1] };
  }

  private columnConstraints(): A.ColumnConstraint[] {
    const out: A.ColumnConstraint[] = [];
    for (;;) {
      const pos = this.pos();
      let name: string | undefined;
      if (this.acceptKw('CONSTRAINT')) name = this.name();
      const kw = this.kws[this.p];
      switch (kw) {
        case 'PRIMARY': {
          this.p++;
          this.expectKw('KEY');
          let desc = false;
          if (this.acceptKw('DESC')) desc = true;
          else this.acceptKw('ASC');
          const onConflict = this.optConflictClause();
          const autoincrement = this.acceptKw('AUTOINCREMENT');
          out.push({ pos, name, kind: 'primaryKey', desc, autoincrement, onConflict, end: this.ends[this.p - 1] });
          break;
        }
        case 'NOT':
          if (this.kws[this.p + 1] !== 'NULL') this.fail(this.p + 1);
          this.p += 2;
          out.push({ pos, name, kind: 'notNull', onConflict: this.optConflictClause(), end: this.ends[this.p - 1] });
          break;
        case 'NULL':
          this.p++;
          this.optConflictClause();
          out.push({ pos, name, kind: 'null', end: this.ends[this.p - 1] });
          break;
        case 'UNIQUE':
          this.p++;
          out.push({ pos, name, kind: 'unique', onConflict: this.optConflictClause(), end: this.ends[this.p - 1] });
          break;
        case 'CHECK':
          this.p++;
          out.push({ pos, name, kind: 'check', expr: this.parenExpr(), end: this.ends[this.p - 1] });
          break;
        case 'DEFAULT':
          this.p++;
          out.push({ pos, name, kind: 'default', expr: this.defaultValue(), end: this.ends[this.p - 1] });
          break;
        case 'COLLATE':
          this.p++;
          out.push({ pos, name, kind: 'collate', collation: this.nameOrString().toUpperCase(), end: this.ends[this.p - 1] });
          break;
        case 'REFERENCES':
          this.p++;
          out.push({ pos, name, kind: 'references', ...this.foreignKeyClause(), end: this.ends[this.p - 1] });
          break;
        case 'GENERATED':
        case 'AS': {
          if (kw === 'GENERATED') {
            this.p++;
            this.expectKw('ALWAYS');
          }
          this.expectKw('AS');
          const expr = this.parenExpr();
          let stored = false;
          if (this.acceptKw('STORED')) stored = true;
          else this.acceptKw('VIRTUAL');
          out.push({ pos, name, kind: 'generated', expr, stored, end: this.ends[this.p - 1] });
          break;
        }
        default:
          if (name !== undefined) this.fail();
          return out;
      }
    }
  }

  private optConflictClause(): A.ConflictAction | undefined {
    if (this.isKw('ON') && this.kws[this.p + 1] === 'CONFLICT') {
      this.p += 2;
      return this.conflictAction();
    }
    return undefined;
  }

  /** DEFAULT value: literal, signed number, `(expr)`, CURRENT_*, or a bare identifier (as a string). */
  private defaultValue(): A.Expr {
    const pos = this.pos();
    if (this.isOp('(')) return this.parenExpr();
    const num = this.signedNumber();
    if (num !== undefined) return num;
    switch (this.kinds[this.p]) {
      case TK_STRING:
      case TK_BLOB:
        return { kind: 'literal', pos, value: this.vals[this.p++] as SqlValue, isReal: undefined, end: this.ends[this.p - 1] };
      case TK_ID:
      case TK_QID:
      case TK_NKW:
        return { kind: 'literal', pos, value: this.vals[this.p++] as string, isReal: undefined, end: this.ends[this.p - 1] };
    }
    switch (this.kws[this.p]) {
      case 'NULL':
      case 'TRUE':
      case 'FALSE':
      case 'CURRENT_TIME':
      case 'CURRENT_DATE':
      case 'CURRENT_TIMESTAMP':
        return this.primary();
    }
    this.fail();
  }

  private foreignKeyClause(): A.ForeignKeyClause {
    const table = this.name();
    const columns = this.isOp('(') ? this.nameList() : undefined;
    const fk: A.ForeignKeyClause = { table, columns, onDelete: undefined, onUpdate: undefined, deferrable: undefined };
    for (;;) {
      if (this.isKw('ON') && (this.kws[this.p + 1] === 'DELETE' || this.kws[this.p + 1] === 'UPDATE')) {
        const del = this.kws[this.p + 1] === 'DELETE';
        this.p += 2;
        const action = this.fkAction();
        if (del) fk.onDelete = action;
        else fk.onUpdate = action;
      } else if (this.acceptKw('MATCH')) {
        this.name();
      } else break;
    }
    // [NOT] DEFERRABLE [INITIALLY DEFERRED|IMMEDIATE]: deferred only for DEFERRABLE INITIALLY DEFERRED.
    if (this.isKw('DEFERRABLE') || (this.isKw('NOT') && this.kws[this.p + 1] === 'DEFERRABLE')) {
      const not = this.acceptKw('NOT');
      this.p++;
      let deferred = false;
      if (this.acceptKw('INITIALLY')) {
        if (this.acceptKw('DEFERRED')) deferred = true;
        else this.expectKw('IMMEDIATE');
      }
      fk.deferrable = !not && deferred;
    }
    return fk;
  }

  private fkAction(): A.FkAction {
    if (this.acceptKw('SET')) {
      if (this.acceptKw('NULL')) return 'SET NULL';
      this.expectKw('DEFAULT');
      return 'SET DEFAULT';
    }
    if (this.acceptKw('CASCADE')) return 'CASCADE';
    if (this.acceptKw('RESTRICT')) return 'RESTRICT';
    this.expectKw('NO');
    this.expectKw('ACTION');
    return 'NO ACTION';
  }

  private tableConstraint(): A.TableConstraint {
    const pos = this.pos();
    const name = this.acceptKw('CONSTRAINT') ? this.name() : undefined;
    switch (this.kws[this.p]) {
      case 'PRIMARY':
      case 'UNIQUE': {
        const pk = this.kws[this.p] === 'PRIMARY';
        this.p++;
        if (pk) this.expectKw('KEY');
        this.expectOp('(');
        const columns = this.indexedColumns();
        this.expectOp(')');
        const onConflict = this.optConflictClause();
        return pk ? { pos, name, kind: 'primaryKey', columns, onConflict, end: this.ends[this.p - 1] } : { pos, name, kind: 'unique', columns, onConflict, end: this.ends[this.p - 1] };
      }
      case 'CHECK':
        this.p++;
        return { pos, name, kind: 'check', expr: this.parenExpr(), end: this.ends[this.p - 1] };
      case 'FOREIGN': {
        this.p++;
        this.expectKw('KEY');
        const columns = this.nameList();
        this.expectKw('REFERENCES');
        return { pos, name, kind: 'foreignKey', columns, references: this.foreignKeyClause(), end: this.ends[this.p - 1] };
      }
      default:
        this.fail();
    }
  }

  private indexedColumns(): A.IndexedColumn[] {
    const out: A.IndexedColumn[] = [];
    do {
      const pos = this.pos();
      let expr = this.expr();
      let collation: string | undefined;
      if (expr.kind === 'collate') {
        collation = expr.collation;
        expr = expr.expr;
      }
      let desc = false;
      if (this.acceptKw('DESC')) desc = true;
      else this.acceptKw('ASC');
      out.push({ pos, expr, collation, desc, end: this.ends[this.p - 1] });
    } while (this.acceptOp(','));
    return out;
  }

  private createIndex(pos: number, unique: boolean): A.CreateIndexStmt {
    const ifNotExists = this.optIfNotExists();
    const q = this.qualifiedName();
    this.expectKw('ON');
    const table = this.name();
    this.expectOp('(');
    const columns = this.indexedColumns();
    this.expectOp(')');
    const include = this.acceptKw('INCLUDE') ? this.nameList() : undefined;
    const where = this.acceptKw('WHERE') ? this.expr() : undefined;
    return { kind: 'createIndex', pos, unique, ifNotExists, schema: q.schema, name: q.name, table, columns, include, where, end: this.ends[this.p - 1] };
  }

  private createView(pos: number, temp: boolean, materialized: boolean): A.CreateViewStmt {
    const ifNotExists = this.optIfNotExists();
    const q = this.qualifiedName();
    const columns = this.isOp('(') ? this.nameList() : undefined;
    let w: Record<string, SqlValue> | undefined;
    if (materialized && this.acceptKw('WITH')) w = this.withOptions();
    this.expectKw('AS');
    const select = this.selectStmt(undefined);
    const withData = materialized ? this.optWithData() : undefined;
    return { kind: 'createView', pos, temp, materialized, ifNotExists, schema: q.schema, name: q.name, columns, with: w, select, withData, end: this.ends[this.p - 1] };
  }

  private dropStmt(): A.DropStmt {
    const pos = this.pos();
    this.p++; // DROP
    let objectType: A.DropStmt['objectType'];
    switch (this.kws[this.p]) {
      case 'TABLE':
        objectType = 'table';
        break;
      case 'INDEX':
        objectType = 'index';
        break;
      case 'VIEW':
        objectType = 'view';
        break;
      case 'TRIGGER':
        objectType = 'trigger';
        break;
      case 'MATERIALIZED':
        this.p++;
        if (!this.isKw('VIEW')) this.fail();
        objectType = 'materialized view';
        break;
      default:
        if (this.acceptWord('CONNECTION')) {
          objectType = 'connection';
          this.p--; // the shared `this.p++` below steps over it
        } else if (this.acceptWord('EXTERNAL')) {
          if (!this.isKw('TABLE')) this.fail();
          objectType = 'external table';
        } else this.fail();
    }
    this.p++;
    const ifExists = this.optIfExists();
    const q = this.qualifiedName();
    return { kind: 'drop', pos, objectType, ifExists, schema: q.schema, name: q.name, end: this.ends[this.p - 1] };
  }

  private alterStmt(): A.AlterTableStmt {
    const pos = this.pos();
    this.p++; // ALTER
    this.expectKw('TABLE');
    const q = this.qualifiedName();
    let action: A.AlterTableStmt['action'];
    if (this.acceptKw('RENAME')) {
      if (this.acceptKw('TO')) action = { kind: 'renameTable', newName: this.name() };
      else {
        if (this.isKw('COLUMN') && this.kws[this.p + 1] !== 'TO') this.p++;
        const column = this.name();
        this.expectKw('TO');
        action = { kind: 'renameColumn', column, newName: this.name() };
      }
    } else if (this.acceptKw('ADD')) {
      this.acceptKw('COLUMN');
      action = { kind: 'addColumn', column: this.columnDef() };
    } else if (this.acceptKw('DROP')) {
      if (this.isKw('COLUMN') && this.isNameAt(this.p + 1)) this.p++;
      action = { kind: 'dropColumn', column: this.name() };
    } else this.fail();
    return { kind: 'alterTable', pos, schema: q.schema, table: q.name, action, end: this.ends[this.p - 1] };
  }

  private refreshStmt(): A.RefreshStmt {
    const pos = this.pos();
    this.p++; // REFRESH
    this.expectKw('MATERIALIZED');
    this.expectKw('VIEW');
    let concurrently = false;
    if (this.isKw('CONCURRENTLY') && this.isNameAt(this.p + 1)) {
      this.p++;
      concurrently = true;
    }
    const q = this.qualifiedName();
    if (this.acceptKw('CONCURRENTLY')) concurrently = true;
    let ifChanged = false;
    if (this.isKw('IF')) {
      this.p++;
      if (!this.acceptWord('CHANGED')) this.fail();
      ifChanged = true;
    }
    const withData = this.optWithData() ?? true;
    const stmt: A.RefreshStmt = { kind: 'refresh', pos, concurrently, withData, schema: q.schema, name: q.name, end: this.ends[this.p - 1] };
    if (ifChanged) stmt.ifChanged = true;
    return stmt;
  }

  /** Optional `WITH DATA` / `WITH NO DATA` (materialized views); undefined when absent. */
  private optWithData(): boolean | undefined {
    if (!this.isKw('WITH')) return undefined;
    if (this.kws[this.p + 1] === 'DATA') {
      this.p += 2;
      return true;
    }
    if (this.kws[this.p + 1] === 'NO' && this.kws[this.p + 2] === 'DATA') {
      this.p += 3;
      return false;
    }
    return undefined;
  }

  private beginStmt(): A.BeginStmt {
    const pos = this.pos();
    this.p++; // BEGIN
    let mode: A.BeginStmt['mode'];
    const kw = this.kws[this.p];
    if (kw === 'DEFERRED' || kw === 'IMMEDIATE' || kw === 'EXCLUSIVE') {
      mode = kw;
      this.p++;
    }
    if (this.acceptKw('TRANSACTION') && this.isNameAt(this.p)) this.p++;
    return { kind: 'begin', pos, mode, end: this.ends[this.p - 1] };
  }

  private rollbackStmt(): A.RollbackStmt {
    const pos = this.pos();
    this.p++; // ROLLBACK
    if (this.acceptKw('TRANSACTION') && this.isNameAt(this.p)) this.p++;
    let savepoint: string | undefined;
    if (this.acceptKw('TO')) {
      if (this.isKw('SAVEPOINT') && this.isNameAt(this.p + 1)) this.p++;
      savepoint = this.name();
    }
    return { kind: 'rollback', pos, savepoint, end: this.ends[this.p - 1] };
  }

  private explainStmt(): A.ExplainStmt {
    const pos = this.pos();
    this.p++; // EXPLAIN
    let queryPlan = false;
    let analyze = false;
    if (this.isKw('QUERY') && this.kws[this.p + 1] === 'PLAN') {
      this.p += 2;
      queryPlan = true;
    } else if (this.isKw('ANALYZE')) {
      // `EXPLAIN ANALYZE <stmt>` (smaltdb) vs `EXPLAIN ANALYZE [name]` (explain of an ANALYZE statement).
      if (STATEMENT_START.has(this.kws[this.p + 1])) {
        this.p++;
        analyze = true;
      }
    }
    return { kind: 'explain', pos, queryPlan, analyze, stmt: this.statement(), end: this.ends[this.p - 1] };
  }

  private pragmaStmt(): A.PragmaStmt {
    const pos = this.pos();
    this.p++; // PRAGMA
    const q = this.qualifiedName();
    let value: A.Expr | undefined;
    if (this.acceptOp('=')) value = this.optionValue();
    else if (this.acceptOp('(')) {
      value = this.optionValue();
      this.expectOp(')');
    }
    return { kind: 'pragma', pos, schema: q.schema, name: q.name.toLowerCase(), value, end: this.ends[this.p - 1] };
  }

  // ---------------------------------------------------------------- expressions

  expr(): A.Expr {
    return this.exprPrec(P_OR);
  }

  private exprList(): A.Expr[] {
    const out = [this.expr()];
    while (this.acceptOp(',')) out.push(this.expr());
    return out;
  }

  /** `( expr, ... )`, possibly empty. */
  private parenExprList(): A.Expr[] {
    this.expectOp('(');
    if (this.acceptOp(')')) return [];
    const out = this.exprList();
    this.expectOp(')');
    return out;
  }

  private parenExpr(): A.Expr {
    this.expectOp('(');
    const e = this.expr();
    this.expectOp(')');
    return e;
  }

  /** Precedence climbing: parse an expression whose binary operators all bind at least as tightly as `min`. */
  private exprPrec(min: number): A.Expr {
    let left = this.unary();
    for (;;) {
      const kind = this.kinds[this.p];
      if (kind === TK_OP) {
        const op = this.vals[this.p] as string;
        const prec = opPrec(op);
        if (prec === 0 || prec < min) return left;
        this.p++;
        const right = this.exprPrec(prec + 1);
        left = { kind: 'binary', pos: left.pos, op: op as A.BinaryOp, left, right, end: this.ends[this.p - 1] };
        continue;
      }
      const kw = this.kws[this.p];
      if (kw === '') return left;
      switch (kw) {
        case 'OR':
        case 'AND': {
          const prec = kw === 'OR' ? P_OR : P_AND;
          if (prec < min) return left;
          this.p++;
          const right = this.exprPrec(prec + 1);
          left = { kind: 'binary', pos: left.pos, op: kw, left, right, end: this.ends[this.p - 1] };
          continue;
        }
        case 'COLLATE':
          if (P_UNARY < min) return left;
          this.p++;
          left = { kind: 'collate', pos: left.pos, expr: left, collation: this.nameOrString().toUpperCase(), end: this.ends[this.p - 1] };
          continue;
        case 'ISNULL':
        case 'NOTNULL':
          if (P_EQ < min) return left;
          this.p++;
          left = { kind: 'isNull', pos: left.pos, not: kw === 'NOTNULL', expr: left, end: this.ends[this.p - 1] };
          continue;
        case 'NOT': {
          if (P_EQ < min) return left;
          const next = this.kws[this.p + 1];
          if (next === 'NULL') {
            this.p += 2;
            left = { kind: 'isNull', pos: left.pos, not: true, expr: left, end: this.ends[this.p - 1] };
            continue;
          }
          if (next !== 'IN' && next !== 'LIKE' && next !== 'GLOB' && next !== 'MATCH' && next !== 'REGEXP' && next !== 'BETWEEN') {
            return left;
          }
          this.p++;
          left = this.postfixOp(left, true);
          continue;
        }
        case 'IS': {
          if (P_EQ < min) return left;
          this.p++;
          let not = this.acceptKw('NOT');
          if (this.acceptKw('DISTINCT')) {
            this.expectKw('FROM');
            not = !not;
          }
          const right = this.exprPrec(P_EQ + 1);
          if (right.kind === 'literal' && right.value === null) {
            left = { kind: 'isNull', pos: left.pos, not, expr: left, end: this.ends[this.p - 1] };
          } else {
            left = { kind: 'binary', pos: left.pos, op: not ? 'IS NOT' : 'IS', left, right, end: this.ends[this.p - 1] };
          }
          continue;
        }
        case 'IN':
        case 'LIKE':
        case 'GLOB':
        case 'MATCH':
        case 'REGEXP':
        case 'BETWEEN':
          if (P_EQ < min) return left;
          left = this.postfixOp(left, false);
          continue;
        default:
          return left;
      }
    }
  }

  /** IN / LIKE-family / BETWEEN, positioned at the operator keyword (after any NOT). */
  private postfixOp(left: A.Expr, not: boolean): A.Expr {
    const kw = this.kws[this.p];
    this.p++;
    const pos = left.pos;
    if (kw === 'BETWEEN') {
      const low = this.exprPrec(P_CMP);
      this.expectKw('AND');
      const high = this.exprPrec(P_CMP);
      return { kind: 'between', pos, not, expr: left, low, high, end: this.ends[this.p - 1] };
    }
    if (kw === 'IN') {
      if (!this.isOp('(')) {
        // SQLite shorthand: `x IN table` / `x IN schema.table` / `x IN f(args)` means `x IN (SELECT * FROM …)`.
        const tpos = this.pos();
        const q = this.qualifiedName();
        let from: A.FromItem;
        if (this.isOp('(')) {
          this.p++;
          const args: A.Expr[] = [];
          if (!this.isOp(')')) {
            do args.push(this.expr());
            while (this.acceptOp(','));
          }
          this.expectOp(')');
          from = { kind: 'function', pos: tpos, name: q.name, args, end: this.ends[this.p - 1] };
        } else from = { kind: 'table', pos: tpos, schema: q.schema, name: q.name, end: this.ends[this.p - 1] };
        const end = this.ends[this.p - 1];
        const select: A.SelectStmt = {
          kind: 'select',
          pos: tpos,
          core: { kind: 'select', pos: tpos, distinct: false, columns: [{ kind: 'star', pos: tpos, end }], from, groupBy: [], windows: [], end },
          compound: [],
          orderBy: [],
          end,
        };
        return { kind: 'inSelect', pos, not, expr: left, select, end };
      }
      if (isSelectStartKw(this.kws[this.p + 1])) {
        this.p++;
        const select = this.selectStmt(undefined);
        this.expectOp(')');
        return { kind: 'inSelect', pos, not, expr: left, select, end: this.ends[this.p - 1] };
      }
      const list = this.parenExprList();
      return { kind: 'inList', pos, not, expr: left, list, end: this.ends[this.p - 1] };
    }
    const pattern = this.exprPrec(P_CMP);
    const escape = this.acceptKw('ESCAPE') ? this.exprPrec(P_ESCAPE + 1) : undefined;
    return { kind: 'like', pos, op: kw as A.LikeExpr['op'], not, expr: left, pattern, escape, end: this.ends[this.p - 1] };
  }

  private unary(): A.Expr {
    const kind = this.kinds[this.p];
    const pos = this.pos();
    if (kind === TK_OP) {
      const op = this.vals[this.p] as string;
      if (op === '-' || op === '+' || op === '~') {
        this.p++;
        // Fold `-<number>` into the literal (so -9223372036854775808 is an exact int64).
        if (op === '-' && this.kws[this.p + 1] !== 'COLLATE') {
          const k = this.kinds[this.p];
          if (k === TK_INT) return intLiteral(this.vals[this.p] as number | bigint, true, pos, this.ends[this.p++]);
          if (k === TK_FLOAT) return { kind: 'literal', pos, value: -(this.vals[this.p++] as number), isReal: true, end: this.ends[this.p - 1] };
        }
        const operand = this.exprPrec(P_UNARY);
        return { kind: 'unary', pos, op, operand, end: this.ends[this.p - 1] };
      }
    } else if (this.kws[this.p] === 'NOT') {
      this.p++;
      const operandStart = this.pos();
      const operand = this.exprPrec(P_NOT);
      if (operand.kind === 'exists' && !operand.not && operand.pos === operandStart) {
        operand.not = true;
        operand.pos = pos;
        return operand;
      }
      return { kind: 'unary', pos, op: 'NOT', operand, end: this.ends[this.p - 1] };
    }
    return this.primary();
  }

  private primary(): A.Expr {
    const pos = this.pos();
    const i = this.p;
    switch (this.kinds[i]) {
      case TK_INT:
        this.p++;
        return intLiteral(this.vals[i] as number | bigint, false, pos, this.ends[i]);
      case TK_FLOAT:
        this.p++;
        return { kind: 'literal', pos, value: this.vals[i] as number, isReal: true, end: this.ends[this.p - 1] };
      case TK_STRING:
      case TK_BLOB:
        this.p++;
        return { kind: 'literal', pos, value: this.vals[i] as SqlValue, isReal: undefined, end: this.ends[this.p - 1] };
      case TK_PARAM:
        this.p++;
        return this.param(this.vals[i] as string, pos);
      case TK_ID:
      case TK_QID:
      case TK_NKW:
        return this.nameExpr();
      case TK_OP:
        if (this.vals[i] === '(') {
          if (isSelectStartKw(this.kws[i + 1])) {
            this.p++;
            const select = this.selectStmt(undefined);
            this.expectOp(')');
            return { kind: 'subquery', pos, select, end: this.ends[this.p - 1] };
          }
          this.p++;
          const e = this.expr();
          if (this.isOp(',')) this.error('row values are not supported');
          this.expectOp(')');
          // The span of a parenthesized expression includes its parentheses.
          e.pos = pos;
          e.end = this.ends[this.p - 1];
          return e;
        }
        this.fail();
    }
    switch (this.kws[i]) {
      case 'NULL':
        this.p++;
        return { kind: 'literal', pos, value: null, isReal: undefined, end: this.ends[this.p - 1] };
      case 'TRUE':
        this.p++;
        return { kind: 'literal', pos, value: 1, isReal: undefined, end: this.ends[this.p - 1] };
      case 'FALSE':
        this.p++;
        return { kind: 'literal', pos, value: 0, isReal: undefined, end: this.ends[this.p - 1] };
      case 'CURRENT_TIME':
      case 'CURRENT_DATE':
      case 'CURRENT_TIMESTAMP':
        this.p++;
        return { kind: 'call', pos, name: this.kws[i].toLowerCase(), args: [], star: false, distinct: false, filter: undefined, over: undefined, orderBy: undefined, end: this.ends[this.p - 1] };
      case 'CAST': {
        this.p++;
        this.expectOp('(');
        const expr = this.expr();
        this.expectKw('AS');
        const type = this.typeName();
        if (type === undefined) this.fail();
        this.expectOp(')');
        return { kind: 'cast', pos, expr, type, end: this.ends[this.p - 1] };
      }
      case 'CASE':
        return this.caseExpr();
      case 'EXISTS': {
        this.p++;
        this.expectOp('(');
        const select = this.selectStmt(undefined);
        this.expectOp(')');
        return { kind: 'exists', pos, not: false, select, end: this.ends[this.p - 1] };
      }
      case 'LIKE':
      case 'GLOB':
        // like(x, y) / glob(x, y) function forms
        if (this.isOpAt(i + 1, '(')) return this.nameExpr();
    }
    this.fail();
  }

  private param(text: string, pos: number): A.ParamExpr {
    if (text.length === 1) return { kind: 'param', pos, index: ++this.nVar, name: undefined, end: this.ends[this.p - 1] };
    if (text.charCodeAt(0) === 0x3f) {
      const n = text.length > 6 ? Infinity : Number(text.slice(1));
      if (!(n >= 1 && n <= MAX_VARIABLE_NUMBER)) this.error(`variable number must be between ?1 and ?${MAX_VARIABLE_NUMBER}`, this.p - 1);
      if (n > this.nVar) this.nVar = n;
      return { kind: 'param', pos, index: n, name: undefined, end: this.ends[this.p - 1] };
    }
    let index = this.paramNames.get(text);
    if (index === undefined) {
      index = ++this.nVar;
      this.paramNames.set(text, index);
    }
    return { kind: 'param', pos, index, name: text, end: this.ends[this.p - 1] };
  }

  /** Column reference (`c`, `t.c`, `s.t.c`) or function call. */
  private nameExpr(): A.Expr {
    const pos = this.pos();
    const first = this.vals[this.p++] as string;
    if (this.acceptOp('(')) return this.call(first.toLowerCase(), pos);
    if (!this.acceptOp('.')) return { kind: 'column', pos, schema: undefined, table: undefined, name: first, end: this.ends[this.p - 1] };
    const second = this.name();
    if (!this.acceptOp('.')) return { kind: 'column', pos, schema: undefined, table: first, name: second, end: this.ends[this.p - 1] };
    return { kind: 'column', pos, schema: first, table: second, name: this.name(), end: this.ends[this.p - 1] };
  }

  /** Function call; positioned after `(`. */
  private call(name: string, pos: number): A.CallExpr {
    let star = false;
    let distinct = false;
    let args: A.Expr[] = [];
    let orderBy: A.OrderingTerm[] | undefined;
    if (this.acceptOp('*')) star = true;
    else if (!this.isOp(')')) {
      if (this.acceptKw('DISTINCT')) distinct = true;
      else this.acceptKw('ALL');
      args = this.exprList();
      if (this.isKw('ORDER')) {
        this.p++;
        this.expectKw('BY');
        orderBy = this.orderingTerms();
      }
    }
    this.expectOp(')');
    let filter: A.Expr | undefined;
    if (this.isKw('FILTER') && this.isOpAt(this.p + 1, '(')) {
      this.p += 2;
      this.expectKw('WHERE');
      filter = this.expr();
      this.expectOp(')');
    }
    let over: A.WindowSpec | string | undefined;
    if (this.isKw('OVER')) {
      if (this.isOpAt(this.p + 1, '(')) {
        this.p++;
        over = this.windowSpec();
      } else if (this.isNameAt(this.p + 1)) {
        this.p++;
        over = this.name();
      }
    }
    return { kind: 'call', pos, name, args, star, distinct, filter, over, orderBy, end: this.ends[this.p - 1] };
  }

  /** `( [base] [PARTITION BY ...] [ORDER BY ...] [frame] )` */
  private windowSpec(): A.WindowSpec {
    const pos = this.pos();
    this.expectOp('(');
    let base: string | undefined;
    const kw = this.kws[this.p];
    if (this.isNameAt(this.p) && kw !== 'PARTITION' && kw !== 'ROWS' && kw !== 'RANGE' && kw !== 'GROUPS') {
      base = this.name();
    }
    let partitionBy: A.Expr[] = [];
    if (this.acceptKw('PARTITION')) {
      this.expectKw('BY');
      partitionBy = this.exprList();
    }
    const orderBy = this.optOrderBy();
    let frame: A.WindowSpec['frame'];
    const unit = this.kws[this.p];
    if (unit === 'ROWS' || unit === 'RANGE' || unit === 'GROUPS') {
      this.p++;
      let start: A.FrameBound;
      let end: A.FrameBound | undefined;
      if (this.acceptKw('BETWEEN')) {
        start = this.frameBound();
        this.expectKw('AND');
        end = this.frameBound();
      } else {
        start = this.frameBound();
      }
      let exclude: 'NO OTHERS' | 'CURRENT ROW' | 'GROUP' | 'TIES' | undefined;
      if (this.acceptKw('EXCLUDE')) {
        if (this.acceptKw('NO')) {
          this.expectKw('OTHERS');
          exclude = 'NO OTHERS';
        } else if (this.acceptKw('CURRENT')) {
          this.expectKw('ROW');
          exclude = 'CURRENT ROW';
        } else if (this.acceptKw('GROUP')) exclude = 'GROUP';
        else {
          this.expectKw('TIES');
          exclude = 'TIES';
        }
      }
      frame = { unit, start, end, exclude };
    }
    this.expectOp(')');
    return { pos, base, partitionBy, orderBy, frame, end: this.ends[this.p - 1] };
  }

  private frameBound(): A.FrameBound {
    if (this.isKw('UNBOUNDED')) {
      this.p++;
      if (this.acceptKw('PRECEDING')) return { kind: 'unboundedPreceding' };
      this.expectKw('FOLLOWING');
      return { kind: 'unboundedFollowing' };
    }
    if (this.isKw('CURRENT') && this.kws[this.p + 1] === 'ROW') {
      this.p += 2;
      return { kind: 'currentRow' };
    }
    const offset = this.exprPrec(P_NOT);
    if (this.acceptKw('PRECEDING')) return { kind: 'preceding', offset };
    this.expectKw('FOLLOWING');
    return { kind: 'following', offset };
  }

  private caseExpr(): A.CaseExpr {
    const pos = this.pos();
    this.p++; // CASE
    const base = this.isKw('WHEN') ? undefined : this.expr();
    const whens: A.CaseExpr['whens'] = [];
    while (this.acceptKw('WHEN')) {
      const when = this.expr();
      this.expectKw('THEN');
      whens.push({ when, then: this.expr() });
    }
    if (whens.length === 0) this.fail();
    const elseExpr = this.acceptKw('ELSE') ? this.expr() : undefined;
    this.expectKw('END');
    return { kind: 'case', pos, base, whens, else: elseExpr, end: this.ends[this.p - 1] };
  }
}

/** Subtract `delta` from every `pos`/`end` in an AST (nodes are plain objects and arrays). */
function rebase(node: unknown, delta: number): void {
  if (Array.isArray(node)) {
    for (const x of node) rebase(x, delta);
    return;
  }
  if (typeof node !== 'object' || node === null || Object.getPrototypeOf(node) !== Object.prototype) return;
  const o = node as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if ((k === 'pos' || k === 'end') && typeof v === 'number') o[k] = v - delta;
    else if (typeof v === 'object' && v !== null) rebase(v, delta);
  }
}

