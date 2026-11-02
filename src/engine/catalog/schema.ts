import { SmaltError } from '../errors.js';
import type { ColumnConstraint, ColumnDef, CreateIndexStmt, CreateTableStmt, Expr, FkAction, ForeignKeyClause, IndexedColumn } from '../sql/ast.js';
import { anyNode } from '../sql/ast-util.js';
import { RecordLayout, type StorageType } from '../storage/record.js';
import { Collation, type SqlValue, collationByName, normalizeInt } from '../values.js';

/** Thrown for constraint violations; `code` mirrors SQLite extended result codes. */
export class ConstraintError extends SmaltError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'ConstraintError';
  }
}

export interface ColumnSchema {
  name: string;
  /** Declared type as written (normalized), '' when none. */
  declaredType: string;
  type: StorageType;
  notNull: boolean;
  /** NOT NULL was written (PRAGMA table_info reports this; PRIMARY KEY columns are also enforced NOT NULL). */
  declaredNotNull?: boolean;
  defaultExpr?: Expr;
  collation: Collation;
  /** Part of the PRIMARY KEY. */
  primaryKey: boolean;
  /** INTEGER PRIMARY KEY: this column is the rowid (not stored in the record). */
  rowidAlias: boolean;
}

export interface IndexColumnSchema {
  /** Table column index, or -1 for an expression column. */
  column: number;
  /** The indexed expression when `column` is -1. */
  expr?: Expr;
  desc: boolean;
  collation: Collation;
}

/** Compiled evaluators of an index's expressions / WHERE clause over a row (set up by the database). */
export interface IndexEval {
  /** Per index column: the expression's value for (row, rowid), or null for plain columns. */
  cols: (((row: readonly SqlValue[], rowid: number | bigint) => SqlValue) | null)[];
  /** Partial index: whether the row belongs to the index. */
  where?: (row: readonly SqlValue[], rowid: number | bigint) => boolean;
  /** Table columns the expressions and WHERE read (an UPDATE that changes none of them keeps the entry). */
  deps: number[];
}

export interface IndexSchema {
  name: string;
  table: string;
  rootPage: number;
  columns: IndexColumnSchema[];
  unique: boolean;
  /** 'c' = CREATE INDEX, 'u' = UNIQUE constraint, 'pk' = PRIMARY KEY constraint. */
  origin: 'c' | 'u' | 'pk';
  /** Name given with `CONSTRAINT name` (constraint-backed indexes). */
  constraintName?: string;
  where?: Expr;
  /** Evaluators for expression columns and the partial-index WHERE (absent for plain indexes). */
  eval?: IndexEval;
  /** CREATE INDEX text (undefined for automatic indexes). */
  sql?: string;
  /** Statistics from ANALYZE. */
  stats?: import('../exec/stats.js').IndexStats;
}

export interface TableSchema {
  name: string;
  rootPage: number;
  columns: ColumnSchema[];
  /** Column index of the INTEGER PRIMARY KEY, or -1. */
  rowidAlias: number;
  strict: boolean;
  indexes: IndexSchema[];
  checks: { name?: string; expr: Expr }[];
  foreignKeys: ForeignKeySchema[];
  sql: string;
  layout: RecordLayout;
  /** Default values for record columns, used by RecordReader for old (shorter) records. */
  recordDefaults: SqlValue[];
  /** System tables cannot be modified by user DML. */
  system?: boolean;
  /** Statistics from ANALYZE (absent until analyzed). */
  stats?: import('../exec/stats.js').TableStats;
  /** Set for materialized views: the table holds the view's stored rows. */
  matview?: MatViewInfo;
  /** TEMP table: memory store, not in the persisted catalog, visible to this connection only. */
  temp?: boolean;
  /** Declared AUTOINCREMENT: once the largest rowid is taken, inserts fail instead of picking random rowids. */
  autoincrement?: boolean;
  /**
   * Columnar base table (`WITH (storage = 'columnar')`, M7.3): `rootPage` is the row-format delta
   * store; older rows live in column segments, minus the rowids in the deletion tree.
   */
  columnar?: ColumnarTableInfo;
}

/** Columnar storage: a columnar materialized view or a columnar base table (scanned, zone maps, no indexes). */
export function isColumnar(t: TableSchema): boolean {
  return t.matview?.storage === 'columnar' || t.columnar !== undefined;
}

