/**
 * Language-neutral catalog storage (ADR 0015 section 6): each object's definition as the engine stores it, versioned,
 * beside its source text and language (the catalog's `sql` column, which `sqlite_schema` shows). Opening a database
 * reads these definitions and parses nothing; views are kept as their language's source and read where they are used.
 *
 * Definitions live in the system table `smalt_definition(name, def, exprs)`, one row per catalog object (keyed like the
 * catalog). `def` is the definition as JSON text, without the fields that have their usual value (a column that may be
 * NULL, BINARY collation, ascending keys, no CHECKs, row storage, …). A table's or index's plan expressions (CHECK,
 * DEFAULT, index columns, partial WHERE) are in `exprs`, a JSON array encoded with their SQL metadata (plan/codec.ts),
 * which the definition refers to by position: opening keeps it as text, and it is decoded where an expression is
 * first used.
 */
import { SmaltError } from '../errors.js';
import { decodeDataJSON, encodeDataJSON, valueFromJSON } from '../plan/codec.js';
import type { PlanExpr } from '../plan/expr.js';
import type { DefaultDef, ExprDef, IndexDef, StorageType, TableDef } from '../plan/schema.js';
import type { SqlValue } from '../values.js';

/** Version of the stored definitions; a file whose definitions are newer is refused. */
export const DEFINITION_VERSION = 1;

/** An object's stored definition, by catalog type. */
export type StoredDef =
  /**
   * `language`: the language of the object's source text (absent: SQL). `described`: the object was defined without
   * source text (ADR 0016 section 6), and its catalog text is the engine's description of the definition.
   */
  | { readonly kind: 'table'; readonly table: TableDef; readonly language?: string; readonly described?: true }
  | { readonly kind: 'index'; readonly index: IndexDef; readonly language?: string; readonly described?: true }
  | { readonly kind: 'view'; readonly language: string; readonly columns?: readonly string[] }
  /** A materialized view; the table its rows are stored in is in `smalt_matview` (its layout). */
  | { readonly kind: 'matview'; readonly language: string; readonly columns?: readonly string[]; readonly options: Readonly<Record<string, SqlValue>> }
  | { readonly kind: 'connection'; readonly options: Readonly<Record<string, SqlValue>>; readonly described?: true }
  | { readonly kind: 'external'; readonly columns: readonly { readonly name: string; readonly declaredType: string }[]; readonly options: Readonly<Record<string, SqlValue>>; readonly language?: string; readonly described?: true };

/** Whether `def` was defined without source text: its catalog text is {@link describeDefinition}'s. */
export function isDescribed(def: StoredDef | undefined): boolean {
  return def !== undefined && 'described' in def && def.described === true;
}

/**
 * The catalog text of an object defined without source text: its definition as JSON, with each expression as its text,
 * in the compact form the catalog stores. It describes the object in no language's syntax.
 */
export function describeDefinition(def: StoredDef): string {
  const text = (e: ExprDef): StoredExprDef => {
    const { expr: _e, ...rest } = e;
    return rest;
  };
  const { described: _d, ...rest } = def as StoredDef & { described?: true };
  const body = rest.kind === 'table' ? { ...rest, table: compactTable(rest.table, text) } : rest.kind === 'index' ? { ...rest, index: compactIndex(rest.index, text) } : rest;
  return encodeDataJSON(body);
}

/** A definition as stored: its JSON text, and its plan expressions' (null when it has none). */
export interface StoredText {
  readonly def: string;
  readonly exprs: string | null;
}

