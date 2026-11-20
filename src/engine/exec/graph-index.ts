/**
 * Graph indexes (ADR 0040, section 1): each property graph's relationships in memory, by node, in both directions
 * (exec/graph-lists.ts). An index is derived from the graph's edge tables and never written to the file:
 *
 * - **Built** on first use, from each edge table's endpoint indexes read in key order (or from the table, sorted, where
 *   one is missing).
 * - **Kept** as rows are written: the table's writer reports every insert, update and delete (exec/write.ts).
 * - **Dropped**, and built again on next use, when it can no longer be trusted: a rollback that may have undone a
 *   change to it, another connection's commit (the pager's change counter moved), a change to the graph's edge tables.
 * - **Not held** for a graph whose ids it can't (they are integers from 0 to 2^31 - 1), whose tables are columnar or
 *   TEMP, or that needs more memory than the limit. Its plans then run on the B+trees.
 *
 * It also holds the graph's label index, where that table has a unique index on its node and label: which nodes have
 * which labels (exec/graph-labels.ts), built, kept and dropped with the relationships.
 */
import { type IndexSchema, type TableSchema, findColumn } from '../catalog/schema.js';
import { SmaltError } from '../errors.js';
import type { PropertyGraphDef } from '../plan/schema.js';
import type { BTree } from '../storage/btree.js';
import { decodeSmallRun } from '../storage/key-codec.js';
import { Collation, type SqlValue } from '../values.js';
import { GraphLabels } from './graph-labels.js';
import { GraphLists } from './graph-lists.js';

export interface GraphIndexHost {
  schemaVersion(): number;
  graphs(): readonly PropertyGraphDef[];
  getTable(name: string): TableSchema | undefined;
  openTree(root: number): BTree;
  /** The pager's change counter: every commit moves it, another connection's too. */
  changeCounter(): number;
  /** Whether there are uncommitted changes. */
  uncommitted(): boolean;
  /** Every row of a table as [column a, column b, rowid], for a table without an endpoint index. */
  rows(table: TableSchema, a: number, b: number): SqlValue[][];
}

/** The largest id an index holds. */
const MAX_ID = 2 ** 31 - 1;

const isId = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= MAX_ID && Number.isInteger(v);

interface EdgeTable {
  table: TableSchema;
  start: number;
  end: number;
}

/** A graph's label index table, with its node and label columns. */
interface LabelTable {
  table: TableSchema;
  node: number;
  label: number;
}

/** One graph's index. */
export class GraphIndex {
  /** The graph's edge tables with their roots and endpoint columns: the index is of these. */
  signature = '';
  edges: EdgeTable[] = [];
  /** By start node and by end node. Null until built. */
  out: GraphLists | null = null;
  in: GraphLists | null = null;
  /** The graph's label index table, when it can be held, and its entries: built and dropped with the lists. */
  labelTable: LabelTable | null = null;
  labels: GraphLabels | null = null;
  /** Why the graph isn't indexed, until its edge tables change. */
  off: string | null = null;
  /** It may hold changes that aren't committed. */
  dirty = false;
  /** The pager's change counter it is of. */
  counter = -1;
  /** How many times it was built (tests). */
  builds = 0;

  constructor(readonly name: string) {}

  drop(): void {
    this.out = this.in = null;
    this.labels = null;
    this.dirty = false;
  }

  bytes(): number {
    return this.out === null ? 0 : this.out.bytes() + this.in!.bytes() + (this.labels?.bytes() ?? 0);
  }
}

/** An edge table's place in a graph's index. */
export interface EdgeRole {
  readonly graph: GraphIndex;
  /** The table's position among the graph's edge tables. */
  readonly type: number;
  readonly table: TableSchema;
  readonly start: number;
  readonly end: number;
}

/** A label index table's place in a graph's index. */
export interface LabelRole {
  readonly graph: GraphIndex;
  readonly table: TableSchema;
  readonly node: number;
  readonly label: number;
}

/**
 * The unique index a label index table has on its node and label, in either order: with it a node has a label at most
 * once, which a set of nodes per label can hold.
 */
