/**
 * Foreign-key enforcement, following SQLite's algorithm (https://sqlite.org/foreignkeys.html):
 *
 * - Violations of immediate constraints are counted during a statement (`stmt`) and checked when it
 *   ends, so a statement may pass through temporary violations (e.g. deleting a parent and its
 *   children in either order). DEFERRABLE INITIALLY DEFERRED constraints use `deferred`, checked at
 *   COMMIT.
 * - Child side: a new child row whose (non-NULL) key has no parent adds a violation; removing a child
 *   row whose key has no parent removes one.
 * - Parent side: removing (or re-keying) a parent row applies the constraint's action. NO ACTION adds
 *   one violation per child row; RESTRICT fails immediately; CASCADE / SET NULL / SET DEFAULT update
 *   the children through ordinary (recursive) DELETE / UPDATE statements. A new parent key resolves
 *   outstanding violations of matching children.
 */
import { ConstraintError, type ForeignKeySchema, type TableSchema, findColumn } from '../catalog/schema.js';
import { SmaltError } from '../errors.js';
import { agg, aggregate, and, filter, limit, lit, param, project, remove, scan, update } from '../plan/build.js';
import { call, col, type PlanExpr } from '../plan/expr.js';
import type { PlanOp } from '../plan/ops.js';
import type { SqlValue } from '../values.js';
import { affinityOfStorage, applyNumericAffinity, staticTypeOfStorage } from './convert.js';
import { CollSrc, type SqlOperand, collationName, comparisonCollation, comparisonConverters, withMeta } from './expr.js';

export interface FkHost {
  getTable(name: string): TableSchema | undefined;
  allTables(): TableSchema[];
  /**
   * Run an internal query or write plan with positional parameters, inside the current statement: its rows (a
   * write's: none). The same plan object is run many times: its program may be cached by identity.
   */
  run(plan: PlanOp, params: SqlValue[]): SqlValue[][];
  /** A column's DEFAULT as a plan expression (SET DEFAULT), or null for none. */
  defaultValue(t: TableSchema, column: number): PlanExpr | null;
}

/** The plans a foreign key runs, built once per schema version. */
interface LinkPlans {
  parentHas: PlanOp;
  childCount: PlanOp;
  deleteChildren: PlanOp;
  /** UPDATE child SET key = params[k..] (ON UPDATE CASCADE). */
  rekeyChildren: PlanOp;
  setNull: PlanOp;
  setDefault: PlanOp;
}

/** A foreign key with both ends resolved to column positions. */
interface Link {
  child: TableSchema;
  fk: ForeignKeySchema;
  parent: TableSchema;
  childCols: number[];
  parentCols: number[];
  deferred: boolean;
  plans?: LinkPlans;
}

export class ForeignKeys {
  enabled = true;
  /** Outstanding violations of immediate constraints in the current statement. */
  stmt = 0;
  /** Outstanding violations of deferred constraints in the current transaction. */
  deferred = 0;
  private version = -1;
  private childLinks = new Map<string, Link[]>();
  private parentLinks = new Map<string, Link[]>();

  constructor(private readonly host: FkHost) {}

  /** Recompute relationships when the schema changed. */
  sync(schemaVersion: number): void {
    if (schemaVersion === this.version) return;
    this.version = schemaVersion;
    this.involvedCache = new WeakMap();
    this.childLinks = new Map();
    this.parentLinks = new Map();
    for (const child of this.host.allTables()) {
      for (const fk of child.foreignKeys) {
        const key = child.name.toLowerCase();
        const parentKey = fk.table.toLowerCase();
        const lazy = { child, fk } as Link;
        if (!this.childLinks.has(key)) this.childLinks.set(key, []);
        this.childLinks.get(key)!.push(lazy);
        if (!this.parentLinks.has(parentKey)) this.parentLinks.set(parentKey, []);
        this.parentLinks.get(parentKey)!.push(lazy);
      }
    }
    // SQLite keeps the constraints referencing a table newest first, and applies actions in that order.
    for (const list of this.parentLinks.values()) list.reverse();
  }

