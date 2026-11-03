/**
 * @smaltdb/io: the CSV, TSV and JSON / NDJSON formats for smaltdb external tables, `read_csv()` and
 * `read_json()`, and CSV / JSON import and export (ADR 0012). No dependencies.
 *
 * Import and export are plugin methods (`importCSV`, `importJSON`, `exportCSV`, `exportJSON`),
 * called with the helpers in `@smaltdb/io/client` or `db.callPlugin('@smaltdb/io', …)`.
 */
import type { SmaltPlugin } from 'smaltdb/engine';
import { decode, readCsv, readJson } from './formats.js';
import { exportCSV, exportJSON, importCSV, importJSON, importText } from './import-export.js';
import type { CsvExportOptions, CsvImportOptions, ExportParams, ImportSource, JsonExportOptions, JsonImportOptions } from './options.js';

export type { CsvExportOptions, CsvImportOptions, ExportParams, ImportSource, JsonExportOptions, JsonImportOptions, ParamValue } from './options.js';

declare const __PLUGIN_VERSION__: string | undefined;
const VERSION = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0';

const CSV_OPTIONS = ['header', 'delimiter', 'quote', 'null', 'skip', 'encoding'];

const io: SmaltPlugin = {
  name: '@smaltdb/io',
  version: VERSION,
  apiVersion: 1,
  setup(host) {
    // `txt` is an extension only (read as CSV): `format = 'txt'` is not a format name.
    host.addFormat({ name: 'csv', extensions: ['csv', 'txt'], options: CSV_OPTIONS, access: 'bytes', read: async (bytes, req) => readCsv(decode(bytes, req.options), req) });
    host.addFormat({ name: 'tsv', extensions: ['tsv'], options: CSV_OPTIONS, access: 'bytes', read: async (bytes, req) => readCsv(decode(bytes, req.options), req, '\t') });
    host.addFormat({
      name: 'json',
      aliases: ['ndjson', 'jsonl'],
      extensions: ['json', 'ndjson', 'jsonl'],
      options: ['encoding'],
      access: 'bytes',
      read: async (bytes, req) => readJson(decode(bytes, req.options), req),
    });
    host.addTableFunction('read_csv', { format: (location) => (/\.tsv([?#]|$)/i.test(location) ? 'tsv' : 'csv') });
    host.addTableFunction('read_json', { format: 'json' });

    host.addMethod('importCSV', async (ctx, [table, source, options]) => importCSV(ctx.db, table as string, await importText(ctx, source as ImportSource), (options ?? {}) as CsvImportOptions));
    host.addMethod('importJSON', async (ctx, [table, source, options]) => importJSON(ctx.db, table as string, await importText(ctx, source as ImportSource), (options ?? {}) as JsonImportOptions));
    host.addMethod('exportCSV', (ctx, [sql, params, options]) => exportCSV(ctx, host.formatReal, sql as string, (params ?? undefined) as ExportParams | undefined, (options ?? {}) as CsvExportOptions));
    host.addMethod('exportJSON', (ctx, [sql, params, options]) => exportJSON(ctx, host.formatReal, sql as string, (params ?? undefined) as ExportParams | undefined, (options ?? {}) as JsonExportOptions));
  },
};
export default io;
