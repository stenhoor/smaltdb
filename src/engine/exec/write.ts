import { ConstraintError, type IndexSchema, type TableSchema } from '../catalog/schema.js';
import { SmaltError } from '../errors.js';
import { BTree } from '../storage/btree.js';
import { KeyEncoder, ROWID_KEY_SIZE, readIndexRowid, readRowidKey, writeRowidKey } from '../storage/key-codec.js';
import { RecordEncoder, RecordReader } from '../storage/record.js';
import type { Pager } from '../storage/pager.js';
import type { SqlValue } from '../values.js';

export type ConflictMode = 'ABORT' | 'FAIL' | 'IGNORE' | 'REPLACE' | 'ROLLBACK';

const I64_MAX = 2n ** 63n - 1n;
const EMPTY = new Uint8Array(0);

/**
 * Row-level writes for one table: record encoding, rowid assignment, unique-constraint checks,
 * and secondary index maintenance. Callers coerce values and check NOT NULL / CHECK first.
 */
export class TableWriter {
  readonly tree: BTree;
  private readonly indexTrees: BTree[];
  private readonly enc: RecordEncoder;
  private readonly reader: RecordReader;
  private readonly keyEnc = new KeyEncoder();
  private readonly rowidKey = new Uint8Array(ROWID_KEY_SIZE);
  /** Largest rowid known in this statement (avoids a descent per insert). */
  private maxRowid: number | bigint | null = null;

  constructor(
    readonly table: TableSchema,
    pager: Pager,
    treeFor: (root: number) => BTree = (root) => new BTree(pager, root),
  ) {
    this.tree = treeFor(table.rootPage);
    this.indexTrees = table.indexes.map((i) => treeFor(i.rootPage));
    this.enc = new RecordEncoder(table.layout);
    this.reader = new RecordReader(table.layout, table.recordDefaults);
  }

  private key(rowid: number | bigint): Uint8Array {
    writeRowidKey(this.rowidKey, 0, rowid);
    return this.rowidKey;
  }

  /** Forget cached state at the start of a statement execution. */
  resetStatement(): void {
    this.maxRowid = null;
  }

  newRowid(): number | bigint {
    if (this.maxRowid === null) {
      const c = this.tree.cursor();
      if (c.last()) {
        c.loadKey();
        this.maxRowid = readRowidKey(c.keyBytes, c.keyOffset);
      } else this.maxRowid = 0;
      c.close();
    }
    const m = this.maxRowid;
    if (typeof m === 'bigint' ? m >= I64_MAX : false) throw new SmaltError('SMALT_FULL', 'database or disk is full (rowid space exhausted)');
    const next = typeof m === 'number' ? (Number.isSafeInteger(m + 1) ? m + 1 : BigInt(m) + 1n) : m + 1n;
    return next;
  }

  private noteRowid(rowid: number | bigint): void {
    if (this.maxRowid !== null && rowid > this.maxRowid) this.maxRowid = rowid;
  }

  rowExists(rowid: number | bigint): boolean {
    return this.tree.has(this.key(rowid));
  }

  /** Decode a full row (all columns; the rowid alias column gets the rowid). */
  readRow(rowid: number | bigint): SqlValue[] | null {
    const c = this.tree.cursor();
    try {
      const k = this.key(rowid);
      if (!c.seek(k) || c.compareKey(k) !== 0) return null;
      c.loadValue();
      this.reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
      const out: SqlValue[] = [];
      for (let i = 0; i < this.table.columns.length; i++) out.push(i === this.table.rowidAlias ? rowid : this.reader.column(i));
      return out;
    } finally {
      c.close();
    }
  }

  /** Index column values of a row (expressions evaluated), or null when a partial index excludes it. */
  private indexValues(idx: IndexSchema, row: readonly SqlValue[], rowid: number | bigint): SqlValue[] | null {
    const ev = idx.eval;
    if (ev?.where && !ev.where(row, rowid)) return null;
    const out: SqlValue[] = [];
    for (let i = 0; i < idx.columns.length; i++) {
      const f = ev?.cols[i];
      out.push(f ? f(row, rowid) : row[idx.columns[i].column]);
    }
    return out;
  }

  /** Index key of a row (with the rowid suffix unless `prefixOnly`); null when a partial index excludes the row. */
  private indexKey(idx: IndexSchema, row: readonly SqlValue[], rowid: number | bigint, prefixOnly = false): Uint8Array | null {
    const e = this.keyEnc.reset();
    if (idx.eval) {
      const vals = this.indexValues(idx, row, rowid);
      if (vals === null) return null;
      idx.columns.forEach((ic, i) => e.add(vals[i], ic));
    } else {
      for (const ic of idx.columns) e.add(row[ic.column], ic);
    }
    if (!prefixOnly) e.addRowid(rowid);
    return e.finish();
  }