  /** Whether writes to `t` need foreign-key processing (cached per table; called for every written row). */
  involved(t: TableSchema): boolean {
    if (!this.enabled) return false;
    let v = this.involvedCache.get(t);
    if (v === undefined) {
      const k = t.name.toLowerCase();
      v = this.childLinks.has(k) || this.parentLinks.has(k);
      this.involvedCache.set(t, v);
    }
    return v;
  }
  private involvedCache = new WeakMap<TableSchema, boolean>();

  /** Resolve a link's parent table and key columns (errors like SQLite when they do not match a key). */
  private resolve(l: Link): Link {
    if (l.parent) return l;
    const parent = this.host.getTable(l.fk.table);
    if (!parent) throw new SmaltError('SMALT_ERROR', `no such table: main.${l.fk.table}`);
    const mismatch = (): never => {
      throw new SmaltError('SMALT_ERROR', `foreign key mismatch - "${l.child.name}" referencing "${parent.name}"`);
    };
    let parentCols: number[];
    if (l.fk.refColumns) {
      parentCols = l.fk.refColumns.map((n) => {
        const i = findColumn(parent, n);
        return i < 0 ? mismatch() : i;
      });
    } else if (parent.rowidAlias >= 0) parentCols = [parent.rowidAlias];
    else {
      const pk = parent.indexes.find((i) => i.origin === 'pk');
      parentCols = pk ? pk.columns.map((c) => c.column) : mismatch();
    }
    if (parentCols.length !== l.fk.columns.length) mismatch();
    // The parent key must be the rowid alias or have a UNIQUE / PRIMARY KEY index on exactly those columns.
    const set = new Set(parentCols);
    const keyed =
      (parentCols.length === 1 && parentCols[0] === parent.rowidAlias) ||
      parent.indexes.some((i) => i.unique && i.columns.length === set.size && i.columns.every((c) => set.has(c.column)));
    if (!keyed) mismatch();
    Object.assign(l, { parent, childCols: l.fk.columns, parentCols, deferred: l.fk.deferrable });
    return l;
  }

  private plans(l: Link): LinkPlans {
    return (l.plans ??= linkPlans(l, this.host));
  }

  private parentHas(l: Link, key: SqlValue[]): boolean {
    return this.host.run(this.plans(l).parentHas, key).length > 0;
  }

  private childCount(l: Link, key: SqlValue[]): number {
    return Number(this.host.run(this.plans(l).childCount, key)[0][0]);
  }

  private add(l: Link, n: number): void {
    if (l.deferred) this.deferred += n;
    else this.stmt += n;
  }

  private outstanding(l: Link): boolean {
    return l.deferred ? this.deferred > 0 : this.stmt > 0;
  }

  private childKey(l: Link, row: readonly SqlValue[]): SqlValue[] | null {
    const k = l.childCols.map((c) => row[c]);
    return k.some((v) => v === null) ? null : k;
  }

  // ---------------------------------------------------------------- events

  afterInsert(t: TableSchema, row: readonly SqlValue[]): void {
    for (const lazy of this.childLinks.get(t.name.toLowerCase()) ?? []) {
      const l = this.resolve(lazy);
      const key = this.childKey(l, row);
      if (key && !this.parentHas(l, key)) this.add(l, 1);
    }
    for (const lazy of this.parentLinks.get(t.name.toLowerCase()) ?? []) {
      // A new parent row can only resolve existing violations; like SQLite, look only when there are some.
      if (!(lazy.fk.deferrable ? this.deferred > 0 : this.stmt > 0)) continue;
      const l = this.resolve(lazy);
      const key = l.parentCols.map((c) => row[c]);
      if (key.some((v) => v === null)) continue;
      this.add(l, -this.childCount(l, key));
    }
  }

