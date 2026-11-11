import { type ErrorDetails, SmaltError } from '../errors.js';
import { parseDate, parseDatetime, parseTime } from '../../shared/temporal.js';
import { type NestedTypeName, encodeNested } from '../../shared/nested.js';
import type { PlanExpr } from '../plan/expr.js';
import type { ConflictAction as PlanConflict } from '../plan/ops.js';
import type { CheckDef, DefaultDef, ExprDef, FkAction, IndexDef, TableDef } from '../plan/schema.js';
import type { CollationName } from '../plan/types.js';
import { RecordLayout, type StorageType } from '../storage/record.js';
import { realToText } from '../util/fp.js';
import { Collation, type SqlValue, normalizeInt } from '../values.js';

/** A conflict resolution as the writer applies it (upper case, as SQL writes it). */
export type ConflictAction = 'ROLLBACK' | 'ABORT' | 'FAIL' | 'IGNORE' | 'REPLACE';

const upper = (a: PlanConflict | undefined): ConflictAction | undefined => (a === undefined ? undefined : (a.toUpperCase() as ConflictAction));

/** Thrown for constraint violations; `code` mirrors SQLite extended result codes. */
export class ConstraintError extends SmaltError {
  /** Raised under the ROLLBACK conflict resolution: the whole transaction is rolled back. */
  rollback = false;
  constructor(code: string, message: string, details?: ErrorDetails) {
    super(code, message, details);
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
  /** `NOT NULL ON CONFLICT ...`: the resolution when the statement gives none (default ABORT). */
  notNullConflict?: ConflictAction;
  /** DEFAULT: its expression (over no columns), text and constant value. */
  default?: DefaultDef;
  collation: Collation;
  /** Part of the PRIMARY KEY. */
  primaryKey: boolean;
  /** INTEGER PRIMARY KEY: this column is the rowid (not stored in the record). */
  rowidAlias: boolean;
}

export interface IndexColumnSchema {
  /** Table column index, or -1 for an expression column. */
  column: number;
  /** The indexed expression when `column` is -1 (over the table's row). */
  expr?: ExprDef;
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
  /**
   * The expressions as plan expressions over the table's row (column `i` is `#0.i`, the rowid `#0.n`): per index
   * column (null for plain columns), and the WHERE. The planner matches queries against them.
   */
  plan: { cols: (PlanExpr | null)[]; where?: PlanExpr };
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
  /** `UNIQUE / PRIMARY KEY ... ON CONFLICT ...`: the resolution when the statement gives none (default ABORT). */
  onConflict?: ConflictAction;
  /** A partial index's WHERE (over the table's row). */
  where?: ExprDef;
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
  /** `INTEGER PRIMARY KEY ON CONFLICT ...`: the resolution for rowid conflicts when the statement gives none. */
  pkConflict?: ConflictAction;
  strict: boolean;
  indexes: IndexSchema[];
  checks: CheckDef[];
  foreignKeys: ForeignKeySchema[];
  sql: string;
  layout: RecordLayout;
  /** Default values for record columns, used by RecordReader for old (shorter) records. */
  recordDefaults: SqlValue[];
  /** System tables cannot be modified by user DML. */
  system?: boolean;
  /** The language of its source `sql` (absent: SQL). */
  language?: string;
  /** Defined without source text (ADR 0016 section 6): its catalog text describes the definition. */
  described?: boolean;
  /** The language of its expression texts, for a table defined without source text (TableDef.exprLanguage). */
  exprLanguage?: string;
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
  /** The language `sql` is written in. */
  language: string;
  /** Its options (storage, location, refresh policy). */
  options?: Readonly<Record<string, SqlValue>>;
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
  /** The definition bound to a plan for materialized-view matching (runtime only; null if it cannot be bound). */
  plan?: { version: number; plan: import('../plan/ops.js').PlanOp | null };
  /**
   * Refresh policy (M8.1: the view's `refresh_every` and `refresh_on_reconnect` options): run by the engine worker as
   * a refresh that first checks the view's sources. Read from the stored options on first use.
   */
  policy?: { every: number | null; onReconnect: boolean };
  /** The last automatic refresh failed with this message (runtime only). */
  lastRefreshError?: string | null;
}

/** Automatic index name for the n-th (1-based) UNIQUE/PRIMARY KEY constraint of a table. */
export function autoIndexName(table: string, n: number): string {
  return `smalt_autoindex_${table}_${n}`;
}

/** Map a declared column type to a storage type: plan/catalog.ts, where every language reads it. */
export { storageTypeFor } from '../plan/catalog.js';

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

/** SQLite's text form of a REAL (`%!.17g`, shortened when a shorter form round-trips). */
export function formatReal(x: number): string {
  return realToText(x);
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
    case 'DATE':
    case 'TIME':
    case 'DATETIME':
    case 'DURATION': {
      // Days or µs (ADR 0019): an integer, or the text results give (a date, a date and time, a time of day).
      if (typeof v === 'bigint' || (typeof v === 'number' && Number.isSafeInteger(v))) {
        if (col.type !== 'TIME' || (Number(v) >= 0 && Number(v) < 86_400_000_000)) return v;
        break;
      }
      if (typeof v === 'string') {
        const t = col.type === 'DATE' ? parseDate(v) : col.type === 'DATETIME' ? parseDatetime(v) : col.type === 'TIME' ? parseTime(v) : null;
        if (t !== null) return t;
      }
      break;
    }
    case 'BOOLEAN':
      // 0 and 1 only (ADR 0018): a bool's values. A JS boolean (a parameter) is its number.
      if (v === 0 || v === 1 || v === 0n || v === 1n) return Number(v);
      if ((v as unknown) === true || (v as unknown) === false) return v ? 1 : 0;
      break;
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
    case 'LIST':
    case 'STRUCT':
      // A list or struct (ADR 0020): its bytes, or a JS array or object (a parameter) encoded by the declared type.
      if (v instanceof Uint8Array) return v;
      if (typeof v === 'object') {
        try {
          return encodeNested(col.declaredType as NestedTypeName, v, `${table}.${col.name}`);
        } catch (e) {
          throw new ConstraintError('SMALT_CONSTRAINT_DATATYPE', (e as Error).message, { constraint: 'datatype', table, columns: [col.name] });
        }
      }
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
  throw new ConstraintError('SMALT_CONSTRAINT_DATATYPE', `cannot store ${typeName(v)} value in ${col.type} column ${table}.${col.name}`, {
    constraint: 'datatype',
    table,
    columns: [col.name],
  });
}

export function findColumn(table: TableSchema, name: string): number {
  const lower = name.toLowerCase();
  for (let i = 0; i < table.columns.length; i++) if (table.columns[i].name.toLowerCase() === lower) return i;
  return -1;
}

const COLLATIONS: Readonly<Record<CollationName, Collation>> = { binary: Collation.Binary, nocase: Collation.NoCase, rtrim: Collation.RTrim };
const collationOf = (n: CollationName): Collation => COLLATIONS[n];

/** Index specs implied by a CREATE TABLE (PRIMARY KEY / UNIQUE), in SQLite's numbering order. */
export interface ImplicitIndexSpec {
  origin: 'u' | 'pk';
  columns: IndexColumnSchema[];
  constraintName?: string;
  onConflict?: ConflictAction;
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
 * The table schema a table definition gives (plan/schema.ts). Root pages for the table's implicit indexes are filled
 * in by the caller. `sql`: the statement the catalog stores.
 */
export function tableSchemaFromDef(
  def: TableDef,
  sql: string,
  rootPage: number,
): {
  table: TableSchema;
  implicitIndexes: ImplicitIndexSpec[];
  /** Two identical UNIQUE / PRIMARY KEY constraints give different ON CONFLICT actions (an error on CREATE TABLE). */
  conflictingOnConflict: boolean;
} {
  const columns: ColumnSchema[] = def.columns.map((c) => ({
    name: c.name,
    declaredType: c.declaredType,
    type: c.type,
    notNull: c.notNull,
    declaredNotNull: c.notNull,
    notNullConflict: upper(c.notNullConflict),
    default: c.default,
    collation: collationOf(c.collation),
    primaryKey: false,
    rowidAlias: false,
  }));
  const implicit: ImplicitIndexSpec[] = [];
  let rowidAlias = -1;
  let pkConflict: ConflictAction | undefined;
  let autoincrement = false;
  for (const k of def.keys) {
    const cols = k.columns.map((c) => ({ column: c.column, desc: c.desc, collation: collationOf(c.collation) }));
    if (k.kind === 'primaryKey') {
      for (const c of k.columns) {
        columns[c.column].primaryKey = true;
        columns[c.column].notNull = true;
      }
      // INTEGER PRIMARY KEY (exact type name INTEGER, single column, ASC) aliases the rowid.
      if (k.columns.length === 1 && columns[k.columns[0].column].declaredType === 'INTEGER' && !k.columns[0].desc) {
        rowidAlias = k.columns[0].column;
        columns[rowidAlias].rowidAlias = true;
        pkConflict = upper(k.onConflict);
        autoincrement = k.autoincrement === true;
        continue;
      }
    }
    implicit.push({ origin: k.kind === 'primaryKey' ? 'pk' : 'u', columns: cols, constraintName: k.name, onConflict: upper(k.onConflict) });
  }
  // Drop UNIQUE constraints that duplicate the rowid alias (always unique anyway).
  const filtered = implicit.filter((s) => !(s.columns.length === 1 && s.columns[0].column === rowidAlias));
  // SQLite merges identical UNIQUE / PRIMARY KEY constraints into one index, whose ON CONFLICT
  // action is the one given (two different ones are an error). smaltdb keeps one index per
  // constraint (the stored layout), so give all of them the merged action.
  let conflictingOnConflict = false;
  for (let i = 0; i < filtered.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = filtered[j];
      const b = filtered[i];
      if (a.columns.length !== b.columns.length || !a.columns.every((c, k) => c.column === b.columns[k].column && c.collation === b.columns[k].collation)) continue;
      if (a.onConflict !== b.onConflict) {
        if (a.onConflict !== undefined && b.onConflict !== undefined) conflictingOnConflict = true;
        else {
          const merged = a.onConflict ?? b.onConflict;
          for (const x of filtered) if (x.columns.length === a.columns.length && x.columns.every((c, k) => c.column === a.columns[k].column && c.collation === a.columns[k].collation)) x.onConflict = merged;
        }
      }
    }
  }
  const table: TableSchema = {
    name: def.name,
    rootPage,
    columns,
    rowidAlias,
    pkConflict,
    strict: true,
    indexes: [],
    checks: [...def.checks],
    ...(def.exprLanguage !== undefined ? { exprLanguage: def.exprLanguage } : {}),
    foreignKeys: def.foreignKeys.map((f) => ({ ...f, columns: [...f.columns], refColumns: f.refColumns ? [...f.refColumns] : undefined })),
    sql,
    layout: new RecordLayout(columns.map((c) => c.type)),
    // Rows written before ALTER TABLE ADD COLUMN lack the new column: they read its (constant) default.
    recordDefaults: columns.map((c) => c.default?.value ?? null),
  };
  if (autoincrement) table.autoincrement = true;
  return { table, implicitIndexes: filtered, conflictingOnConflict };
}

/** The index schema an index definition gives, on `table`. */
export function indexSchemaFromDef(def: IndexDef, sql: string, table: TableSchema, rootPage: number): IndexSchema {
  const columns: IndexColumnSchema[] = def.columns.map((c) => ({ column: c.column, ...(c.expr ? { expr: c.expr } : {}), desc: c.desc, collation: collationOf(c.collation) }));
  return { name: def.name, table: table.name, rootPage, columns, unique: def.unique, origin: 'c', ...(def.where ? { where: def.where } : {}), sql };
}
