/**
 * information_schema: read-only views over the catalog in the SQL-standard / PostgreSQL shape
 * (docs/SQL_DIALECT.md §4). Rows are computed when a query reads them.
 */
import type { StaticType } from '../exec/convert.js';
import type { SqlValue } from '../values.js';
import type { IndexSchema, TableSchema } from './schema.js';

export interface CatalogSnapshot {
  tables: TableSchema[];
  /** Views: name, CREATE VIEW text, and the text of its query alone (view_definition). */
  /** The text of a view's or materialized view's query alone, from its source. */
  definition(source: { language: string; text: string }): string;
  views: { name: string; sql: string; definition: string }[];
  /** Result columns of a view (null when the view cannot be resolved, e.g. a dropped table). */
  viewColumns(name: string): { name: string; declType: string }[] | null;
  functions: { name: string; kind: 'FUNCTION' | 'AGGREGATE'; deterministic: boolean }[];
  /** External tables (M8): columns as declared or inferred at creation. */
  externals: { name: string; columns: { name: string; declType: string }[]; location: string; format: string | null; connection: string | null; options: string }[];
  /** Connections (M8): no secrets, only the name of a credential provider. */
  connections: { name: string; type: string; url: string | null; credentials: string | null; options: string }[];
}

export interface VirtualTable {
  columns: { name: string; type: StaticType }[];
  rows: () => SqlValue[][];
}

const CATALOG = 'main';
const SCHEMA = 'main';
const yesNo = (b: boolean): string => (b ? 'YES' : 'NO');
const t = (name: string): { name: string; type: StaticType } => ({ name, type: 'text' });
const i = (name: string): { name: string; type: StaticType } => ({ name, type: 'int' });

function pkConstraintName(table: TableSchema): string {
  return table.indexes.find((x) => x.origin === 'pk')?.constraintName ?? `${table.name}_pkey`;
}

/** Constraints of a table, in a stable order: primary key, unique, foreign keys, checks. */
function constraints(table: TableSchema): { name: string; type: string; columns: string[]; index?: IndexSchema; fk?: TableSchema['foreignKeys'][number]; check?: string }[] {
  const out: ReturnType<typeof constraints> = [];
  const colName = (c: number): string => table.columns[c].name;
  if (table.rowidAlias >= 0) out.push({ name: pkConstraintName(table), type: 'PRIMARY KEY', columns: [colName(table.rowidAlias)] });
  for (const idx of table.indexes) {
    if (idx.origin === 'pk') out.push({ name: pkConstraintName(table), type: 'PRIMARY KEY', columns: idx.columns.map((c) => colName(c.column)), index: idx });
  }
  for (const idx of table.indexes) {
    if (idx.origin !== 'u') continue;
    const cols = idx.columns.map((c) => colName(c.column));
    out.push({ name: idx.constraintName ?? `${table.name}_${cols.join('_')}_key`, type: 'UNIQUE', columns: cols, index: idx });
  }
  table.foreignKeys.forEach((fk) => {
    const cols = fk.columns.map(colName);
    out.push({ name: fk.name ?? `${table.name}_${cols.join('_')}_fkey`, type: 'FOREIGN KEY', columns: cols, fk });
  });
  table.checks.forEach((c, n) => {
    out.push({ name: c.name ?? `${table.name}_check${n + 1}`, type: 'CHECK', columns: [], check: c.text });
  });
  return out;
}

