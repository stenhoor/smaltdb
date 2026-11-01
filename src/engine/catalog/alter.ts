/**
 * SQL text rewriting for ALTER TABLE ... RENAME (table or column), like SQLite: the stored CREATE
 * statements of the table, its indexes, other tables' foreign keys and views are edited in place
 * (only the affected identifier tokens change; formatting and comments are kept).
 *
 * Positions come from the AST (statement-relative) and the lexer's token boundaries.
 */
import type { ColumnExpr, Expr, FromItem, OrderingTerm, SelectCore, SelectStmt, Stmt } from '../sql/ast.js';
import { TK_ID, TK_NKW, TK_OP, TK_QID, type Tokens, isReservedKeyword, tokenize } from '../sql/lexer.js';
import { parseOne } from '../sql/parser.js';

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export function applyEdits(sql: string, edits: Edit[]): string {
  const sorted = [...new Map(edits.map((e) => [e.start, e])).values()].sort((a, b) => b.start - a.start);
  let out = sql;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** Quote an identifier when needed (SQLite always quotes renamed tables). */
export function quoteIdent(name: string, always = false): string {
  if (!always && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !isReservedKeyword(name.toUpperCase())) return name;
  return '"' + name.replace(/"/g, '""') + '"';
}

const same = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();
const isIdentTok = (t: Tokens, i: number): boolean => t.kinds[i] === TK_ID || t.kinds[i] === TK_NKW || t.kinds[i] === TK_QID;
const tokName = (t: Tokens, i: number): string => String(t.vals[i]);

/** Index of the first token starting at or after `pos`. */
function tokenAt(t: Tokens, pos: number): number {
  let lo = 0;
  let hi = t.count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t.starts[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the last token ending at or before `end`. */
function tokenBefore(t: Tokens, end: number): number {
  let i = tokenAt(t, end);
  while (i > 0 && t.ends[i - 1] > end) i--;
  return i - 1;
}

const isPlain = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && Object.getPrototypeOf(x) === Object.prototype;

/** Column-name token and (optional) qualifier token of a column reference. */
function columnTokens(t: Tokens, e: ColumnExpr): { name: number; qualifier: number | null } {
  const last = tokenBefore(t, e.end);
  return { name: last, qualifier: e.table ? last - 2 : null };
}

// ------------------------------------------------------------------ scope-aware walk of SELECTs

/** A FROM source: `ref` is how columns qualify it; `table` is set for base tables. */
interface Src {
  ref: string;
  table?: string;
  /** Known column names (lower-case); undefined = unknown (subquery, CTE, function). */
  cols?: Set<string>;
}

export interface SchemaLookup {
  /** Lower-case column names of a base table (undefined if it is not a table). */
  tableColumns(name: string): Set<string> | undefined;
}

interface Visitor {
  /** A table reference in FROM that names a base table (not a CTE). */
  table?(item: FromItem & { kind: 'table' }): void;
  /** A column reference with the source it resolved to (undefined: unresolved/outer/unknown). */
  column?(e: ColumnExpr, src: Src | undefined): void;
}

function walkSelect(s: SelectStmt, outer: Src[][], ctes: Set<string>[], schema: SchemaLookup, v: Visitor): void {
  const scopeCtes = new Set<string>();
  const ctesNow = [scopeCtes, ...ctes];
  if (s.with) {
    for (const c of s.with.ctes) {
      // Recursive CTEs see themselves; ordinary ones see earlier CTEs.
      if (s.with.recursive) scopeCtes.add(c.name.toLowerCase());
      walkSelect(c.select, outer, ctesNow, schema, v);
      scopeCtes.add(c.name.toLowerCase());
    }
  }
  const cores = [s.core, ...s.compound.map((c) => c.core)];
  let first: Src[] = [];
  cores.forEach((core, i) => {
    const srcs = walkCore(core, outer, ctesNow, schema, v);
    if (i === 0) first = srcs;
  });
  // ORDER BY / LIMIT of a simple SELECT see the first core's sources.
  const scope = [first, ...outer];
  for (const t of s.orderBy) walkExpr(t.expr, scope, ctesNow, schema, v);
  if (s.limit) walkExpr(s.limit, scope, ctesNow, schema, v);
  if (s.offset) walkExpr(s.offset, scope, ctesNow, schema, v);
}

function isCte(name: string, ctes: Set<string>[]): boolean {
  return ctes.some((c) => c.has(name.toLowerCase()));
}

function walkCore(core: SelectCore, outer: Src[][], ctes: Set<string>[], schema: SchemaLookup, v: Visitor): Src[] {
  if (core.kind === 'values') {
    for (const row of core.rows) for (const e of row) walkExpr(e, outer, ctes, schema, v);
    return [];
  }
  const srcs: Src[] = [];
  const ons: Expr[] = [];
  const addFrom = (f: FromItem | undefined): void => {
    if (!f) return;
    switch (f.kind) {
      case 'join':
        addFrom(f.left);
        addFrom(f.right);
        if (f.on) ons.push(f.on);
        return;
      case 'table': {
        const schemaOk = !f.schema || f.schema.toLowerCase() === 'main';
        const cte = !f.schema && isCte(f.name, ctes);
        const cols = !cte && schemaOk ? schema.tableColumns(f.name) : undefined;
        if (!cte && schemaOk && cols) v.table?.(f);
        srcs.push({ ref: (f.alias ?? f.name).toLowerCase(), table: !cte && cols ? f.name.toLowerCase() : undefined, cols: cte ? undefined : cols });
        return;
      }
      case 'subquery':
        walkSelect(f.select, outer, ctes, schema, v);
        srcs.push({ ref: (f.alias ?? '').toLowerCase() });
        return;
      case 'function':
        for (const a of f.args) walkExpr(a, outer, ctes, schema, v);
        srcs.push({ ref: (f.alias ?? f.name).toLowerCase() });
        return;
    }
  };
  addFrom(core.from);
  const scope = [srcs, ...outer];
  for (const rc of core.columns) if (rc.kind === 'expr') walkExpr(rc.expr, scope, ctes, schema, v);
  for (const e of [...ons, core.where, ...core.groupBy, core.having]) if (e) walkExpr(e, scope, ctes, schema, v);
  for (const w of core.windows) walkWindow(w.spec, scope, ctes, schema, v);
  return srcs;
}

function walkWindow(spec: { partitionBy: Expr[]; orderBy: OrderingTerm[] }, scope: Src[][], ctes: Set<string>[], schema: SchemaLookup, v: Visitor): void {
  for (const e of spec.partitionBy) walkExpr(e, scope, ctes, schema, v);
  for (const t of spec.orderBy) walkExpr(t.expr, scope, ctes, schema, v);
}

/** Resolve a column reference like SQLite: innermost scope first. */
function resolve(e: ColumnExpr, scope: Src[][]): Src | undefined {
  const name = e.name.toLowerCase();
  for (const level of scope) {
    if (e.table) {
      const hit = level.find((s) => s.ref === e.table!.toLowerCase());
      if (hit) return hit;
      continue;
    }
    const known = level.filter((s) => s.cols?.has(name));
    if (known.length === 1) return known[0];
    if (known.length > 1) return undefined; // ambiguous
    if (level.some((s) => s.cols === undefined)) return undefined; // may belong to an unknown source here
  }
  return undefined;
}

function walkExpr(e: Expr, scope: Src[][], ctes: Set<string>[], schema: SchemaLookup, v: Visitor): void {
  const go = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(go);
    if (!isPlain(x)) return;
    if (x.kind === 'column' && typeof x.name === 'string') {
      v.column?.(x as unknown as ColumnExpr, resolve(x as unknown as ColumnExpr, scope));
      return;
    }
    if (x.kind === 'select' && 'core' in x) {
      walkSelect(x as unknown as SelectStmt, scope, ctes, schema, v);
      return;
    }
    for (const k of Object.keys(x)) go(x[k]);
  };
  go(e);
}

// ------------------------------------------------------------------ rewrites

/** Edits that rename table `oldName` to `newName` inside one stored CREATE statement. */
export function renameTableEdits(sql: string, oldName: string, newName: string, schema: SchemaLookup): Edit[] {
  const stmt = parseOne(sql).stmt as Stmt;
  const t = tokenize(sql);
  const edits: Edit[] = [];
  const quoted = quoteIdent(newName, true);
  const at = (i: number): void => void edits.push({ start: t.starts[i], end: t.ends[i], text: quoted });
  const referencesTable = (from: number, to: number): void => {
    for (let i = tokenAt(t, from); i < t.count && t.starts[i] < to; i++) {
      if (t.kws[i] === 'REFERENCES' && isIdentTok(t, i + 1) && same(tokName(t, i + 1), oldName)) at(i + 1);
    }
  };
  switch (stmt.kind) {
    case 'createTable': {
      if (same(stmt.name, oldName)) {
        const i = nameTokenAfter(t, 'TABLE', oldName);
        if (i >= 0) at(i);
      }
      referencesTable(0, sql.length);
      break;
    }
    case 'createIndex': {
      if (same(stmt.table, oldName)) {
        for (let i = 0; i < t.count; i++) {
          if (t.kws[i] === 'ON' && isIdentTok(t, i + 1) && same(tokName(t, i + 1), oldName)) {
            at(i + 1);
            break;
          }
        }
      }
      break;
    }
    case 'createView': {
      const tableRefs: (FromItem & { kind: 'table' })[] = [];
      walkSelect(stmt.select, [], [], schema, {
        table: (f) => {
          if (same(f.name, oldName)) tableRefs.push(f);
        },
        column: (e, src) => {
          // A qualifier naming the table itself (not an alias) is renamed along with it.
          if (e.table && src?.table === oldName.toLowerCase() && same(e.table, oldName)) {
            const { qualifier } = columnTokens(t, e);
            if (qualifier !== null) at(qualifier);
          }
        },
      });
      for (const f of tableRefs) {
        const i = tokenAt(t, f.pos) + (f.schema ? 2 : 0);
        at(i);
      }
      break;
    }
    default:
      break;
  }
  return edits;
}

function nameTokenAfter(t: Tokens, kw: string, name: string): number {
  for (let i = 0; i < t.count; i++) {
    if (t.kws[i] !== kw) continue;
    for (let j = i + 1; j < t.count; j++) {
      if (isIdentTok(t, j) && same(tokName(t, j), name)) return j;
      if (t.kinds[j] === TK_OP && t.vals[j] === '(') return -1;
    }
  }
  return -1;
}

/**
 * Edits that rename column `oldCol` of table `table` to `newCol` inside one stored CREATE statement
 * (the table itself, an index on it, another table referencing it, or a view).
 */
export function renameColumnEdits(sql: string, table: string, oldCol: string, newCol: string, schema: SchemaLookup): Edit[] {
  const stmt = parseOne(sql).stmt as Stmt;
  const t = tokenize(sql);
  const edits: Edit[] = [];
  // Keep the quoting style of each replaced token ("b c" -> "bc", a -> aa).
  const at = (i: number): void => void edits.push({ start: t.starts[i], end: t.ends[i], text: quoteIdent(newCol, t.kinds[i] === TK_QID) });
  const colRef = (e: ColumnExpr): void => {
    if (!same(e.name, oldCol)) return;
    if (e.table && !same(e.table, table)) return;
    at(columnTokens(t, e).name);
  };
  const exprs = (e: Expr | undefined): void => {
    if (!e) return;
    const go = (x: unknown): void => {
      if (Array.isArray(x)) return x.forEach(go);
      if (!isPlain(x)) return;
      if (x.kind === 'column' && typeof x.name === 'string') return colRef(x as unknown as ColumnExpr);
      for (const k of Object.keys(x)) go(x[k]);
    };
    go(e);
  };
  /** Rename identifiers inside the first parenthesized list at or after token `from`. */
  const listAfter = (from: number, to: number): void => {
    let i = from;
    while (i < t.count && t.starts[i] < to && !(t.kinds[i] === TK_OP && t.vals[i] === '(')) i++;
    for (i++; i < t.count && t.starts[i] < to && !(t.kinds[i] === TK_OP && t.vals[i] === ')'); i++) {
      if (isIdentTok(t, i) && same(tokName(t, i), oldCol)) at(i);
    }
  };
  const referencesColumns = (from: number, to: number): void => {
    for (let i = tokenAt(t, from); i < t.count && t.starts[i] < to; i++) {
      if (t.kws[i] === 'REFERENCES' && isIdentTok(t, i + 1) && same(tokName(t, i + 1), table)) listAfter(i + 2, to);
    }
  };
  switch (stmt.kind) {
    case 'createTable': {
      const own = same(stmt.name, table);
      for (const def of stmt.columns) {
        if (own && same(def.name, oldCol)) at(tokenAt(t, def.pos));
        for (const c of def.constraints) {
          if (own && (c.kind === 'check' || c.kind === 'default' || c.kind === 'generated')) exprs(c.expr);
          if (c.kind === 'references') referencesColumns(c.pos, c.end);
        }
      }
      for (const tc of stmt.constraints) {
        if (own && (tc.kind === 'primaryKey' || tc.kind === 'unique')) for (const ic of tc.columns) exprs(ic.expr);
        if (own && tc.kind === 'check') exprs(tc.expr);
        if (tc.kind === 'foreignKey') {
          if (own) listAfter(tokenAt(t, tc.pos), tc.end);
          referencesColumns(tc.pos, tc.end);
        }
      }
      break;
    }
    case 'createIndex':
      if (same(stmt.table, table)) {
        for (const ic of stmt.columns) exprs(ic.expr);
        exprs(stmt.where);
      }
      break;
    case 'createView':
      walkSelect(stmt.select, [], [], schema, {
        column: (e, src) => {
          if (src?.table === table.toLowerCase() && same(e.name, oldCol)) at(columnTokens(t, e).name);
        },
      });
      break;
    default:
      break;
  }
  return edits;
}