/** `def` as stored. */
export function encodeDef(def: StoredDef): StoredText {
  const exprs: unknown[] = [];
  const store = (e: ExprDef): StoredExprDef => {
    const { expr, ...rest } = e;
    if (expr === undefined) return rest;
    exprs.push(expr);
    return { ...rest, x: exprs.length - 1 };
  };
  let body: unknown;
  const language = def.kind === 'table' || def.kind === 'index' ? def.language : undefined;
  const lang = { ...(language !== undefined && language !== 'sql' ? { language } : {}), ...(isDescribed(def) ? { described: true } : {}) };
  if (def.kind === 'table') body = { kind: 'table', table: compactTable(def.table, store), ...lang };
  else if (def.kind === 'index') body = { kind: 'index', index: compactIndex(def.index, store), ...lang };
  else body = def;
  return { def: encodeDataJSON({ v: DEFINITION_VERSION, ...(body as object) }), exprs: exprs.length ? encodeDataJSON(exprs) : null };
}

/** A stored definition (`name` for errors). Its plan expressions are decoded where first read. */
export function decodeDef(text: StoredText, name: string): StoredDef {
  // The definition holds no plan expressions: plain JSON, with the values that may be tagged (DEFAULT values and
  // options) restored where they are.
  let raw: { v?: unknown; kind?: unknown; options?: Record<string, unknown> } & Record<string, unknown>;
  try {
    raw = JSON.parse(text.def) as typeof raw;
  } catch {
    throw new SmaltError('SMALT_CORRUPT', `definition of ${name} is not valid JSON`);
  }
  if (raw?.v !== DEFINITION_VERSION) throw new SmaltError('SMALT_FORMAT', `definition of ${name} has version ${String(raw?.v)} (this engine reads version ${DEFINITION_VERSION})`);
  delete raw.v;
  if (raw.options) for (const k in raw.options) raw.options[k] = valueFromJSON(raw.options[k]);
  if (raw.kind !== 'table' && raw.kind !== 'index') return raw as unknown as StoredDef;
  let exprs: unknown[] | undefined;
  const load = (e: StoredExprDef): ExprDef => {
    const { x, ...rest } = e;
    if (x === undefined) return rest;
    let expr: PlanExpr | undefined;
    return Object.defineProperty(rest, 'expr', {
      get: () => (expr ??= ((exprs ??= parse(text.exprs ?? '[]', name) as unknown[])[x] as PlanExpr | undefined) ?? corrupt(name)),
      enumerable: true,
    });
  };
  const lang = { ...(typeof raw.language === 'string' ? { language: raw.language } : {}), ...(raw.described === true ? { described: true as const } : {}) };
  return raw.kind === 'table' ? { kind: 'table', table: expandTable(raw.table as Compact, load), ...lang } : { kind: 'index', index: expandIndex(raw.index as Compact, load), ...lang };
}

/** An expression as stored: its text and the position of its plan expression in `exprs`. */
type StoredExprDef = Omit<ExprDef, 'expr'> & { readonly x?: number };
type Compact = Record<string, unknown>;

function parse(text: string, name: string): unknown {
  try {
    return decodeDataJSON(text);
  } catch {
    throw new SmaltError('SMALT_CORRUPT', `definition of ${name} is not valid JSON`);
  }
}

function corrupt(name: string): never {
  throw new SmaltError('SMALT_CORRUPT', `definition of ${name} refers to an expression it does not have`);
}

/** `o` without the fields whose value is `usual`'s. */
function omit(o: object, usual: Readonly<Record<string, unknown>>): Compact {
  const out: Compact = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === usual[k] || (Array.isArray(v) && v.length === 0 && Array.isArray(usual[k]))) continue;
    out[k] = v;
  }
  return out;
}

const COLUMN = { notNull: false, collation: 'binary' };
const KEY_COLUMN = { desc: false, collation: 'binary' };
const TABLE = { keys: [], checks: [], foreignKeys: [], storage: 'row' };
const FOREIGN_KEY = { onDelete: 'NO ACTION', onUpdate: 'NO ACTION', deferrable: false, isDeferrable: false };
const INDEX = { unique: false };

