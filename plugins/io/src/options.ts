/** Options of the import and export methods (shared by the plugin and the client helpers). */

export interface CsvImportOptions {
  /** First record names the columns (default true). Without it, fields map to table columns in order. */
  header?: boolean;
  delimiter?: string;
  quote?: string;
  /** Target columns (overrides the header). */
  columns?: string[];
  /** Create the table if it does not exist, inferring INTEGER / REAL / TEXT per column. */
  create?: boolean;
  /** Unquoted empty fields become NULL (default true); quoted `""` is always an empty string. */
  emptyAsNull?: boolean;
}

export interface JsonImportOptions {
  /** Create the table if it does not exist, inferring column types from the values. */
  create?: boolean;
  /** Target columns for arrays-of-arrays input (default: the table's columns in order). */
  columns?: string[];
}

export interface CsvExportOptions {
  header?: boolean;
  delimiter?: string;
  /** Text written for NULL (default empty). */
  nullString?: string;
  /** Use CRLF line endings (default LF). */
  crlf?: boolean;
}

export interface JsonExportOptions {
  /** 'array' (default): one JSON array of objects; 'ndjson': one object per line. */
  format?: 'array' | 'ndjson';
}

/** Data accepted by importCSV / importJSON (decoded as UTF-8). */
export type ImportSource = string | Uint8Array | ArrayBuffer | Blob;

/** A value bound to a query parameter. */
export type ParamValue = null | number | bigint | string | Uint8Array | boolean | undefined;

/** Query parameters for the exports: positional, or named (`:name`, `$name`, `@name`). */
export type ExportParams = readonly ParamValue[] | Readonly<Record<string, ParamValue>>;