/** Storage of a columnar base table besides its delta store (roots in smalt_columnar). */
export interface ColumnarTableInfo {
  /** Column store: the table's columns plus a final rowid column. */
  segRoot: number;
  /** Rowids of segment rows that were deleted or moved to the delta by an UPDATE (keys only). */
  delRoot: number;
  /** Reader with its decoded-chunk cache (dropped on rollback and rewrite). */
  store?: import('../storage/columnar.js').ColumnStore;
  /**
   * Exact rows in the delta store and entries in the deletion tree, kept current by the writer
   * (dropped on rollback; recounted when missing). Saves counting both trees after every write.
   */
  counts?: { delta: number; deleted: number };
  /** Bumped on every change to the deletion tree in this connection (cache key of `deleted`). */
  delVersion?: number;
  /**
   * The deleted rowids as a set, valid for `key` (commit counter, `delVersion`, deletion root):
   * scans reuse it instead of reading the deletion tree each time.
   */
  deleted?: { key: string; set: Set<number | bigint> | null };
}

/** A materialized view's definition and refresh state (its rows live in the table's tree). */
export interface MatViewInfo {
  /** CREATE MATERIALIZED VIEW text. */
  sql: string;
  select: import('../sql/ast.js').SelectStmt;
  storage: 'row' | 'columnar';
  /** False after `WITH NO DATA` until the first REFRESH; reading it is an error. */
  populated: boolean;
  /** ISO timestamp of the last refresh, null if never refreshed. */
  refreshedAt: string | null;
  /** Columnar storage: reader (with its decoded-chunk cache) for the current segments; reset on refresh. */
  store?: import('../storage/columnar.js').ColumnStore;
  /** No base table changed since the last refresh (M7.5: queries may be answered from the view). */
  fresh?: boolean;
  /** Base tables the view reads (lower case, through views). */
  deps?: Set<string>;
  /**
   * Refresh policy (M8.1, `WITH (refresh_every = seconds, refresh_on_reconnect = true)`): run by the
   * engine worker as `REFRESH … IF CHANGED`. Parsed from `sql` on first use.
   */
  policy?: { every: number | null; onReconnect: boolean };
  /** The last automatic refresh failed with this message (runtime only). */
  lastRefreshError?: string | null;
}

/** Automatic index name for the n-th (1-based) UNIQUE/PRIMARY KEY constraint of a table. */
export function autoIndexName(table: string, n: number): string {
  return `smalt_autoindex_${table}_${n}`;
}

/**
 * Map a declared column type to a storage type (smaltdb tables are STRICT by default).
 * Uses SQLite's affinity rules so familiar type names work: *INT* -> INTEGER; *CHAR*, *CLOB*,
 * *TEXT* -> TEXT; *BLOB* -> BLOB; *REAL*, *FLOA*, *DOUB* -> REAL; ANY or no type -> ANY;
 * anything else (NUMERIC, DECIMAL, BOOLEAN, DATE, ...) -> NUMERIC.
 */