export function informationSchema(name: string, cat: CatalogSnapshot): VirtualTable | undefined {
  const userTables = (): TableSchema[] => cat.tables.filter((x) => !x.system && !x.temp && !x.name.toLowerCase().startsWith('smalt_'));
  switch (name.toLowerCase()) {
    case 'schemata':
      return {
        columns: [t('catalog_name'), t('schema_name'), t('schema_owner')],
        rows: () => [
          [CATALOG, 'main', null],
          [CATALOG, 'information_schema', null],
        ],
      };
    case 'tables':
      return {
        columns: [t('table_catalog'), t('table_schema'), t('table_name'), t('table_type'), t('is_insertable_into')],
        rows: () => [
          ...userTables().map((x) => [CATALOG, SCHEMA, x.name, x.matview ? 'MATERIALIZED VIEW' : 'BASE TABLE', x.matview ? 'NO' : 'YES']),
          ...cat.views.map((v) => [CATALOG, SCHEMA, v.name, 'VIEW', 'NO']),
          ...cat.externals.map((x) => [CATALOG, SCHEMA, x.name, 'EXTERNAL', 'NO']),
        ],
      };
    case 'external_tables':
      // smaltdb extension (M8, ADR 0011).
      return {
        columns: [t('table_catalog'), t('table_schema'), t('table_name'), t('location'), t('format'), t('connection_name'), t('options')],
        rows: () => cat.externals.map((x) => [CATALOG, SCHEMA, x.name, x.location, x.format, x.connection, x.options]),
      };
    case 'connections':
      // smaltdb extension (M8, ADR 0011): endpoints, never secrets.
      return {
        columns: [t('connection_name'), t('connection_type'), t('url'), t('credentials'), t('options')],
        rows: () => cat.connections.map((c) => [c.name, c.type, c.url, c.credentials, c.options]),
      };
    case 'columns':
      return {
        columns: [
          t('table_catalog'),
          t('table_schema'),
          t('table_name'),
          t('column_name'),
          i('ordinal_position'),
          t('column_default'),
          t('is_nullable'),
          t('data_type'),
          t('collation_name'),
          t('is_identity'),
          t('is_generated'),
        ],
        rows: () => {
          const out: SqlValue[][] = [];
          for (const x of userTables()) {
            x.columns.forEach((c, n) => {
              out.push([
                CATALOG,
                SCHEMA,
                x.name,
                c.name,
                n + 1,
                c.default ? c.default.text : null,
                yesNo(!c.notNull),
                c.declaredType || 'ANY',
                ['BINARY', 'NOCASE', 'RTRIM'][c.collation] ?? null,
                yesNo(c.rowidAlias),
                'NEVER',
              ]);
            });
          }
          for (const v of cat.views) {
            const cols = cat.viewColumns(v.name);
            cols?.forEach((c, n) => out.push([CATALOG, SCHEMA, v.name, c.name, n + 1, null, 'YES', c.declType || 'ANY', null, 'NO', 'NEVER']));
          }
          for (const x of cat.externals) x.columns.forEach((c, n) => out.push([CATALOG, SCHEMA, x.name, c.name, n + 1, null, 'YES', c.declType || 'ANY', null, 'NO', 'NEVER']));
          return out;
        },
      };
    case 'materialized_views':
      // smaltdb extension (PostgreSQL has pg_matviews).
      return {
        columns: [t('table_catalog'), t('table_schema'), t('table_name'), t('view_definition'), t('storage'), t('location'), t('refresh_mode'), t('is_populated'), t('last_refresh'), t('is_fresh'), t('last_refresh_error')],
        rows: () =>
          userTables()
            .filter((x) => x.matview)
            .map((x) => {
              const m = x.matview!;
              // MANUAL, or the automatic policy: `EVERY 300 SECONDS`, `ON RECONNECT`, or both.
              const p = m.policy;
              const mode = [p?.every ? `EVERY ${p.every} SECONDS` : '', p?.onReconnect ? 'ON RECONNECT' : ''].filter(Boolean).join(', ') || 'MANUAL';
              return [CATALOG, SCHEMA, x.name, cat.definition({ language: m.language, text: m.sql }), m.storage, x.rootPage >= 2 ** 30 ? 'memory' : 'file', mode, yesNo(m.populated), m.refreshedAt, yesNo(m.populated && m.fresh === true), m.lastRefreshError ?? null];
            }),
      };
    case 'views':
      return {
        columns: [t('table_catalog'), t('table_schema'), t('table_name'), t('view_definition'), t('check_option'), t('is_updatable'), t('is_insertable_into')],
        rows: () => cat.views.map((v) => [CATALOG, SCHEMA, v.name, v.definition, 'NONE', 'NO', 'NO']),
      };
    case 'table_constraints':
      return {
        columns: [t('constraint_catalog'), t('constraint_schema'), t('constraint_name'), t('table_catalog'), t('table_schema'), t('table_name'), t('constraint_type'), t('is_deferrable'), t('initially_deferred')],
        rows: () =>
          userTables().flatMap((x) =>
            constraints(x).map((c) => [CATALOG, SCHEMA, c.name, CATALOG, SCHEMA, x.name, c.type, yesNo(c.fk?.isDeferrable ?? false), yesNo(c.fk?.deferrable ?? false)]),
          ),
      };
    case 'key_column_usage':
      return {
        columns: [t('constraint_catalog'), t('constraint_schema'), t('constraint_name'), t('table_catalog'), t('table_schema'), t('table_name'), t('column_name'), i('ordinal_position'), i('position_in_unique_constraint')],
        rows: () =>
          userTables().flatMap((x) =>
            constraints(x)
              .filter((c) => c.type !== 'CHECK')
              .flatMap((c) => c.columns.map((col, n) => [CATALOG, SCHEMA, c.name, CATALOG, SCHEMA, x.name, col, n + 1, c.fk ? n + 1 : null])),
          ),
      };
    case 'referential_constraints':
      return {
        columns: [t('constraint_catalog'), t('constraint_schema'), t('constraint_name'), t('unique_constraint_catalog'), t('unique_constraint_schema'), t('unique_constraint_name'), t('match_option'), t('update_rule'), t('delete_rule')],
        rows: () =>
          userTables().flatMap((x) =>
            constraints(x)
              .filter((c) => c.fk)
              .map((c) => {
                const parent = cat.tables.find((p) => p.name.toLowerCase() === c.fk!.table.toLowerCase());
                let unique: string | null = null;
                if (parent) {
                  const refCols = c.fk!.refColumns?.map((r) => r.toLowerCase());
                  const match = constraints(parent).find(
                    (pc) => (pc.type === 'PRIMARY KEY' || pc.type === 'UNIQUE') && (refCols ? pc.columns.map((n) => n.toLowerCase()).join() === refCols.join() : pc.type === 'PRIMARY KEY'),
                  );
                  unique = match?.name ?? null;
                }
                return [CATALOG, SCHEMA, c.name, CATALOG, SCHEMA, unique, 'NONE', c.fk!.onUpdate, c.fk!.onDelete];
              }),
          ),
      };
    case 'check_constraints':
      return {
        columns: [t('constraint_catalog'), t('constraint_schema'), t('constraint_name'), t('check_clause')],
        rows: () => userTables().flatMap((x) => constraints(x).filter((c) => c.type === 'CHECK').map((c) => [CATALOG, SCHEMA, c.name, c.check!])),
      };
    case 'routines':
      return {
        columns: [t('specific_name'), t('routine_catalog'), t('routine_schema'), t('routine_name'), t('routine_type'), t('is_deterministic'), t('routine_body')],
        rows: () => cat.functions.map((f) => [f.name, CATALOG, SCHEMA, f.name, f.kind, yesNo(f.deterministic), 'EXTERNAL']),
      };
    case 'statistics':
      return {
        columns: [t('table_catalog'), t('table_schema'), t('table_name'), i('non_unique'), t('index_name'), i('seq_in_index'), t('column_name'), t('collation'), t('index_type')],
        rows: () =>
          userTables().flatMap((x) =>
            x.indexes.flatMap((idx) => idx.columns.map((c, n) => [CATALOG, SCHEMA, x.name, idx.unique ? 0 : 1, idx.name, n + 1, c.column < 0 ? null : x.columns[c.column].name, c.desc ? 'D' : 'A', 'BTREE'])),
          ),
      };
    default:
      return undefined;
  }
}