export function labelKeyIndex(table: TableSchema, node: number, label: number): IndexSchema | undefined {
  return table.indexes.find(
    (x) =>
      x.unique &&
      !x.where &&
      !x.eval &&
      x.columns.length === 2 &&
      x.columns.every((c) => !c.desc && c.collation === Collation.Binary) &&
      ((x.columns[0]!.column === node && x.columns[1]!.column === label) || (x.columns[0]!.column === label && x.columns[1]!.column === node)),
  );
}

/** The index a table has on (a, b), ascending and whole: its entries are (a, b, rowid) in order. */
export function endpointIndex(table: TableSchema, a: number, b: number): IndexSchema | undefined {
  return table.indexes.find(
    (x) =>
      !x.where &&
      !x.eval &&
      x.columns.length === 2 &&
      x.columns[0]!.column === a &&
      x.columns[1]!.column === b &&
      x.columns.every((c) => !c.desc && c.collation === Collation.Binary),
  );
}

export class GraphIndexes {
  private version = -1;
  /** Tests: while set, no index is read (scans read the B+trees); the indexes are still kept. */
  suspended = false;
  private roles = new Map<TableSchema, EdgeRole[]>();
  private labelRoles = new Map<TableSchema, LabelRole[]>();
  private readonly graphs = new Map<string, GraphIndex>();

  constructor(
    private readonly host: GraphIndexHost,
    /** Bytes all of a graph's lists may take; 0 turns the indexes off. */
    readonly limit: number,
  ) {}

  private refresh(): void {
    const v = this.host.schemaVersion();
    if (v === this.version) return;
    this.version = v;
    this.roles = new Map();
    this.labelRoles = new Map();
    const seen = new Set<string>();
    for (const def of this.host.graphs()) {
      const key = def.name.toLowerCase();
      seen.add(key);
      let g = this.graphs.get(key);
      if (!g) this.graphs.set(key, (g = new GraphIndex(def.name)));
      const edges: EdgeTable[] = [];
      let off: string | null = null;
      for (const e of def.edges) {
        const table = this.host.getTable(e.table);
        if (!table) {
          off = `its edge table ${e.table} is missing`;
          break;
        }
        const start = findColumn(table, e.start);
        const end = findColumn(table, e.end);
        if (start < 0 || end < 0) off = `${table.name} lacks an endpoint column`;
        else if (table.columnar) off = `${table.name} is columnar`;
        else if (table.temp) off = `${table.name} is a TEMP table`;
        edges.push({ table, start, end });
      }
      // The label index, where it can be held: a row table with a unique index on its node and label.
      let labelTable: LabelTable | null = null;
      const l = def.labels && this.host.getTable(def.labels.table);
      if (def.labels && l && !l.columnar && !l.temp) {
        const node = findColumn(l, def.labels.node);
        const label = findColumn(l, def.labels.label);
        if (node >= 0 && label >= 0 && labelKeyIndex(l, node, label)) labelTable = { table: l, node, label };
      }
      const labelPart = labelTable ? `${labelTable.table.name.toLowerCase()}:${labelTable.table.rootPage}:${labelTable.node}:${labelTable.label}` : '';
      const signature = off ?? `${labelPart}#${edges.map((e) => `${e.table.name.toLowerCase()}:${e.table.rootPage}:${e.start}:${e.end}`).join('|')}`;
      if (signature !== g.signature) {
        // A graph that only gained edge tables keeps its lists: the new types are read from their tables.
        const kept = g.out !== null && off === null && g.off === null && g.edges.length > 0 && signature.startsWith(`${g.signature}|`) ? g.edges.length : -1;
        g.signature = signature;
        g.off = off;
        g.edges = edges;
        g.labelTable = labelTable;
        if (kept < 0) g.drop();
        else if (!this.fill(g, kept)) g.drop();
        else if (this.host.uncommitted()) g.dirty = true;
      } else {
        g.edges = edges;
        g.labelTable = labelTable;
      }
      if (g.off === null) {
        edges.forEach((e, type) => {
          const role: EdgeRole = { graph: g, type, table: e.table, start: e.start, end: e.end };
          const list = this.roles.get(e.table);
          if (list) list.push(role);
          else this.roles.set(e.table, [role]);
        });
        if (labelTable) {
          const role: LabelRole = { graph: g, ...labelTable };
          const list = this.labelRoles.get(labelTable.table);
          if (list) list.push(role);
          else this.labelRoles.set(labelTable.table, [role]);
        }
      }
    }
    for (const k of [...this.graphs.keys()]) if (!seen.has(k)) this.graphs.delete(k);
  }