export function storageTypeFor(declared: string | undefined): StorageType {
  if (!declared) return 'ANY';
  const t = declared.toUpperCase();
  if (t === 'ANY') return 'ANY';
  if (t.includes('INT')) return 'INTEGER';
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT';
  if (t.includes('BLOB')) return 'BLOB';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

const INT_RE = /^\s*[+-]?\d+\s*$/;
const NUM_RE = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
const HEX_RE = /^\s*0[xX][0-9a-fA-F]+\s*$/;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

/** Parse text as a number the way SQLite's numeric affinity does; undefined if not numeric. */
export function textToNumber(s: string): number | bigint | undefined {
  if (INT_RE.test(s)) {
    const b = BigInt(s.trim());
    if (b >= I64_MIN && b <= I64_MAX) return normalizeInt(b);
    return Number(s);
  }
  if (NUM_RE.test(s)) {
    const d = Number(s);
    return Number.isFinite(d) ? d : undefined;
  }
  if (HEX_RE.test(s)) return undefined; // SQLite does not treat hex text as numeric
  return undefined;
}

function typeName(v: SqlValue): string {
  if (v === null) return 'NULL';
  switch (typeof v) {
    case 'number':
      return Number.isSafeInteger(v) ? 'INTEGER' : 'REAL';
    case 'bigint':
      return 'INTEGER';
    case 'string':
      return 'TEXT';
    default:
      return 'BLOB';
  }
}

/**
 * REAL -> TEXT conversion following SQLite's `%!.15g` (falling back to 17 significant digits when
 * 15 do not round-trip): exponent form when exp < -4 or exp >= 15, and always a decimal point.
 */
export function formatReal(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Inf';
  if (x === -Infinity) return '-Inf';
  if (x === 0) return '0.0';
  let s = x.toExponential(14);
  if (Number(s) !== x) s = x.toExponential(16);
  const e = s.indexOf('e');
  const exp = Number(s.slice(e + 1));
  let mant = s.slice(0, e);
  const neg = mant.charCodeAt(0) === 45; // '-'
  if (neg) mant = mant.slice(1);
  let digits = mant.replace('.', '');
  let end = digits.length;
  while (end > 1 && digits.charCodeAt(end - 1) === 48) end--;
  digits = digits.slice(0, end);
  let out: string;
  if (exp < -4 || exp >= 15) {
    out = digits[0] + '.' + (digits.length > 1 ? digits.slice(1) : '0') + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  } else if (exp >= 0) {
    out = digits.length <= exp + 1 ? digits + '0'.repeat(exp + 1 - digits.length) + '.0' : digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
  } else {
    out = '0.' + '0'.repeat(-exp - 1) + digits;
  }
  return neg ? '-' + out : out;
}

/** SQLite's text representation of a value (for CAST AS TEXT, ||, TEXT columns). */
export function valueToText(v: number | bigint, isReal: boolean): string {
  if (typeof v === 'bigint') return v.toString();
  if (isReal || !Number.isSafeInteger(v)) return formatReal(v);
  return String(v);
}

/**
 * Coerce a value for storage in a column (STRICT semantics with SQLite's lossless conversions).
 * `isReal` marks an integral number that is semantically REAL.
 */
export function coerceForColumn(v: SqlValue, col: ColumnSchema, table: string, isReal = false): SqlValue {
  if (v === null) return null;
  switch (col.type) {
    case 'INTEGER': {
      if (typeof v === 'bigint') return v;
      if (typeof v === 'number') {
        if (Number.isSafeInteger(v)) return v;
        // A REAL that converts to int64 losslessly (e.g. 1e17) is stored as INTEGER, like SQLite.
        if (Number.isInteger(v) && Math.abs(v) < 9223372036854775808) return normalizeInt(BigInt(v));
      } else if (typeof v === 'string') {
        const n = textToNumber(v);
        if (n !== undefined && (typeof n === 'bigint' || Number.isSafeInteger(n))) return n;
        if (typeof n === 'number' && Number.isInteger(n) && Math.abs(n) < 9223372036854775808) return normalizeInt(BigInt(n));
      }
      break;
    }
    case 'REAL': {
      if (typeof v === 'number') return v;
      if (typeof v === 'bigint') return Number(v);
      if (typeof v === 'string') {
        const n = textToNumber(v);
        if (n !== undefined) return Number(n);
      }
      break;
    }
    case 'TEXT': {
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'bigint') return valueToText(v, isReal);
      break;
    }
    case 'BLOB':
      if (v instanceof Uint8Array) return v;
      break;
    case 'NUMERIC': {
      if (typeof v === 'string') {
        const n = textToNumber(v);
        return n === undefined ? v : n;
      }
      return v;
    }
    case 'ANY':
      return v;
  }
  throw new ConstraintError(
    'SMALT_CONSTRAINT_DATATYPE',
    `cannot store ${typeName(v)} value in ${col.type} column ${table}.${col.name}`,
  );
}

// ------------------------------------------------------------------ building schemas from DDL

function constraintsOf(c: ColumnConstraint[], kind: ColumnConstraint['kind']): ColumnConstraint[] {
  return c.filter((x) => x.kind === kind);
}

export function findColumn(table: TableSchema, name: string): number {
  const lower = name.toLowerCase();
  for (let i = 0; i < table.columns.length; i++) if (table.columns[i].name.toLowerCase() === lower) return i;
  return -1;
}

function indexedColumnName(ic: IndexedColumn): string {
  if (ic.expr.kind === 'column' && ic.expr.table === undefined) return ic.expr.name;
  if (ic.expr.kind === 'collate' && ic.expr.expr.kind === 'column') return ic.expr.expr.name;
  throw new SmaltError('SMALT_UNSUPPORTED', 'expressions in index definitions are not supported yet');
}