  /**
   * Before a row of `t` is removed: the child-side check runs while the row still exists, so a row
   * that references itself does not count as resolving a violation (SQLite does the same).
   */
  beforeDelete(t: TableSchema, row: readonly SqlValue[]): void {
    for (const lazy of this.childLinks.get(t.name.toLowerCase()) ?? []) {
      const l = this.resolve(lazy);
      const key = this.childKey(l, row);
      if (key && !this.parentHas(l, key)) this.add(l, -1);
    }
  }

  /**
   * After a row of `t` was removed. Children still referencing it count as violations; `actions`
   * applies ON DELETE actions (false for rows removed by a REPLACE conflict, where SQLite's
   * action triggers do not fire).
   */
  afterDelete(t: TableSchema, row: readonly SqlValue[], actions = true): void {
    const gone: { l: Link; key: SqlValue[] }[] = [];
    for (const lazy of this.parentLinks.get(t.name.toLowerCase()) ?? []) {
      const l = this.resolve(lazy);
      const key = l.parentCols.map((c) => row[c]);
      if (!key.some((v) => v === null)) gone.push({ l, key });
    }
    // Like SQLite: every constraint is counted (and RESTRICT checked) before any action runs.
    const counted = gone.map((g) => this.countGone(g.l, g.key, actions ? g.l.fk.onDelete : 'NO ACTION'));
    if (actions) gone.forEach((g, i) => counted[i] > 0 && this.applyAction(g.l, g.key, g.l.fk.onDelete, null));
  }

  afterUpdate(t: TableSchema, oldRow: readonly SqlValue[], newRow: readonly SqlValue[]): void {
    const changed = (cols: number[]): boolean => cols.some((c) => !sameValue(oldRow[c], newRow[c]));
    for (const lazy of this.childLinks.get(t.name.toLowerCase()) ?? []) {
      const l = this.resolve(lazy);
      if (!changed(l.childCols)) continue;
      const oldKey = this.childKey(l, oldRow);
      if (oldKey && !this.parentHas(l, oldKey)) this.add(l, -1);
      const newKey = this.childKey(l, newRow);
      if (newKey && !this.parentHas(l, newKey)) this.add(l, 1);
    }
    const moved: { l: Link; oldKey: SqlValue[]; newKey: SqlValue[] }[] = [];
    for (const lazy of this.parentLinks.get(t.name.toLowerCase()) ?? []) {
      const l = this.resolve(lazy);
      if (!changed(l.parentCols)) continue;
      moved.push({ l, oldKey: l.parentCols.map((c) => oldRow[c]), newKey: l.parentCols.map((c) => newRow[c]) });
    }
    // Count every constraint first (old key: new violations; new key: orphans it resolves), then act.
    const counted = moved.map((m) => {
      const n = m.oldKey.some((v) => v === null) ? 0 : this.countGone(m.l, m.oldKey, m.l.fk.onUpdate);
      if (this.outstanding(m.l) && !m.newKey.some((v) => v === null)) this.add(m.l, -this.childCount(m.l, m.newKey));
      return n;
    });
    moved.forEach((m, i) => {
      if (counted[i] > 0) this.applyAction(m.l, m.oldKey, m.l.fk.onUpdate, m.newKey);
    });
  }

  /**
   * The parent key `key` disappeared (deleted, or changed): as in SQLite, every child row becomes a
   * violation. Returns the number of children.
   */
  private countGone(l: Link, key: SqlValue[], _action: ForeignKeySchema['onDelete']): number {
    const n = this.childCount(l, key);
    if (n > 0) this.add(l, n);
    return n;
  }

  /**
   * Apply a CASCADE / SET NULL / SET DEFAULT action to the children of `key` (changed to `newKey`
   * for ON UPDATE). The child-side checks of those writes resolve the violations counted above.
   */
  private applyAction(l: Link, key: SqlValue[], action: ForeignKeySchema['onDelete'], newKey: SqlValue[] | null): void {
    const p = this.plans(l);
    switch (action) {
      case 'CASCADE':
        if (newKey === null) this.host.run(p.deleteChildren, key);
        else this.host.run(p.rekeyChildren, [...key, ...newKey]);
        return;
      case 'SET NULL':
        this.host.run(p.setNull, key);
        return;
      case 'SET DEFAULT':
        this.host.run(p.setDefault, key);
        return;
      case 'RESTRICT':
        // Checked when its turn comes: an earlier action may already have removed the children.
        if (this.childCount(l, key) > 0) throw new ConstraintError('SMALT_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed');
        return;
      default:
        // NO ACTION: the counted violations stand unless fixed before the statement ends.
        return;
    }
  }