  /** The table's roles as an edge table of indexed graphs. Undefined for any other table, and with the indexes off. */
  rolesOf(table: TableSchema): readonly EdgeRole[] | undefined {
    if (this.limit <= 0) return undefined;
    this.refresh();
    return this.roles.size === 0 ? undefined : this.roles.get(table);
  }

  /** The table's roles as the label index of indexed graphs. Undefined for any other table, and with the indexes off. */
  labelRolesOf(table: TableSchema): readonly LabelRole[] | undefined {
    if (this.limit <= 0) return undefined;
    this.refresh();
    return this.labelRoles.size === 0 ? undefined : this.labelRoles.get(table);
  }

  /**
   * The graph's lists, to read: built now if they aren't. Null when the graph isn't indexed; its reader then reads the
   * B+trees.
   */
  open(g: GraphIndex): GraphIndex | null {
    if (g.off !== null || this.suspended) return null;
    const counter = this.host.changeCounter();
    if (g.out !== null) {
      if (g.counter === counter) return g;
      // Another connection committed.
      g.drop();
    }
    g.out = new GraphLists();
    g.in = new GraphLists();
    g.labels = g.labelTable ? new GraphLabels() : null;
    g.counter = counter;
    g.builds++;
    if (!this.fill(g, 0)) {
      g.drop();
      return null;
    }
    // Built inside a transaction that wrote, it may hold what a rollback undoes.
    g.dirty = this.host.uncommitted();
    return g;
  }

