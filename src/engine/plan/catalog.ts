/**
 * The logical catalog (ADR 0016 section 7): what a language or an application can know about a database to build
 * plans for it, the same for every language and in every place (`db.catalog` in process and in a plugin method's
 * `ctx.db`, `await db.catalog()` on the client, `BindContext.catalog` while binding). Tables are described in plan
 * terms (plan types, collation names, column positions), not as the engine stores them.
 *
 * This module needs nothing of the engine: the types and the declared-type mapping are part of `smaltdb/plan`.
 */
import type { SqlValue } from '../values.js';
import type { BoundExpr, ExprMeaning } from './expr.js';
import type { CheckDef, DefaultDef, ForeignKeyDef, Source, StorageType } from './schema.js';
import type { CollationName, PlanType } from './types.js';
import { isNestedType } from '../../shared/nested-types.js';

/** A column of a table, a materialized view or an external table. */
export interface CatalogColumn {
  readonly name: string;
  /** The plan type of its values (a value may always be NULL unless `notNull`). */
  readonly type: PlanType;
  /** How values are stored and converted on write (`ANY`: as given). */
  readonly storageType: StorageType;
  /** The type as written in its definition, or `''`. */
  readonly declaredType: string;
  /** The collation text in it compares by. */
  readonly collation: CollationName;
  readonly notNull: boolean;
  /** The column is the table's rowid (an integer primary key). */
  readonly rowid: boolean;
  /** It has a default value. */
  readonly hasDefault: boolean;
  /**
   * Its DEFAULT, as its definition has it: the text, the expression (over no columns) and the value when constant. A
   * default that is an expression has an `expr` other than a literal.
   */
  readonly default?: DefaultDef;
}

/** A primary key or unique constraint: column positions. */
export interface CatalogKey {
  readonly kind: 'primaryKey' | 'unique';
  readonly columns: readonly number[];
}

/** An index: its columns (`column` -1 for an indexed expression), and whether it is unique or partial. */
export interface CatalogIndex {
  readonly name: string;
  readonly columns: readonly { readonly column: number; readonly desc: boolean; readonly collation: CollationName }[];
  readonly unique: boolean;
  readonly partial: boolean;
}

/**
 * Something a plan reads by name with a `scan` (tables, materialized views, and the engine's system tables while a
 * language binds) or a `source` (external tables).
 */
export interface CatalogTable {
  readonly kind: 'table' | 'materializedView' | 'external' | 'system';
  readonly name: string;
  readonly schema: 'main' | 'temp';
  readonly columns: readonly CatalogColumn[];
  /** The primary key first, then unique constraints. A table without a declared primary key has a rowid. */
  readonly keys: readonly CatalogKey[];
  readonly indexes: readonly CatalogIndex[];
  /** Its foreign keys, as its definition has them (child column positions, the parent table and columns, the actions). */
  readonly foreignKeys: readonly ForeignKeyDef[];
  /** Its CHECK constraints, as its definition has them (name, text and expression over the row). */
  readonly checks: readonly CheckDef[];
  /** For a table defined without source text, the language of its expression texts (`TableDef.exprLanguage`). */
  readonly exprLanguage?: string;
  readonly storage: 'row' | 'columnar';
  /** Values must match the column types (no conversion on write). */
  readonly strict: boolean;
  /** Its definition, in the language it was written in; absent for a table defined without source text (ADR 0016 section 6). */
  readonly source?: Source;
  /** A materialized view's interface (ADR 0027), as a view's; absent for one made before interfaces. */
  readonly interface?: readonly ViewInterfaceColumn[];
  /** An external table's options (`createExternalTable.options`): its location, format, connection and the rest. */
  readonly options?: Readonly<Record<string, SqlValue>>;
}

/** A connection (`createConnection`): its options, as created (type, url, credentials and the rest). */
export interface CatalogConnection {
  readonly name: string;
  readonly options: Readonly<Record<string, SqlValue>>;
  /** Its definition, in the language it was written in; absent for one defined without source text. */
  readonly source?: Source;
}