  /** @internal Index entry for a row (CREATE INDEX on a populated table); null if excluded. */
  indexEntry(idx: IndexSchema, row: readonly SqlValue[], rowid: number | bigint): Uint8Array | null {
    const k = this.indexKey(idx, row, rowid);
    return k && k.slice();
  }

  /** Rowid of a row that conflicts with `row` on unique index `i`, or null. */
  private uniqueConflict(i: number, row: readonly SqlValue[], except: number | bigint | null, rowid?: number | bigint): number | bigint | null {
    const idx = this.table.indexes[i];
    if (!idx.unique) return null;
    const rid = rowid ?? rowidHint(row, this.table);
    const vals = idx.eval ? this.indexValues(idx, row, rid) : idx.columns.map((ic) => row[ic.column]);
    if (vals === null) return null; // not in this partial index
    for (const v of vals) if (v === null) return null; // NULLs never conflict
    const prefix = this.indexKey(idx, row, rid, true)!;
    const c = this.indexTrees[i].cursor();
    try {
      for (let ok = c.seek(prefix); ok; ok = c.next()) {
        c.loadKey();
        if (c.keyLength < prefix.length) return null;
        for (let j = 0; j < prefix.length; j++) if (c.keyBytes[c.keyOffset + j] !== prefix[j]) return null;
        const end = c.keyOffset + c.keyLength;
        const rowid = readIndexRowid(c.keyBytes, end);
        // eslint-disable-next-line eqeqeq
        if (except !== null && rowid == except) continue;
        return rowid;
      }
      return null;
    } finally {
      c.close();
    }
  }

  private conflictMessage(idx: IndexSchema | null): string {
    const t = this.table;
    if (idx === null) {
      const name = t.rowidAlias >= 0 ? t.columns[t.rowidAlias].name : 'rowid';
      return `UNIQUE constraint failed: ${t.name}.${name}`;
    }
    // Like SQLite, expression indexes are named rather than listed by column.
    if (idx.columns.some((c) => c.column < 0)) return `UNIQUE constraint failed: index '${idx.name}'`;
    return `UNIQUE constraint failed: ${idx.columns.map((c) => `${t.name}.${t.columns[c.column].name}`).join(', ')}`;
  }

  private conflictCode(idx: IndexSchema | null): string {
    return idx === null || idx.origin === 'pk' ? 'SMALT_CONSTRAINT_PRIMARYKEY' : 'SMALT_CONSTRAINT_UNIQUE';
  }

  /**
   * Resolve uniqueness conflicts for writing `row` at `rowid` (ignoring row `except`).
   * Returns false if the row must be skipped (IGNORE). REPLACE deletes conflicting rows.
   */
  resolveConflicts(row: readonly SqlValue[], rowid: number | bigint, except: number | bigint | null, mode: ConflictMode): boolean {
    // eslint-disable-next-line eqeqeq
    if ((except === null || rowid != except) && this.rowExists(rowid)) {
      if (mode === 'IGNORE') return false;
      if (mode === 'REPLACE') this.deleteRow(rowid, undefined, false, true);
      else throw new ConstraintError(this.conflictCode(null), this.conflictMessage(null));
    }
    for (let i = 0; i < this.table.indexes.length; i++) {
      for (;;) {
        const other = this.uniqueConflict(i, row, except, rowid);
        if (other === null) break;
        if (mode === 'IGNORE') return false;
        if (mode !== 'REPLACE') {
          throw new ConstraintError(this.conflictCode(this.table.indexes[i]), this.conflictMessage(this.table.indexes[i]));
        }
        this.deleteRow(other, undefined, false, true);
      }
    }
    return true;
  }

  /**
   * Rowid of the row that `row` would collide with on one constraint: `target` -1 is the rowid /
   * INTEGER PRIMARY KEY, otherwise an index position in `table.indexes`. Null when none.
   */
  conflictOn(target: number, row: readonly SqlValue[], rowid: number | bigint, except: number | bigint | null): number | bigint | null {
    if (target < 0) {
      // eslint-disable-next-line eqeqeq
      return (except === null || rowid != except) && this.rowExists(rowid) ? rowid : null;
    }
    return this.uniqueConflict(target, row, except, rowid);
  }

  /** First conflicting constraint (rowid, then unique indexes in order), or null. */
  firstConflict(row: readonly SqlValue[], rowid: number | bigint, except: number | bigint | null): { target: number; rowid: number | bigint } | null {
    for (let t = -1; t < this.table.indexes.length; t++) {
      const other = this.conflictOn(t, row, rowid, except);
      if (other !== null) return { target: t, rowid: other };
    }
    return null;
  }