  /**
   * Reads the edge tables from position `from` on into the lists and, from the start, the label index into its sets.
   * False, with `off` set, when they can't hold them.
   */
  private fill(g: GraphIndex, from: number): boolean {
    const out = g.out!;
    const inn = g.in!;
    const run = new Float64Array(3);
    if (from === 0 && g.labelTable && g.labels) {
      const t = g.labelTable;
      for (const r of this.host.rows(t.table, t.node, t.label)) {
        if (!isId(r[0]) || typeof r[1] !== 'string') {
          g.off = `${t.table.name} has a node that is not an integer from 0 to ${MAX_ID}, or a label that is not text`;
          return false;
        }
        g.labels.add(r[1], r[0]);
      }
      if (g.bytes() > this.limit) {
        g.off = `its index needs more than ${this.limit} bytes`;
        return false;
      }
    }
    for (let type = from; type < g.edges.length; type++) {
      const e = g.edges[type]!;
      for (const [lists, a, b] of [
        [out, e.start, e.end],
        [inn, e.end, e.start],
      ] as const) {
        const idx = endpointIndex(e.table, a, b);
        if (idx) {
          const c = this.host.openTree(idx.rootPage).cursor();
          try {
            for (let ok = c.first(); ok; ok = c.next()) {
              c.loadKey();
              if (!decodeSmallRun(c.keyBytes, c.keyOffset, run) || !isId(run[0]) || !isId(run[1]) || !isId(run[2])) {
                g.off = `${e.table.name} has an endpoint or a rowid that is not an integer from 0 to ${MAX_ID}`;
                return false;
              }
              lists.append(run[0], type, run[1], run[2]);
            }
          } finally {
            c.close();
          }
        } else {
          const rows = this.host.rows(e.table, a, b);
          for (const r of rows) {
            if (!isId(r[0]) || !isId(r[1]) || !isId(r[2])) {
              g.off = `${e.table.name} has an endpoint or a rowid that is not an integer from 0 to ${MAX_ID}`;
              return false;
            }
          }
          (rows as number[][]).sort((x, y) => x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!);
          for (const r of rows as number[][]) lists.append(r[0]!, type, r[1]!, r[2]!);
        }
        if (out.bytes() + inn.bytes() > this.limit) {
          g.off = `its index needs more than ${this.limit} bytes`;
          return false;
        }
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- writes

  private stop(g: GraphIndex, why: string): void {
    g.off = why;
    g.drop();
  }

  private add(role: EdgeRole, row: readonly SqlValue[], rowid: number | bigint): void {
    const g = role.graph;
    const s = row[role.start];
    const e = row[role.end];
    if (!isId(s) || !isId(e) || !isId(rowid)) return this.stop(g, `${role.table.name} has an endpoint or a rowid that is not an integer from 0 to ${MAX_ID}`);
    g.out!.add(s, role.type, e, rowid);
    g.in!.add(e, role.type, s, rowid);
    if (g.bytes() > this.limit) this.stop(g, `its index needs more than ${this.limit} bytes`);
  }

  private remove(role: EdgeRole, row: readonly SqlValue[], rowid: number | bigint): void {
    const g = role.graph;
    const s = row[role.start];
    const e = row[role.end];
    // A row the lists don't have can't have been written while they were kept: build them again.
    if (!isId(s) || !isId(e) || !isId(rowid) || !g.out!.remove(s, role.type, e, rowid) || !g.in!.remove(e, role.type, s, rowid)) g.drop();
  }

  /** A row was written to an edge table. */
  inserted(roles: readonly EdgeRole[], row: readonly SqlValue[], rowid: number | bigint): void {
    for (const role of roles) {
      const g = role.graph;
      if (g.out === null) continue;
      g.dirty = true;
      this.add(role, row, rowid);
    }
  }

  /** A row of an edge table was deleted. */
  deleted(roles: readonly EdgeRole[], row: readonly SqlValue[], rowid: number | bigint): void {
    for (const role of roles) {
      const g = role.graph;
      if (g.out === null) continue;
      g.dirty = true;
      this.remove(role, row, rowid);
    }
  }

  /** A row of an edge table was changed in place (its rowid kept). */
  updated(roles: readonly EdgeRole[], old: readonly SqlValue[], next: readonly SqlValue[], rowid: number | bigint): void {
    for (const role of roles) {
      const g = role.graph;
      if (g.out === null || (old[role.start] === next[role.start] && old[role.end] === next[role.end])) continue;
      g.dirty = true;
      this.remove(role, old, rowid);
      if (g.out !== null) this.add(role, next, rowid);
    }
  }

  /** An edge table was emptied. */
  truncated(roles: readonly EdgeRole[]): void {
    for (const role of roles) role.graph.drop();
  }

  // ---------------------------------------------------------------- the label index's writes

  private label(role: LabelRole, row: readonly SqlValue[], add: boolean): void {
    const g = role.graph;
    const node = row[role.node];
    const label = row[role.label];
    if (!isId(node) || typeof label !== 'string') {
      if (add) this.stop(g, `${role.table.name} has a node that is not an integer from 0 to ${MAX_ID}, or a label that is not text`);
      else g.drop();
      return;
    }
    if (add) {
      g.labels!.add(label, node);
      if (g.bytes() > this.limit) this.stop(g, `its index needs more than ${this.limit} bytes`);
    } else if (!g.labels!.remove(label, node)) g.drop(); // an entry the sets don't have: build them again
  }

  /** A row was written to a label index table. */
  labelInserted(roles: readonly LabelRole[], row: readonly SqlValue[]): void {
    for (const role of roles) {
      const g = role.graph;
      if (g.labels === null) continue;
      g.dirty = true;
      this.label(role, row, true);
    }
  }

  /** A row of a label index table was deleted. */
  labelDeleted(roles: readonly LabelRole[], row: readonly SqlValue[]): void {
    for (const role of roles) {
      const g = role.graph;
      if (g.labels === null) continue;
      g.dirty = true;
      this.label(role, row, false);
    }
  }

  /** A row of a label index table was changed in place. */
  labelUpdated(roles: readonly LabelRole[], old: readonly SqlValue[], next: readonly SqlValue[]): void {
    for (const role of roles) {
      const g = role.graph;
      if (g.labels === null || (old[role.node] === next[role.node] && old[role.label] === next[role.label])) continue;
      g.dirty = true;
      this.label(role, old, false);
      if (g.labels !== null) this.label(role, next, true);
    }
  }

  /** A label index table was emptied. */
  labelTruncated(roles: readonly LabelRole[]): void {
    for (const role of roles) role.graph.drop();
  }

  // ---------------------------------------------------------------- transactions

  /**
   * This connection committed: what the indexes hold is now the committed state, at the pager's new counter. A commit
   * moves the counter by one, or not at all when it wrote nothing; an index the counter left further behind missed
   * another connection's commit, and is dropped.
   */
  committed(): void {
    if (this.graphs.size === 0) return;
    const counter = this.host.changeCounter();
    for (const g of this.graphs.values()) {
      if (g.out === null) continue;
      if (counter !== g.counter && counter !== (g.counter + 1) >>> 0) {
        g.drop();
        continue;
      }
      g.dirty = false;
      g.counter = counter;
    }
  }

  /** A statement, a savepoint or the transaction was rolled back: an index that may hold what it undid is dropped. */
  rolledBack(): void {
    if (this.graphs.size === 0) return;
    for (const g of this.graphs.values()) if (g.dirty) g.drop();
  }

  // ---------------------------------------------------------------- tests

  /** Each graph's index as it stands (after a refresh). */
  state(): { graph: string; built: boolean; off: string | null; entries: number; labels: number; bytes: number; builds: number }[] {
    this.refresh();
    return [...this.graphs.values()].map((g) => ({ graph: g.name, built: g.out !== null, off: g.off, entries: g.out?.entries ?? 0, labels: g.labels?.entries ?? 0, bytes: g.bytes(), builds: g.builds }));
  }

  /** Compares every built index with its tables; throws when they differ (a test setting, ADR 0040 section 3). */
  check(): void {
    this.refresh();
    for (const g of this.graphs.values()) {
      if (g.out === null || g.counter !== this.host.changeCounter()) continue;
      if (g.labels !== null && g.labelTable !== null) {
        const have: string[] = [];
        g.labels.forEach((label, node) => void have.push(`${node}/${label}`));
        const want = this.host.rows(g.labelTable.table, g.labelTable.node, g.labelTable.label).map((r) => `${String(r[0])}/${String(r[1])}`);
        have.sort();
        want.sort();
        if (have.length !== want.length || have.some((x, i) => x !== want[i])) {
          const at = have.findIndex((x, i) => x !== want[i]);
          throw new SmaltError('SMALT_CORRUPT', `graph index of ${g.name} (labels) differs from ${g.labelTable.table.name}: ${have.length} entries against ${want.length} rows; first difference at ${at} (${have[at]} against ${want[at]})`);
        }
      }
      for (const [lists, from] of [
        [g.out, true],
        [g.in!, false],
      ] as const) {
        const have: string[] = [];
        lists.forEach((node, type, other, rowid) => void have.push(`${node}/${type}/${other}/${rowid}`));
        const want: [number, number, number, number][] = [];
        g.edges.forEach((e, type) => {
          for (const r of this.host.rows(e.table, from ? e.start : e.end, from ? e.end : e.start)) want.push([Number(r[0]), type, Number(r[1]), Number(r[2])]);
        });
        want.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || x[3] - y[3]);
        const wanted = want.map((x) => x.join('/'));
        if (have.length !== wanted.length || have.some((x, i) => x !== wanted[i])) {
          const at = have.findIndex((x, i) => x !== wanted[i]);
          throw new SmaltError(
            'SMALT_CORRUPT',
            `graph index of ${g.name} (${from ? 'out' : 'in'}) differs from its tables: ${have.length} entries against ${wanted.length} rows; first difference at ${at} (${have[at]} against ${wanted[at]})`,
          );
        }
      }
    }
  }
}