function indexedColumnCollation(ic: IndexedColumn): string | undefined {
  if (ic.collation) return ic.collation;
  if (ic.expr.kind === 'collate') return ic.expr.collation;
  return undefined;
}

function toCollation(name: string | undefined, fallback: Collation): Collation {
  if (name === undefined) return fallback;
  const c = collationByName(name);
  if (c === undefined) throw new SmaltError('SMALT_ERROR', `no such collation sequence: ${name}`);
  return c;
}

/** Index specs implied by a CREATE TABLE (PRIMARY KEY / UNIQUE), in SQLite's numbering order. */
export interface ImplicitIndexSpec {
  origin: 'u' | 'pk';
  columns: IndexColumnSchema[];
  constraintName?: string;
}

/** A FOREIGN KEY constraint (child columns -> parent table columns). */
export interface ForeignKeySchema {
  name?: string;
  /** Child column indexes. */
  columns: number[];
  /** Parent table name as written. */
  table: string;
  /** Parent column names; absent = the parent's primary key. */
  refColumns?: string[];
  onDelete: FkAction;
  onUpdate: FkAction;
  /** Checked at COMMIT (DEFERRABLE INITIALLY DEFERRED). */
  deferrable: boolean;
  /** Declared DEFERRABLE, with either INITIALLY clause. */
  isDeferrable: boolean;
}

/**
 * Build the table schema from a parsed CREATE TABLE. Root pages for the table and its implicit
 * indexes are filled in by the caller.
 */
