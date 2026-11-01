/**
 * Columnar base tables (M7.3, ADR 0010): `CREATE TABLE … WITH (storage = 'columnar')`.
 *
 * A columnar table has three B+trees:
 * - the **delta store** (the table's `rootPage`): an ordinary row-format table tree. Every INSERT
 *   lands here, so the row write path, constraints and conflict handling are the usual ones;
 * - the **segments**: a column store (ADR 0008) holding the table's columns plus a final rowid
 *   column, in row groups of 8192 rows with zone maps;
 * - the **deletion tree**: rowids of segment rows that were deleted, or moved back to the delta
 *   store by an UPDATE (keys only).
 *
 * A scan reads the delta store, then the segments minus deleted rowids. Compaction moves full row
 * groups' worth of delta rows into new segments, and rewrites the segments when deletions pile up.
 */
import { SmaltError } from '../errors.js';
import type { TableSchema } from '../catalog/schema.js';
import type { BTree } from '../storage/btree.js';
import { type ColumnStore, ROW_GROUP_ROWS, chunkValue, zoneMayMatch } from '../storage/columnar.js';
import { ROWID_KEY_SIZE, readRowidKey, writeRowidKey } from '../storage/key-codec.js';
import type { Pager } from '../storage/pager.js';
import type { SqlValue } from '../values.js';
import { TableWriter } from './write.js';

export type Rowid = number | bigint;

const EMPTY = new Uint8Array(0);

/** Deleted segment rowids (null when there are none). Read per scan: deletions change with every write. */
export function loadDeleted(del: BTree): Set<Rowid> | null {
  const c = del.cursor();
  let out: Set<Rowid> | null = null;
  try {
    for (let ok = c.first(); ok; ok = c.next()) {
      c.loadKey();
      (out ??= new Set()).add(readRowidKey(c.keyBytes, c.keyOffset));
    }
  } finally {
    c.close();
  }
  return out;
}