/** A view: its language and source text, bound where it is read. */
export interface CatalogView {
  readonly name: string;
  readonly schema: 'main' | 'temp';
  readonly language: string;
  readonly text: string;
  /** The column names given with it, if any. */
  readonly columns?: readonly string[];
  /**
   * Its interface (ADR 0027): the columns it gives, by name, type and whether they can be NULL, captured the first
   * time it bound. Absent while it hasn't bound yet, and for a view made before interfaces (`reflects`).
   */
  readonly interface?: readonly ViewInterfaceColumn[];
  /** A view made before interfaces (ADR 0027): it reflects what it reads, as views did. */
  readonly reflects?: true;
}

/** A column of a view's interface (ADR 0027). */
export interface ViewInterfaceColumn {
  readonly name: string;
  readonly type: PlanType;
  /** Proven never NULL when the interface was captured (conservatively: see plan/nullability.ts). */
  readonly notNull: boolean;
}

/** A registered function or operation a plan can call. */
export interface CatalogFunction {
  readonly name: string;
  /** `scalar` in a `call`; `aggregate` in an aggregate or a window; `window` in a window only. */
  readonly kind: 'scalar' | 'aggregate' | 'window';
  readonly minArgs: number;
  /** The most arguments it takes, or null for any number. */
  readonly maxArgs: number | null;
  /** The same arguments always give the same result (never true of `random()`, the clock or the time zone). */
  readonly deterministic: boolean;
  /**
   * A date and time function: deterministic unless an argument asks for the current time (`'now'`), so allowed in
   * index expressions and CHECK constraints, where reading the clock fails when it runs.
   */
  readonly dateTime?: true;
  /** The result type when nothing is known of the arguments (`resultType` for given argument types). */
  readonly result: PlanType;
  /** One of the engine's own operations (ADR 0016 section 1), not a named scalar function. */
  readonly operation?: true;
  /** What the planner and code generation know about it (comparisons, offsets, patterns, …). */
  readonly traits: Readonly<Record<string, string | number | boolean>>;
}

/** The settings that change what a statement means or how it is planned. */
export interface CatalogSettings {
  /** Foreign keys are enforced. */
  readonly foreignKeys: boolean;
  /** Memory, in bytes, an operation may use before it spills. */
  readonly workMem: number;
  /** Queries may be answered from materialized views. */
  readonly matviewRewrite: boolean;
  /** Aggregates may run in parallel workers. */
  readonly parallelAggregates: boolean;
}

/** The catalog as plain data: what the client receives, and what can be copied or sent anywhere. */
export interface CatalogData {
  readonly tables: readonly CatalogTable[];
  readonly views: readonly CatalogView[];
  readonly connections: readonly CatalogConnection[];
  readonly functions: readonly CatalogFunction[];
  readonly settings: CatalogSettings;
}

