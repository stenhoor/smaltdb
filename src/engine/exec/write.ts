import { ConstraintError, type IndexSchema, type TableSchema } from '../catalog/schema.js';
import { SmaltError } from '../errors.js';
import { BTree } from '../storage/btree.js';
import { KeyEncoder, ROWID_KEY_SIZE, readNumericKeyAt, readRowidKey, writeRowidKey } from '../storage/key-codec.js';
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

  private indexKey(idx: IndexSchema, row: readonly SqlValue[], rowid: number | bigint | null): Uint8Array | null {
    const e = this.keyEnc.reset();
    for (const ic of idx.columns) {
      const v = row[ic.column];
      e.add(v, ic);
    }
    if (rowid === null) return e.finish();
    e.add(rowid);
    return e.finish();
  }

  /** Rowid of a row that conflicts with `row` on unique index `i`, or null. */
  private uniqueConflict(i: number, row: readonly SqlValue[], except: number | bigint | null): number | bigint | null {
    const idx = this.table.indexes[i];
    if (!idx.unique) return null;
    for (const ic of idx.columns) if (row[ic.column] === null) return null; // NULLs never conflict
    const prefix = this.indexKey(idx, row, null)!;
    const c = this.indexTrees[i].cursor();
    try {
      for (let ok = c.seek(prefix); ok; ok = c.next()) {
        c.loadKey();
        if (c.keyLength < prefix.length) return null;
        for (let j = 0; j < prefix.length; j++) if (c.keyBytes[c.keyOffset + j] !== prefix[j]) return null;
        const end = c.keyOffset + c.keyLength;
        const rowid = readNumericKeyAt(c.keyBytes, end - 11);
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
        const other = this.uniqueConflict(i, row, except);
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
    return this.uniqueConflict(target, row, except);
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

  /** Write a row whose conflicts were already resolved. */
  writeRow(row: SqlValue[], rowid: number | bigint): void {
    const t = this.table;
    const alias = t.rowidAlias;
    let saved: SqlValue = null;
    if (alias >= 0) {
      saved = row[alias];
      row[alias] = null; // the alias column lives in the key, not the record
    }
    this.tree.put(this.key(rowid), this.enc.encode(row));
    if (alias >= 0) row[alias] = saved;
    for (let i = 0; i < t.indexes.length; i++) this.indexTrees[i].put(this.indexKey(t.indexes[i], row, rowid)!, EMPTY);
    this.noteRowid(rowid);
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
    for (let i = 0; i < t.indexes.length; i++) this.indexTrees[i].delete(this.indexKey(t.indexes[i], row, rowid)!);
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
