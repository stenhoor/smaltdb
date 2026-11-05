/**
 * Views as the SQL front end reads them: the engine keeps a view as its source (plan/bind-context.ts `getView`), and
 * SQL parses that source where it reads the view, once per text.
 */
import { SmaltError } from '../../language-support.js';
import type { Source } from '../../language-support.js';
import type { CreateViewStmt, SelectStmt } from '../ast.js';
import { parseOne } from '../parser.js';

/** A view the front end flattens or plans: its name, text, column names and parsed query. */
export interface SqlView {
  name: string;
  sql: string;
  columns?: string[];
  select: SelectStmt;
}

const parsed = new Map<string, SelectStmt>();
const MAX_CACHED = 1024;

/** The query of a view written in SQL (its CREATE VIEW or CREATE MATERIALIZED VIEW text), parsed once per text. */
export function viewSelect(source: Source): SelectStmt {
  if (source.language !== 'sql') throw new SmaltError('SMALT_MISUSE', `view is written in ${source.language}, which SQL cannot read`);
  let s = parsed.get(source.text);
  if (s === undefined) {
    s = (parseOne(source.text).stmt as CreateViewStmt).select;
    if (parsed.size >= MAX_CACHED) parsed.delete(parsed.keys().next().value!);
    parsed.set(source.text, s);
  }
  return s;
}

/** A view from the catalog, as SQL reads it. */
export function sqlView(v: { name: string; source: Source; columns?: readonly string[] } | undefined): SqlView | undefined {
  return v && { name: v.name, sql: v.source.text, ...(v.columns ? { columns: [...v.columns] } : {}), select: viewSelect(v.source) };
}
