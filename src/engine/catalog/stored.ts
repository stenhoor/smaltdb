/**
 * Language-neutral catalog storage (ADR 0015 section 6): each object's definition as the engine stores it, versioned,
 * beside its source text and language (the catalog's `sql` column, which `sqlite_schema` shows). Opening a database
 * reads these definitions and parses nothing; views are kept as their language's source and read where they are used.
 *
 * Definitions live in the system table `smalt_definition(name, def)`, one row per catalog object (keyed like the
 * catalog), as JSON text: plan expressions are encoded with their SQL metadata (plan/codec.ts).
 */
import { SmaltError } from '../errors.js';
import { dataFromJSON, dataToJSON, decodeData, encodeData } from '../plan/codec.js';
import type { IndexDef, StorageType, TableDef } from '../plan/schema.js';
import type { SqlValue } from '../values.js';

/** Version of the stored definitions; a file whose definitions are newer is refused. */
export const DEFINITION_VERSION = 1;

/** An object's stored definition, by catalog type. */
export type StoredDef =
  | { readonly kind: 'table'; readonly table: TableDef }
  | { readonly kind: 'index'; readonly index: IndexDef }
  | { readonly kind: 'view'; readonly language: string; readonly columns?: readonly string[] }
  /** A materialized view; the table its rows are stored in is in `smalt_matview` (its layout). */
  | { readonly kind: 'matview'; readonly language: string; readonly columns?: readonly string[]; readonly options: Readonly<Record<string, SqlValue>> }
  | { readonly kind: 'connection'; readonly options: Readonly<Record<string, SqlValue>> }
  | { readonly kind: 'external'; readonly columns: readonly { readonly name: string; readonly declaredType: string }[]; readonly options: Readonly<Record<string, SqlValue>> };

/** A definition as stored: versioned JSON text. */
export function encodeDef(def: StoredDef): string {
  return dataToJSON({ v: DEFINITION_VERSION, ...(encodeData(def) as object) });
}

/** A stored definition (`name` for errors). */
export function decodeDef(text: string, name: string): StoredDef {
  let raw: { v?: unknown } & Record<string, unknown>;
  try {
    raw = dataFromJSON(text) as typeof raw;
  } catch {
    throw new SmaltError('SMALT_CORRUPT', `definition of ${name} is not valid JSON`);
  }
  if (raw.v !== DEFINITION_VERSION) throw new SmaltError('SMALT_FORMAT', `definition of ${name} has version ${String(raw.v)} (this engine reads version ${DEFINITION_VERSION})`);
  const { v: _v, ...def } = raw;
  return decodeData(def) as StoredDef;
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
  smalt_definition: systemTableDef('smalt_definition', [['name', 'TEXT'], ['def', 'TEXT']]),
  smalt_stat: systemTableDef('smalt_stat', [['tbl', 'TEXT'], ['idx', 'TEXT'], ['stat', 'TEXT']]),
  smalt_matview: systemTableDef('smalt_matview', [['name', 'TEXT'], ['layout', 'TEXT'], ['populated', 'INTEGER'], ['refreshed_at', 'TEXT']]),
  smalt_columnar: systemTableDef('smalt_columnar', [['name', 'TEXT'], ['seg_root', 'INTEGER'], ['del_root', 'INTEGER']]),
  smalt_extcache: systemTableDef('smalt_extcache', [['name', 'TEXT'], ['sources', 'TEXT']]),
} as const;

export type SystemTableName = keyof typeof SYSTEM_TABLES;

/** The CREATE TABLE text shown for a system table. */
export function systemTableSql(name: SystemTableName): string {
  const def = SYSTEM_TABLES[name];
  return `CREATE TABLE ${name}(${def.columns.map((c) => `${c.name} ${c.type}`).join(', ')})`;
}

export function isSystemTable(name: string): name is SystemTableName {
  return Object.prototype.hasOwnProperty.call(SYSTEM_TABLES, name.toLowerCase());
}