export function buildTableSchema(
  stmt: CreateTableStmt,
  sql: string,
  rootPage: number,
): { table: TableSchema; implicitIndexes: ImplicitIndexSpec[] } {
  if (stmt.options.withoutRowid) throw new SmaltError('SMALT_UNSUPPORTED', 'WITHOUT ROWID tables are not supported yet');
  if (stmt.options.loose) throw new SmaltError('SMALT_UNSUPPORTED', 'LOOSE tables are not supported yet');
  if (stmt.asSelect) throw new SmaltError('SMALT_UNSUPPORTED', 'CREATE TABLE ... AS SELECT is not supported yet');
  if (stmt.columns.length === 0) throw new SmaltError('SMALT_ERROR', 'a table must have at least one column');

  const columns: ColumnSchema[] = [];
  const seen = new Set<string>();
  for (const def of stmt.columns) {
    const lower = def.name.toLowerCase();
    if (seen.has(lower)) throw new SmaltError('SMALT_ERROR', `duplicate column name: ${def.name}`);
    seen.add(lower);
    const cs = def.constraints;
    if (constraintsOf(cs, 'generated').length) throw new SmaltError('SMALT_UNSUPPORTED', 'generated columns are not supported yet');
    const coll = constraintsOf(cs, 'collate')[0] as { collation: string } | undefined;
    const dflt = constraintsOf(cs, 'default')[0] as { expr: Expr } | undefined;
    columns.push({
      name: def.name,
      declaredType: def.type ?? '',
      type: storageTypeFor(def.type),
      notNull: constraintsOf(cs, 'notNull').length > 0,
      declaredNotNull: constraintsOf(cs, 'notNull').length > 0,
      defaultExpr: dflt?.expr,
      collation: toCollation(coll?.collation, Collation.Binary),
      primaryKey: false,
      rowidAlias: false,
    });
  }

  const implicit: ImplicitIndexSpec[] = [];
  const checks: { name?: string; expr: Expr }[] = [];
  let pkSeen = false;
  let rowidAlias = -1;

  const fks: ForeignKeySchema[] = [];
  let pkName: string | undefined;
  const addPk = (cols: { index: number; desc: boolean; collation?: string }[], name?: string): void => {
    if (pkSeen) throw new SmaltError('SMALT_ERROR', `table "${stmt.name}" has more than one primary key`);
    pkSeen = true;
    pkName = name;
    for (const c of cols) {
      columns[c.index].primaryKey = true;
      columns[c.index].notNull = true;
    }
    // INTEGER PRIMARY KEY (exact type name INTEGER, single column, ASC) aliases the rowid.
    if (cols.length === 1 && columns[cols[0].index].declaredType === 'INTEGER' && !cols[0].desc) {
      rowidAlias = cols[0].index;
      columns[rowidAlias].rowidAlias = true;
      return;
    }
    implicit.push({
      origin: 'pk',
      columns: cols.map((c) => ({ column: c.index, desc: c.desc, collation: toCollation(c.collation, columns[c.index].collation) })),
      constraintName: name,
    });
  };

  // Column constraints first, then table constraints (SQLite numbers autoindexes in this order).
  stmt.columns.forEach((def, i) => {
    for (const c of def.constraints) {
      if (c.kind === 'primaryKey') addPk([{ index: i, desc: c.desc }], c.name);
      else if (c.kind === 'unique') implicit.push({ origin: 'u', columns: [{ column: i, desc: false, collation: columns[i].collation }], constraintName: c.name });
      else if (c.kind === 'check') checks.push({ name: c.name, expr: c.expr });
      else if (c.kind === 'references') fks.push(fkSchema(c.name, [i], c));
    }
  });
  for (const tc of stmt.constraints) {
    if (tc.kind === 'primaryKey' || tc.kind === 'unique') {
      const cols = tc.columns.map((ic) => {
        const name = indexedColumnName(ic);
        const index = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
        if (index < 0) throw new SmaltError('SMALT_ERROR', `no such column: ${name}`);
        return { index, desc: ic.desc, collation: indexedColumnCollation(ic) };
      });
      if (tc.kind === 'primaryKey') addPk(cols, tc.name);
      else implicit.push({ origin: 'u', columns: cols.map((c) => ({ column: c.index, desc: c.desc, collation: toCollation(c.collation, columns[c.index].collation) })), constraintName: tc.name });
    } else if (tc.kind === 'check') {
      checks.push({ name: tc.name, expr: tc.expr });
    } else if (tc.kind === 'foreignKey') {
      const idx = tc.columns.map((name) => {
        const index = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
        if (index < 0) throw new SmaltError('SMALT_ERROR', `unknown column "${name}" in foreign key definition`);
        return index;
      });
      fks.push(fkSchema(tc.name, idx, tc.references));
    }
  }
  // Drop UNIQUE constraints that duplicate the rowid alias (always unique anyway).
  const filtered = implicit.filter((s) => !(s.columns.length === 1 && s.columns[0].column === rowidAlias));

  const types = columns.map((c) => c.type);
  const table: TableSchema = {
    name: stmt.name,
    rootPage,
    columns,
    rowidAlias,
    strict: true,
    indexes: [],
    checks,
    foreignKeys: fks,
    sql,
    layout: new RecordLayout(types),
    // Rows written before ALTER TABLE ADD COLUMN lack the new column: they read its (constant) default.
    recordDefaults: columns.map((c) => literalValue(c.defaultExpr)),
  };
  if (rowidAlias >= 0 && (stmt.columns.some((d) => d.constraints.some((c) => c.kind === 'primaryKey' && c.autoincrement)) || stmt.constraints.some((c) => c.kind === 'primaryKey' && c.autoincrement))) {
    table.autoincrement = true;
  }
  return { table, implicitIndexes: filtered };
}

function fkSchema(name: string | undefined, columns: number[], c: ForeignKeyClause): ForeignKeySchema {
  if (c.columns && c.columns.length !== columns.length) {
    throw new SmaltError('SMALT_ERROR', `number of columns in foreign key does not match the number of columns in the referenced table`);
  }
  return { name, columns, table: c.table, refColumns: c.columns, onDelete: c.onDelete ?? 'NO ACTION', onUpdate: c.onUpdate ?? 'NO ACTION', deferrable: !!c.deferrable, isDeferrable: !!c.isDeferrable };
}

