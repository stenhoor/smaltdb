/**
 * The logical catalog a language binds against (ADR 0015 section 3): names, columns and their types, views, external
 * sources and functions. Read-only, and the same for every language. The planner's physical environment (trees,
 * statistics, spilling, execution state: exec/planner.ts `PhysicalEnv`) is not part of it.
 *
 * Still to change on the way to the language API (ADR 0015 order of work): tables are the engine's `TableSchema`
 * (which carries storage fields too), views carry SQL syntax trees, and functions are looked up through `funcCtx`.
 */
import type { TableSchema } from '../catalog/schema.js';
import type { StaticType } from '../exec/convert.js';
import type { FunctionContext } from '../exec/functions.js';
import type { SelectStmt } from '../sql/ast.js';
import type { SqlValue } from '../values.js';

export interface BindContext {
  /** A table by name; `schema` 'main' / 'temp' picks that schema when a TEMP table shadows a main one. */
  getTable(name: string, schema?: string): TableSchema | undefined;
  /**
   * The table a statement writes, by name: throws when there is none, or when it may not be written (a view, an
   * external table, the catalog and system tables, a materialized view).
   */
  writeTarget(name: string, schema?: string): TableSchema;
  /** A view's definition, bound where the view is read. */
  getView?(name: string, schema?: string): { name: string; sql: string; columns?: string[]; select: SelectStmt } | undefined;
  /** True for an external table. */
  isExternal?(name: string): boolean;
  /** The columns of an external table. */
  externalColumns?(name: string): { name: string; type: StaticType; declType?: string }[] | undefined;
  /** The columns of an external table function call (`read_csv('…')`) with these constant arguments. */
  externalFunctionColumns?(name: string, args: SqlValue[], named: Record<string, SqlValue>): { name: string; type: StaticType; declType?: string }[] | undefined;
  /** A table function that reads external data (`read_csv`): its columns come from the data. */
  isExternalFunction?(name: string): boolean;
  /** Virtual tables: `information_schema.<name>`, the TEMP catalog, table-valued functions (schema undefined). */
  virtualTable?(schema: string | undefined, name: string): { columns: { name: string; type: StaticType }[] } | undefined;
  funcCtx: FunctionContext;
}