  /** Re-encode a row's record in place (index entries are left untouched; ALTER TABLE DROP COLUMN). */
  rewriteRecord(row: SqlValue[], rowid: number | bigint): void {
    const alias = this.table.rowidAlias;
    let saved: SqlValue = null;
    if (alias >= 0) {
      saved = row[alias];
      row[alias] = null;
    }
    this.tree.put(this.key(rowid), this.enc.encode(row));
    if (alias >= 0) row[alias] = saved;
  }

  private readonly newKeys: (Uint8Array | null)[] = [];

  /** Write a row whose conflicts were already resolved. */
  writeRow(row: SqlValue[], rowid: number | bigint): void {
    const t = this.table;
    // Index keys first: evaluating an index expression or an oversized key fails before anything
    // is written, so a single-row INSERT needs no statement journal (Database.compile).
    const keys = this.newKeys;
    keys.length = 0;
    for (let i = 0; i < t.indexes.length; i++) {
      const k = this.indexKey(t.indexes[i], row, rowid);
      if (k && k.length > this.indexTrees[i].maxKeySize) throw new SmaltError('SMALT_TOOBIG', `index key too large for index ${t.indexes[i].name}`);
      keys.push(k && (t.indexes.length === 1 ? k : k.slice()));
    }
    const alias = t.rowidAlias;
    let saved: SqlValue = null;
    if (alias >= 0) {
      saved = row[alias];
      row[alias] = null; // the alias column lives in the key, not the record
    }
    this.tree.put(this.key(rowid), this.enc.encode(row));
    if (alias >= 0) row[alias] = saved;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (k) this.indexTrees[i].put(k, EMPTY);
    }
    this.noteRowid(rowid);
  }

  /**
   * Replace row `oldRowid` (currently `old`, conflicts already resolved) with `next`. Index entries
   * whose key is unchanged are left alone and a same-size record is overwritten in place.
   */
  updateRow(old: readonly SqlValue[], oldRowid: number | bigint, next: SqlValue[], newRowid: number | bigint): void {
    if (oldRowid !== newRowid) {
      this.deleteRow(oldRowid, old, true);
      this.writeRow(next, newRowid);
      return;
    }
    const t = this.table;
    for (let i = 0; i < t.indexes.length; i++) {
      const ok = this.indexKey(t.indexes[i], old, oldRowid);
      const oldKey = ok && ok.slice();
      const nk = this.indexKey(t.indexes[i], next, newRowid);
      if (oldKey && nk && oldKey.length === nk.length && oldKey.every((b, j) => b === nk[j])) continue;
      const newKey = nk && nk.slice();
      if (oldKey) this.indexTrees[i].delete(oldKey);
      if (newKey) this.indexTrees[i].put(newKey, EMPTY);
    }
    const alias = t.rowidAlias;
    let saved: SqlValue = null;
    if (alias >= 0) {
      saved = next[alias];
      next[alias] = null;
    }
    this.tree.put(this.key(newRowid), this.enc.encode(next));
    if (alias >= 0) next[alias] = saved;
  }

  /** Foreign-key hooks around a deletion (not called for the delete half of an UPDATE). */
  beforeDelete?: (row: readonly SqlValue[]) => void;
  /** `replace`: the row was removed by a REPLACE conflict (foreign-key actions do not fire then). */
  onDelete?: (row: readonly SqlValue[], replace: boolean) => void;

  /**
   * Delete a row by rowid (reads it first to remove its index entries). Returns false if absent.
   * `silent` skips {@link onDelete} (the row is being replaced by an UPDATE).
   */
  deleteRow(rowid: number | bigint, knownRow?: readonly SqlValue[], silent = false, replace = false): boolean {
    const row = knownRow ?? this.readRow(rowid);
    if (row === null) return false;
    if (!silent) this.beforeDelete?.(row);
    const t = this.table;
    for (let i = 0; i < t.indexes.length; i++) {
      const k = this.indexKey(t.indexes[i], row, rowid);
      if (k) this.indexTrees[i].delete(k);
    }
    this.tree.delete(this.key(rowid));
    if (!silent) this.onDelete?.(row, replace);
    return true;
  }

  /** Delete every row; returns the number of rows removed. */
  truncate(): number {
    const n = this.tree.count();
    this.tree.clear();
    for (const t of this.indexTrees) t.clear();
    this.maxRowid = 0;
    return n;
  }
}

/** The rowid a row will have (its INTEGER PRIMARY KEY), for evaluating index expressions; 0 otherwise. */
function rowidHint(row: readonly SqlValue[], t: TableSchema): number | bigint {
  const v = t.rowidAlias >= 0 ? row[t.rowidAlias] : null;
  return typeof v === 'number' || typeof v === 'bigint' ? v : 0;
}