export function buildIndexSchema(stmt: CreateIndexStmt, sql: string, table: TableSchema, rootPage: number): IndexSchema {
  if (stmt.include?.length) throw new SmaltError('SMALT_UNSUPPORTED', 'INCLUDE columns are not supported yet');
  const columns: IndexColumnSchema[] = stmt.columns.map((ic) => {
    const plain = ic.expr.kind === 'column' || (ic.expr.kind === 'collate' && ic.expr.expr.kind === 'column');
    if (!plain) {
      // Expression column; validated and compiled by the database (Database.prepareIndex).
      return { column: -1, expr: ic.expr.kind === 'collate' ? ic.expr.expr : ic.expr, desc: ic.desc, collation: toCollation(indexedColumnCollation(ic), Collation.Binary) };
    }
    const col = (ic.expr.kind === 'collate' ? ic.expr.expr : ic.expr) as { table?: string; name: string };
    if (col.table && col.table.toLowerCase() !== table.name.toLowerCase()) throw new SmaltError('SMALT_ERROR', `no such column: ${col.table}.${col.name}`);
    const name = col.name;
    const index = findColumn(table, name);
    if (index < 0) throw new SmaltError('SMALT_ERROR', `no such column: ${name}`);
    return { column: index, desc: ic.desc, collation: toCollation(indexedColumnCollation(ic), table.columns[index].collation) };
  });
  return { name: stmt.name, table: table.name, rootPage, columns, unique: stmt.unique, origin: 'c', where: stmt.where, sql };
}

/** Value of a constant default (literal, or signed numeric literal); null otherwise. */
export function literalValue(e: Expr | undefined): SqlValue {
  if (!e) return null;
  if (e.kind === 'literal') return e.value;
  if (e.kind === 'unary' && (e.op === '-' || e.op === '+') && e.operand.kind === 'literal') {
    const v = e.operand.value;
    if (typeof v === 'number') return e.op === '-' ? -v : v;
    if (typeof v === 'bigint') return e.op === '-' ? normalizeInt(-v) : v;
  }
  return null;
}

/** Whether a default is constant in SQLite's ALTER TABLE ADD COLUMN sense. */
/**
 * CREATE TABLE only (stored definitions are not re-checked, so existing databases still open):
 * SQLite's rules for DEFAULT and CHECK expressions, and AUTOINCREMENT only on the column that
 * aliases the rowid.
 */
export function checkNewTable(stmt: CreateTableStmt, table: TableSchema): void {
  checkConstraintExprs(
    stmt.columns,
    stmt.constraints.flatMap((c) => (c.kind === 'check' ? [c.expr] : [])),
  );
  const on = stmt.columns.some((d) => d.constraints.some((c) => c.kind === 'primaryKey' && c.autoincrement)) || stmt.constraints.some((c) => c.kind === 'primaryKey' && c.autoincrement);
  if (on && table.rowidAlias < 0) throw new SmaltError('SMALT_ERROR', 'AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY');
}

const isSubquery = (n: Record<string, unknown>): boolean => n.kind === 'subquery' || n.kind === 'exists' || n.kind === 'inSelect';

/** SQLite's parse-time rules for a CHECK expression (`prefix` names the ALTER TABLE context). */
export function checkCheckExpr(e: Expr, prefix = ''): void {
  if (anyNode(e, isSubquery)) throw new SmaltError('SMALT_ERROR', `${prefix}subqueries prohibited in CHECK constraints`);
  if (anyNode(e, (n) => n.kind === 'param')) throw new SmaltError('SMALT_ERROR', `${prefix}parameters prohibited in CHECK constraints`);
}

/** SQLite's parse-time rule for DEFAULT: no subqueries, column references or parameters (functions are allowed). */
export function checkDefaultExpr(column: string, e: Expr): void {
  if (anyNode(e, (n) => isSubquery(n) || n.kind === 'column' || n.kind === 'param')) throw new SmaltError('SMALT_ERROR', `default value of column [${column}] is not constant`);
}

/**
 * CREATE TABLE / ADD COLUMN only (stored definitions are not re-checked, so existing databases
 * still open): DEFAULT and CHECK expressions, in the order they appear, as SQLite checks them.
 */
export function checkConstraintExprs(columns: ColumnDef[], tableChecks: Expr[], checkPrefix = ''): void {
  for (const def of columns) {
    for (const c of def.constraints) {
      if (c.kind === 'default') checkDefaultExpr(def.name, c.expr);
      else if (c.kind === 'check') checkCheckExpr(c.expr, checkPrefix);
    }
  }
  for (const e of tableChecks) checkCheckExpr(e, checkPrefix);
}

export function isConstantDefault(e: Expr): boolean {
  if (e.kind === 'literal') return true;
  return e.kind === 'unary' && (e.op === '-' || e.op === '+') && e.operand.kind === 'literal' && (typeof e.operand.value === 'number' || typeof e.operand.value === 'bigint');
}

