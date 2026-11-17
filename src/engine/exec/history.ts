/**
 * Version history, method (a) (ADR 0033 step 6, part 2): a table created with `history: 'versions'` keeps its earlier
 * row versions, so plans can read it as it was after any commit (`asOf` on a scan, rewritten in exec/plan-normalize.ts).
 *
 * Two system tables beside it, written in the same transaction as the change:
 *
 * - `smalt_since_<t>`: one row per current row of `t`, its rowid `t`'s, holding the commit the row's current version
 *   started at.
 * - `smalt_versions_<t>`: the closed versions, `[$rowid, $from, $to, …t's columns]`, valid from commit `$from` up to,
 *   not including, `$to`; indexed on `$to`.
 *
 * So `t` and its reads don't change: an insert writes one small row more, and an update or delete a version and the
 * small row. A version that started in the open transaction was never committed, so changing it again writes none.
 * Versions are commit ids: the open transaction's own, fixed by the pager (`nextCommit`).
 */
import type { SqlValue } from '../values.js';
import type { TableWriter } from './write.js';

export const sinceTableName = (table: string): string => `smalt_since_${table}`;
export const versionsTableName = (table: string): string => `smalt_versions_${table}`;
/** The columns a versions table has before its table's own. */
export const VERSION_COLUMNS = ['$rowid', '$from', '$to'] as const;

/** What a history table's writer reports (exec/write.ts `TableWriter.history`). */
export interface HistoryHooks {
  inserted(row: readonly SqlValue[], rowid: number | bigint): void;
  updated(old: readonly SqlValue[], oldRowid: number | bigint, next: readonly SqlValue[], newRowid: number | bigint): void;
  deleted(row: readonly SqlValue[], rowid: number | bigint): void;
}

/**
 * The hooks that keep a table's history, writing `since` and `versions` (writers without hooks of their own). `now` is
 * the open transaction's commit id; `touched` notes that the transaction wrote history (it then records its commit).
 */
export function historyHooks(since: TableWriter, versions: TableWriter, now: () => number, touched: () => void): HistoryHooks {
  const startOf = (rowid: number | bigint): number => {
    const r = since.readRow(rowid);
    return r === null || r[0] === null ? 0 : Number(r[0]);
  };
  /** Close the current version of row `rowid` (its values `row`): keep it unless it started in this transaction. */
  const close = (row: readonly SqlValue[], rowid: number | bigint): number => {
    const from = startOf(rowid);
    const to = now();
    if (from !== to) versions.writeRow([rowid, from, to, ...row], versions.newRowid());
    return to;
  };
  return {
    inserted(_row, rowid) {
      touched();
      since.writeRow([now()], rowid);
    },
    updated(old, oldRowid, _next, newRowid) {
      touched();
      const to = close(old, oldRowid);
      if (oldRowid !== newRowid) since.deleteRow(oldRowid);
      since.writeRow([to], newRowid);
    },
    deleted(row, rowid) {
      touched();
      close(row, rowid);
      since.deleteRow(rowid);
    },
  };
}