/** Rowids of row group `rg` (numbers, or values when some are bigints). */
export function rowidsOf(store: ColumnStore, rg: number, rowidCol: number): ArrayLike<SqlValue> {
  const ch = store.chunk(rg, rowidCol);
  if (ch.num !== null && ch.nulls === null) return ch.num;
  const n = ch.count;
  const out: SqlValue[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = chunkValue(ch, i);
  return out;
}

/** Per-row deleted flags of row group `rg` (1 = deleted), or null when none of its rows are deleted. */
export function deletedBitmap(store: ColumnStore, rg: number, rowidCol: number, deleted: Set<Rowid> | null): Uint8Array | null {
  if (deleted === null) return null;
  const ids = rowidsOf(store, rg, rowidCol);
  let out: Uint8Array | null = null;
  for (let i = 0; i < ids.length; i++) {
    if (deleted.has(ids[i] as Rowid)) (out ??= new Uint8Array(ids.length))[i] = 1;
  }
  return out;
}

/** Where a rowid lives in the segments (ignoring deletions), or null. */
export function locateInSegments(store: ColumnStore, rowidCol: number, rowid: Rowid): { rg: number; i: number } | null {
  const n = store.rowGroups;
  for (let rg = 0; rg < n; rg++) {
    const m = store.meta(rg);
    if (!zoneMayMatch(m.zones[rowidCol], m.rows, '=', rowid, true)) continue;
    const ids = rowidsOf(store, rg, rowidCol);
    for (let i = 0; i < ids.length; i++) {
      // eslint-disable-next-line eqeqeq
      if (ids[i] == rowid) return { rg, i };
    }
  }
  return null;
}

/** Largest rowid in the segments (0 when empty). */
export function maxSegmentRowid(store: ColumnStore, rowidCol: number): Rowid {
  let max: Rowid = 0;
  const n = store.rowGroups;
  for (let rg = 0; rg < n; rg++) {
    const m = store.meta(rg);
    const z = m.zones[rowidCol];
    if (z.numMax !== undefined) {
      if (z.numMax > max) max = z.numMax;
      continue;
    }
    const ids = rowidsOf(store, rg, rowidCol);
    for (let i = 0; i < ids.length; i++) if ((ids[i] as Rowid) > max) max = ids[i] as Rowid;
  }
  return max;
}

/**
 * The write path of a columnar table: new rows go to the delta store (the base class); rows that
 * live in the segments are deleted by recording their rowid, and updated by deleting them there
 * and writing the new version to the delta store.
 */
export class ColumnarTableWriter extends TableWriter {
  private readonly rowidCol: number;
  private segMax: Rowid | null = null;
  private readonly delKey = new Uint8Array(ROWID_KEY_SIZE);

  constructor(
    table: TableSchema,
    pager: Pager,
    treeFor: (root: number) => BTree,
    private readonly store: ColumnStore,
    private readonly del: BTree,
    /** Called once the table has been written (compaction is checked at statement end). */
    private readonly touched: () => void,
  ) {
    super(table, pager, treeFor);
    this.rowidCol = table.columns.length;
  }

  private delKeyOf(rowid: Rowid): Uint8Array {
    writeRowidKey(this.delKey, 0, rowid);
    return this.delKey;
  }

  /** The segment position of a live (not deleted) segment row. */
  private segmentRow(rowid: Rowid): { rg: number; i: number } | null {
    this.segMax ??= maxSegmentRowid(this.store, this.rowidCol);
    if (rowid > this.segMax) return null; // new rowids (the common INSERT) skip the zone maps
    if (this.del.has(this.delKeyOf(rowid))) return null;
    return locateInSegments(this.store, this.rowidCol, rowid);
  }

  override newRowid(): Rowid {
    const n = super.newRowid();
    this.segMax ??= maxSegmentRowid(this.store, this.rowidCol);
    if (n > this.segMax) return n;
    const m = this.segMax;
    return typeof m === 'number' && Number.isSafeInteger(m + 1) ? m + 1 : BigInt(m) + 1n;
  }

  override rowExists(rowid: Rowid): boolean {
    return super.rowExists(rowid) || this.segmentRow(rowid) !== null;
  }

  override readRow(rowid: Rowid): SqlValue[] | null {
    const row = super.readRow(rowid);
    if (row !== null) return row;
    const at = this.segmentRow(rowid);
    if (at === null) return null;
    const t = this.table;
    const out: SqlValue[] = [];
    for (let c = 0; c < t.columns.length; c++) out.push(c === t.rowidAlias ? rowid : chunkValue(this.store.chunk(at.rg, c), at.i));
    return out;
  }

  override writeRow(row: SqlValue[], rowid: Rowid): void {
    super.writeRow(row, rowid);
    this.touched();
  }

  override updateRow(old: readonly SqlValue[], oldRowid: Rowid, next: SqlValue[], newRowid: Rowid): void {
    if (super.rowExists(oldRowid)) {
      super.updateRow(old, oldRowid, next, newRowid);
    } else {
      // A segment row: hide it there, write the new version to the delta store.
      this.del.put(this.delKeyOf(oldRowid), EMPTY);
      super.writeRow(next, newRowid);
    }
    this.touched();
  }

  override deleteRow(rowid: Rowid, knownRow?: readonly SqlValue[], silent = false, replace = false): boolean {
    if (super.rowExists(rowid)) {
      const ok = super.deleteRow(rowid, knownRow, silent, replace);
      this.touched();
      return ok;
    }
    const row = knownRow ?? this.readRow(rowid);
    if (row === null) return false;
    if (!silent) this.beforeDelete?.(row);
    this.del.put(this.delKeyOf(rowid), EMPTY);
    if (!silent) this.onDelete?.(row, replace);
    this.touched();
    return true;
  }

  override truncate(): number {
    throw new SmaltError('SMALT_INTERNAL', 'columnar tables are truncated by rewriting their segments');
  }
}

/** Rows per compaction step: delta rows move to the segments in whole row groups. */
export const COMPACT_ROWS = ROW_GROUP_ROWS;