/** The catalog in process: lookups, plus the engine's help for building plans. */
export interface Catalog {
  /** Tables, materialized views and external tables (TEMP ones first where both exist). */
  tables(): CatalogTable[];
  /** One by name; `schema` picks main or temp when a TEMP table shadows a main one. */
  table(name: string, schema?: 'main' | 'temp'): CatalogTable | undefined;
  views(): CatalogView[];
  view(name: string, schema?: 'main' | 'temp'): CatalogView | undefined;
  /** Connections, and one by name. */
  connections(): CatalogConnection[];
  connection(name: string): CatalogConnection | undefined;
  functions(): CatalogFunction[];
  /**
   * A function by name (a former `sql.*` name finds its operation). A name can have one function of each kind (`min`
   * and `max` are a scalar and an aggregate): `kind` picks one, else the scalar, then the aggregate, then the window.
   */
  function(name: string, kind?: CatalogFunction['kind']): CatalogFunction | undefined;
  settings(): CatalogSettings;
  /** All of it as plain data. */
  snapshot(): CatalogData;
  /** The result type of function `name` for arguments of these types (and collations), or undefined if unknown. */
  resultType(name: string, args: readonly (PlanType | { readonly type: PlanType; readonly collation?: CollationName })[]): PlanType | undefined;
  /**
   * The type the engine gives `expr` when it runs, which can be narrower than the type written on it. Columns and
   * parameters count as their written types; a nested plan as the type written on it.
   */
  typeOf(expr: BoundExpr): PlanType;
  /**
   * What the engine computes for `expr` when it runs: its type, and the meaning fields a comparison of it reads
   * (plan/expr.ts `ExprMeaning`): the collation it carries and its affinity, given on it or passed up from what it is
   * made of (a cast keeps its operand's collation).
   */
  describe(expr: BoundExpr): { readonly type: PlanType } & Pick<ExprMeaning, 'carries' | 'affinity'>;
  /**
   * `expr`'s value, when it depends on nothing but constants (no columns, parameters, subqueries or functions that
   * aren't deterministic), else null.
   */
  constant(expr: BoundExpr): { readonly value: SqlValue } | null;
}

/**
 * The functions part of the catalog, which no database changes: what a language reads where it has no database at
 * hand (`engineFunctions` in smaltdb/language).
 */
export type FunctionCatalog = Pick<Catalog, 'functions' | 'function' | 'resultType'>;

// ------------------------------------------------------------------ declared types

/**
 * The storage type a declared column type gives, by SQLite's rules so familiar names work: `*INT*` INTEGER; `*CHAR*`,
 * `*CLOB*`, `*TEXT*` TEXT; `*BLOB*` BLOB; `*REAL*`, `*FLOA*`, `*DOUB*` REAL; `ANY` or none ANY; anything else
 * (`NUMERIC`, `DECIMAL`, `BOOLEAN`, `DATE`, …) NUMERIC.
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

/**
 * The plan type of values stored as `t`. A LIST or STRUCT column's plan type is its declared type (ADR 0020), so pass
 * `declared` for one; without it, or when it isn't a list or struct type, its values are blobs.
 */
export function planTypeOfStorage(t: StorageType, declared?: string): PlanType {
  switch (t) {
    case 'LIST':
    case 'STRUCT':
      return declared !== undefined && isNestedType(declared) ? declared : 'blob';
    case 'INTEGER':
      return 'int';
    case 'BOOLEAN':
      return 'bool';
    case 'DATE':
      return 'date';
    case 'TIME':
      return 'time';
    case 'DATETIME':
      return 'datetime';
    case 'DURATION':
      return 'duration';
    case 'REAL':
      return 'real';
    case 'TEXT':
      return 'text';
    case 'BLOB':
      return 'blob';
    default:
      // NUMERIC holds text that doesn't convert as text: its values are of any type.
      return 'any';
  }
}

/**
 * The affinity of a column stored as `t`: the conversion a comparison applies to the other operand. `BLOB` (SQLite's
 * name) converts nothing.
 */
export function affinityOfStorage(t: StorageType): 'INTEGER' | 'REAL' | 'NUMERIC' | 'TEXT' | 'BLOB' {
  switch (t) {
    case 'INTEGER':
    case 'BOOLEAN':
    case 'DATE':
    case 'TIME':
    case 'DATETIME':
    case 'DURATION':
      return 'INTEGER';
    case 'REAL':
      return 'REAL';
    case 'TEXT':
      return 'TEXT';
    case 'NUMERIC':
      return 'NUMERIC';
    default:
      return 'BLOB';
  }
}

/** A declared column type's storage type, plan type and affinity. */
export function declaredType(declared: string | undefined): { storageType: StorageType; type: PlanType; affinity: 'INTEGER' | 'REAL' | 'NUMERIC' | 'TEXT' | 'BLOB' } {
  const storageType = storageTypeFor(declared);
  return { storageType, type: planTypeOfStorage(storageType), affinity: affinityOfStorage(storageType) };
}