function compactTable(t: TableDef, store: (e: ExprDef) => StoredExprDef): Compact {
  return omit(
    {
      ...t,
      columns: t.columns.map((c) => omit({ ...c, declaredType: c.declaredType === c.type ? undefined : c.declaredType, default: c.default && store(c.default) }, COLUMN)),
      keys: t.keys.map((k) => ({ ...k, columns: k.columns.map((c) => omit(c, KEY_COLUMN)) })),
      checks: t.checks.map(store),
      foreignKeys: t.foreignKeys.map((f) => omit(f, FOREIGN_KEY)),
    },
    TABLE,
  );
}

function expandTable(t: Compact, load: (e: StoredExprDef) => ExprDef): TableDef {
  const u = { ...TABLE, ...t } as unknown as TableDef;
  return {
    ...u,
    columns: u.columns.map((c) => ({ ...COLUMN, ...c, declaredType: c.declaredType ?? c.type, ...(c.default ? { default: load({ ...c.default, value: valueFromJSON((c.default as DefaultDef).value) } as StoredExprDef) as DefaultDef } : {}) })),
    keys: u.keys.map((k) => ({ ...k, columns: k.columns.map((c) => ({ ...KEY_COLUMN, ...c })) })),
    checks: u.checks.map((c) => load(c)),
    foreignKeys: u.foreignKeys.map((f) => ({ ...FOREIGN_KEY, ...f })),
  };
}

function compactIndex(i: IndexDef, store: (e: ExprDef) => StoredExprDef): Compact {
  return omit({ ...i, columns: i.columns.map((c) => omit({ ...c, expr: c.expr && store(c.expr) }, KEY_COLUMN)), where: i.where && store(i.where) }, INDEX);
}

function expandIndex(i: Compact, load: (e: StoredExprDef) => ExprDef): IndexDef {
  const u = { ...INDEX, ...i } as unknown as IndexDef;
  return {
    ...u,
    columns: u.columns.map((c) => ({ ...KEY_COLUMN, ...c, ...(c.expr ? { expr: load(c.expr) } : {}) })),
    ...(u.where ? { where: load(u.where) } : {}),
  };
}

/** A system table's definition: its columns, in code. */
export function systemTableDef(name: string, columns: readonly (readonly [string, StorageType])[]): TableDef {
  return {
    name,
    columns: columns.map(([n, type]) => ({ name: n, declaredType: type === 'ANY' ? '' : type, type, notNull: false, collation: 'binary' })),
    keys: [],
    checks: [],
    foreignKeys: [],
    storage: 'row',
  };
}

/** The system tables: definition and the CREATE TABLE text `sqlite_schema` shows for them. */
export const SYSTEM_TABLES = {
  smalt_schema: systemTableDef('smalt_schema', [['type', 'TEXT'], ['name', 'TEXT'], ['tbl_name', 'TEXT'], ['rootpage', 'INTEGER'], ['sql', 'TEXT']]),
  smalt_definition: systemTableDef('smalt_definition', [['name', 'TEXT'], ['def', 'TEXT'], ['exprs', 'TEXT']]),
  smalt_stat: systemTableDef('smalt_stat', [['tbl', 'TEXT'], ['idx', 'TEXT'], ['stat', 'TEXT']]),
  smalt_matview: systemTableDef('smalt_matview', [['name', 'TEXT'], ['layout', 'TEXT'], ['populated', 'INTEGER'], ['refreshed_at', 'TEXT']]),
  smalt_columnar: systemTableDef('smalt_columnar', [['name', 'TEXT'], ['seg_root', 'INTEGER'], ['del_root', 'INTEGER']]),
  smalt_extcache: systemTableDef('smalt_extcache', [['name', 'TEXT'], ['sources', 'TEXT']]),
} as const;

export type SystemTableName = keyof typeof SYSTEM_TABLES;

/** The text shown for a system table: the engine's description of its definition, in no language (ADR 0017). */
export function systemTableText(name: SystemTableName): string {
  return describeDefinition({ kind: 'table', table: SYSTEM_TABLES[name], described: true });
}

export function isSystemTable(name: string): name is SystemTableName {
  return Object.prototype.hasOwnProperty.call(SYSTEM_TABLES, name.toLowerCase());
}
