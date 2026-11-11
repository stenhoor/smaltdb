/**
 * The logical catalog a language binds against (ADR 0015 section 3): names, columns and their types, views, external
 * sources and functions. Read-only, and the same for every language. The planner's physical environment (trees,
 * statistics, spilling, execution state: exec/planner.ts `PhysicalEnv`) is not part of it.
 * Tables are described as the catalog describes them (ADR 0016 section 7).
 */
import type { StaticType } from '../exec/convert.js';
import type { FunctionContext } from '../exec/functions.js';
import type { SqlValue } from '../values.js';
import type { Catalog, CatalogTable, ViewInterfaceColumn } from './catalog.js';
import type { Source } from './schema.js';

export interface BindContext {
  /**
   * A table (or materialized view, or system table) by name, as the catalog describes it; `schema` 'main' / 'temp'
   * picks that schema when a TEMP table shadows a main one.
   */
  table(name: string, schema?: string): CatalogTable | undefined;
  /**
   * The table a statement writes, by name: throws when there is none, or when it may not be written (a view, an
   * external table, the catalog and system tables, a materialized view).
   */
  writeTable(name: string, schema?: string): CatalogTable;
  /**
   * The table CREATE INDEX indexes, by name: throws when there is none, or when it may not be indexed (a view, an
   * external table, a columnar table, a TEMP index on a main table).
   */
  indexTable(name: string, schema?: string): CatalogTable;
  /**
   * A view: its source in its language (bound where the view is read), the column names given with it, and its
   * interface (ADR 0027). Where a column's type has changed losslessly since the interface was captured, a language
   * that binds the view's source itself converts the column to the interface's type (`conversion` in plan/conversions.ts).
   */
  getView?(name: string, schema?: string): { name: string; source: Source; columns?: readonly string[]; interface?: readonly ViewInterfaceColumn[] } | undefined;
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
  /** The logical catalog: tables and functions in plan terms, result types and constant evaluation (plan/catalog.ts). */
  catalog: Catalog;
  funcCtx: FunctionContext;
}
