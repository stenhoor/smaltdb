/**
 * Helpers that call @smaltdb/io's methods: `importCSV(db, 'sales', file)`. `db` is a client
 * `Database` (from `smaltdb`) or an engine `Database` (from `smaltdb/engine`) with the plugin
 * installed. Imports nothing from smaltdb at run time.
 */
import type { CsvExportOptions, CsvImportOptions, ExportParams, ImportSource, JsonExportOptions, JsonImportOptions } from './options.js';

export type { CsvExportOptions, CsvImportOptions, ExportParams, ImportSource, JsonExportOptions, JsonImportOptions, ParamValue } from './options.js';

/** What the helpers need of a database: `callPlugin` (client or engine `Database`). */
export interface PluginCaller {
  callPlugin(plugin: string, method: string, args: unknown[], options?: { lock?: boolean; replay?: string; dropReplay?: boolean; signal?: AbortSignal }): Promise<unknown>;
  onPluginMessage?(plugin: string, handler: ((m: unknown) => unknown) | null): void;
}

const PLUGIN = '@smaltdb/io';

/**
 * Import CSV (RFC 4180) into `table` in one transaction (a savepoint inside an open one): all rows or
 * none. The header names the target columns unless `header: false`; `create: true` creates a missing
 * table with inferred column types. Bytes and blobs are read as UTF-8.
 */
export async function importCSV(db: PluginCaller, table: string, source: ImportSource, options: CsvImportOptions = {}): Promise<{ rows: number }> {
  return (await db.callPlugin(PLUGIN, 'importCSV', [table, source, options], { lock: true })) as { rows: number };
}

/** Import a JSON array (of objects or arrays) or NDJSON into `table`; see {@link importCSV}. */
export async function importJSON(db: PluginCaller, table: string, source: ImportSource, options: JsonImportOptions = {}): Promise<{ rows: number }> {
  return (await db.callPlugin(PLUGIN, 'importJSON', [table, source, options], { lock: true })) as { rows: number };
}

/** Run a query and return its result as CSV text (header row first by default). */
export async function exportCSV(db: PluginCaller, sql: string, params?: ExportParams, options: CsvExportOptions = {}): Promise<string> {
  return (await db.callPlugin(PLUGIN, 'exportCSV', [sql, params ?? null, options], { lock: true })) as string;
}

/** Run a query and return its result as a JSON array of objects (or NDJSON with `{ format: 'ndjson' }`). */
export async function exportJSON(db: PluginCaller, sql: string, params?: ExportParams, options: JsonExportOptions = {}): Promise<string> {
  return (await db.callPlugin(PLUGIN, 'exportJSON', [sql, params ?? null, options], { lock: true })) as string;
}