  /** End of a statement: immediate violations fail it. */
  checkStatement(): void {
    const n = this.stmt;
    this.stmt = 0;
    if (n > 0) throw new ConstraintError('SMALT_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed');
  }

  checkCommit(): void {
    if (this.deferred > 0) throw new ConstraintError('SMALT_CONSTRAINT_FOREIGNKEY', 'FOREIGN KEY constraint failed');
  }
}

function sameValue(a: SqlValue, b: SqlValue): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  // eslint-disable-next-line eqeqeq
  return (typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint') && a == b;
}

/**
 * A table column as SQL reads it in a comparison: its static type, and its collation and affinity as SQL metadata
 * (exec/sql-meta.ts), as the SQL front end binds a column reference.
 */
function columnRef(t: TableSchema, c: number, at: number): { e: PlanExpr; operand: SqlOperand } {
  const cs = t.columns[c];
  const type = cs.rowidAlias ? 'int' : staticTypeOfStorage(cs.type);
  const affinity = affinityOfStorage(cs.type);
  const e = withMeta(col(0, at, type, collationName(cs.collation)), { collation: cs.collation, collSrc: CollSrc.Column, affinity });
  return { e, operand: { type, collation: cs.collation, collSrc: CollSrc.Column, affinity } };
}

/** `column = param` with SQL's comparison rules: the column's collation, its affinity applied to the parameter. */
function keyEquals(t: TableSchema, c: number, at: number, paramIndex: number): PlanExpr {
  const { e, operand } = columnRef(t, c, at);
  const p = param(paramIndex);
  const coll = comparisonCollation(operand, { type: 'any', collation: 0, collSrc: CollSrc.None, affinity: 'NONE' });
  const [, conv] = comparisonConverters(operand, { type: 'any', collation: 0, collSrc: CollSrc.None, affinity: 'NONE' });
  const right = conv === null ? p : call(conv === applyNumericAffinity ? 'affinity_numeric' : 'affinity_text', [p], 'any');
  return call('cmp_eq', [e, right], 'int', collationName(coll));
}

/** The rows of `t` whose `cols` equal parameters 0.., as a filter over a scan of `columns` of `t` (`at` maps). */
function keyFilter(t: TableSchema, cols: number[], columns: number[]): PlanOp {
  const conds = cols.map((c, i) => keyEquals(t, c, columns.indexOf(c), i));
  return filter(scan(t.name, columns), conds.length === 1 ? conds[0] : and(...conds));
}

function linkPlans(l: Link, host: FkHost): LinkPlans {
  const { child, parent } = l;
  const n = child.columns.length;
  const all = [...child.columns.keys(), -1];
  const k = l.childCols.length;
  const childUpdate = (value: (c: number, i: number) => PlanExpr): PlanOp => update(child.name, keyFilter(child, l.childCols, all), n, l.childCols.map((c, i) => ({ column: c, value: value(c, i) })));
  return {
    // SELECT 1 FROM parent WHERE key = ? LIMIT 1
    parentHas: limit(project(keyFilter(parent, l.parentCols, l.parentCols), [lit(1)]), 1),
    // SELECT count(*) FROM child WHERE key = ?
    childCount: aggregate(keyFilter(child, l.childCols, l.childCols), [], [agg('count', [], 'int', { star: true })]),
    deleteChildren: remove(child.name, keyFilter(child, l.childCols, [...l.childCols, -1]), k),
    rekeyChildren: childUpdate((_c, i) => param(k + i)),
    setNull: childUpdate(() => lit(null)),
    setDefault: childUpdate((c) => host.defaultValue(child, c) ?? lit(null)),
  };
}
