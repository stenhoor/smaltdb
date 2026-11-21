/**
 * Property graphs' rules (ADR 0033, G4 part 2; the owner's decisions 12 and of 2026-11-17), kept by the engine on
 * every write to a graph's tables, whichever language makes it:
 *
 * - **Node ids are unique across the graph.** A node table's id column is its INTEGER PRIMARY KEY (the rowid), so a
 *   table can't repeat one; a new or changed id that another node table of the graph has fails
 *   (SMALT_CONSTRAINT_PRIMARYKEY). A row written without an id gets the next one: one more than the largest id in any
 *   of the graph's node tables.
 * - **A relationship's endpoints are nodes of the graph.** An edge's start and end must be ids found in one of its node
 *   tables (SMALT_CONSTRAINT_FOREIGNKEY, as a foreign key's parent).
 * - **A node with relationships can't be deleted** or have its id changed (SMALT_CONSTRAINT_FOREIGNKEY): Cypher's
 *   DELETE refuses it too, and DETACH DELETE deletes the relationships first.
 * - **The label index** (part 4, decision 5) holds the labels a node has besides its table's. An entry names a node of
 *   the graph and one of the graph's labels, spelled as the graph spells it, other than the label of the node's own
 *   table (SMALT_CONSTRAINT_FOREIGNKEY). Entries are the node's: deleting the node deletes them, and changing its id
 *   changes theirs.
 * - **Per-label copies** (part 5, decision 18): a label marked `copy` keeps its own row for each node that has it
 *   through the label index, in its table, with the node's id and the columns its table shares with the node's, by
 *   name. The engine writes the copy when the entry is added, updates it with the node, and deletes it with the entry
 *   or the node. A copy is written only by the engine: writing or deleting one directly is refused.
 *
 * The errors carry their code, table, columns and the graph's name, but no `constraint` kind: a language words those
 * kinds as its own constraints (SQL: SQLite's messages), and these are the graph's, so the engine's wording stands.
 *
 * Checks run when each row is written, so a statement that deletes a node and its relationships deletes the
 * relationships first. Tables outside graphs pay one map lookup per write (`involved`).
 */
import { ConstraintError, type TableSchema, findColumn } from '../catalog/schema.js';
import type { PropertyGraphDef } from '../plan/schema.js';
import { and, append, filter, limit, lit, project, remove, scan, update, values } from '../plan/build.js';
import { call, col, param } from '../plan/expr.js';
import type { PlanOp } from '../plan/ops.js';
import type { SqlValue } from '../values.js';

export interface GraphHost {
  graphs(): readonly PropertyGraphDef[];
  getTable(name: string): TableSchema | undefined;
  schemaVersion(): number;
  /** Whether table `t` has a row with this rowid. */
  rowExists(t: TableSchema, rowid: number | bigint): boolean;
  /** One more than the largest rowid in `t` (1 when empty). */
  nextRowid(t: TableSchema): number | bigint;
  /** Run an internal query plan with positional parameters, inside the current statement. */
  run(plan: PlanOp, params: SqlValue[]): SqlValue[][];
  /**
   * Whether node `id` has a relationship in edge table `t`, as its start (or as its end), where that is known
   * without a plan (a graph's index in memory holds the table's relationships); undefined where it isn't.
   */
  connected(t: TableSchema, byStart: boolean, id: number | bigint): boolean | undefined;
}

interface Edge {
  table: TableSchema;
  start: number;
  end: number;
  /** SELECT 1 FROM edge WHERE start = ? LIMIT 1, and the same for end. */
  byStart: PlanOp;
  byEnd: PlanOp;
}

interface Labels {
  table: TableSchema;
  node: number;
  label: number;
  /** DELETE FROM labels WHERE node = ? */
  forget: PlanOp;
  /** UPDATE labels SET node = ?2 WHERE node = ?1 */
  rekey: PlanOp;
  /** SELECT label FROM labels WHERE node = ? */
  labelsOf: PlanOp;
  /** SELECT 1 FROM labels WHERE node = ?1 AND label = ?2 LIMIT 1 */
  has: PlanOp;
}

/** The plans that keep a copy of a node of `home` in a copy label's table. */
interface CopyPlans {
  /** The shared columns of the node's row: SELECT c… FROM home WHERE id = ? */
  read: PlanOp;
  homeCols: number[];
  /** INSERT INTO copy(id, c…) VALUES (?, ?…) */
  insert: PlanOp;
  /** UPDATE copy SET c… = ?2… WHERE id = ?1, or null when no column is shared. */
  update: PlanOp | null;
}

interface Graph {
  name: string;
  nodes: TableSchema[];
  /** Each node table's label, as the graph spells it. */
  labelOf: Map<TableSchema, string>;
  labelNames: Set<string>;
  /** In a graph whose labels ignore case (`caseSensitive: false`): each label's spelling, by its lower case. */
  spelling?: Map<string, string>;
  tableOf: Map<string, TableSchema>;
  /** The labels that keep copies. */
  copies: Set<string>;
  edges: Edge[];
  labels?: Labels;
}

type Role = { kind: 'node'; graph: Graph } | { kind: 'edge'; graph: Graph; edge: Edge } | { kind: 'labels'; graph: Graph; labels: Labels };

const eqParam = (at: number, index: number, type: 'int' | 'text') => call('cmp_eq', [col(0, at, type), param(index, type)], 'bool');
const asId = (v: SqlValue): number | bigint | null => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'bigint' ? v : null);

export class GraphRules {
  private roles = new Map<TableSchema, Role>();
  private version = -1;
  private copyPlans = new Map<string, CopyPlans>();
  /** DELETE FROM copy WHERE id = ?, by copy label table. */
  private dropPlans = new Map<TableSchema, PlanOp>();
  /** Above zero while the engine writes copies: those writes skip the node rules. */
  private copying = 0;

  constructor(private readonly host: GraphHost) {}

  private refresh(): void {
    const v = this.host.schemaVersion();
    if (v === this.version) return;
    this.version = v;
    this.roles = new Map();
    this.copyPlans = new Map();
    this.dropPlans = new Map();
    for (const def of this.host.graphs()) {
      const graph: Graph = { name: def.name, nodes: [], labelOf: new Map(), labelNames: new Set(def.nodes.map((n) => n.label)), tableOf: new Map(), copies: new Set(), edges: [] };
      if (def.caseSensitive === false) graph.spelling = new Map(def.nodes.map((n) => [n.label.toLowerCase(), n.label]));
      for (const n of def.nodes) {
        const t = this.host.getTable(n.table);
        if (!t) continue;
        graph.nodes.push(t);
        graph.labelOf.set(t, n.label);
        graph.tableOf.set(n.label, t);
        if (n.copy) graph.copies.add(n.label);
        this.roles.set(t, { kind: 'node', graph });
      }
      for (const e of def.edges) {
        const t = this.host.getTable(e.table);
        if (!t) continue;
        const start = findColumn(t, e.start);
        const end = findColumn(t, e.end);
        const lookup = (c: number): PlanOp => limit(project(filter(scan(t.name, [c]), call('cmp_eq', [col(0, 0, 'int'), param(0, 'int')], 'bool')), [lit(1)]), 1);
        const edge: Edge = { table: t, start, end, byStart: lookup(start), byEnd: lookup(end) };
        graph.edges.push(edge);
        this.roles.set(t, { kind: 'edge', graph, edge });
      }
      const l = def.labels && this.host.getTable(def.labels.table);
      if (def.labels && l) {
        const node = findColumn(l, def.labels.node);
        const all = [...l.columns.keys(), -1];
        const label = findColumn(l, def.labels.label);
        const byNode = filter(scan(l.name, all), eqParam(node, 0, 'int'));
        const labels: Labels = {
          table: l,
          node,
          label,
          forget: remove(l.name, byNode, l.columns.length),
          rekey: update(l.name, byNode, l.columns.length, [{ column: node, value: param(1, 'int') }]),
          labelsOf: project(byNode, [col(0, label, 'text')]),
          has: limit(project(filter(scan(l.name, all), and(eqParam(node, 0, 'int'), eqParam(label, 1, 'text'))), [lit(1)]), 1),
        };
        graph.labels = labels;
        this.roles.set(l, { kind: 'labels', graph, labels });
      }
    }
  }

  /** Whether `table` is a node or edge table of a graph. */
  involved(table: TableSchema): boolean {
    this.refresh();
    return this.roles.size !== 0 && this.roles.has(table);
  }

  /** A node table's next id when a row gives none: one more than the largest id among the graph's node tables. */
  nextNodeId(table: TableSchema): number | bigint | null {
    this.refresh();
    const role = this.roles.get(table);
    if (role?.kind !== 'node') return null;
    let next: number | bigint = 1;
    for (const t of role.graph.nodes) {
      const n = this.host.nextRowid(t);
      if (n > next) next = n;
    }
    return next;
  }

  /**
   * Before a row is written to `table`: in a graph whose labels ignore case, a label index entry takes the graph's
   * spelling of its label, so `person` is stored as `Person`.
   */
  prepare(table: TableSchema, row: SqlValue[]): void {
    this.refresh();
    const role = this.roles.get(table);
    if (role?.kind !== 'labels' || !role.graph.spelling) return;
    const at = role.labels.label;
    const v = row[at];
    if (typeof v === 'string') row[at] = role.graph.spelling.get(v.toLowerCase()) ?? v;
  }

  /** After a row is written to `table` (a new row, or a changed one: `old` is the row before). */
  afterWrite(table: TableSchema, row: readonly SqlValue[], old?: readonly SqlValue[]): void {
    this.refresh();
    const role = this.roles.get(table);
    if (!role) return;
    if (role.kind === 'node') {
      if (this.copying > 0) return;
      const { graph } = role;
      const id = asId(row[table.rowidAlias]!);
      const oldId = old ? asId(old[table.rowidAlias]!) : null;
      if (old && oldId !== null && this.isCopy(graph, table, oldId)) this.refuseCopy(graph, table, oldId, 'changed');
      if (id !== null && (!old || oldId !== id)) {
        for (const t of graph.nodes) {
          if (t !== table && this.host.rowExists(t, id)) {
            throw new ConstraintError('SMALT_CONSTRAINT_PRIMARYKEY', `property graph ${graph.name}: node id ${id} is already a node of ${t.name}`, {
              table: table.name,
              columns: [table.columns[table.rowidAlias]!.name],
            });
          }
        }
      }
      if (old && oldId !== null && oldId !== id) {
        this.refuseIfConnected(graph, table, oldId, 'change the id of');
        // Its other labels go with it (checked as new entries: the node now has the new id), and so do their copies.
        if (graph.labels) this.host.run(graph.labels.rekey, [oldId, id]);
      } else if (old && id !== null && graph.copies.size > 0 && graph.labels) {
        // Its copies follow its columns.
        for (const [label] of this.host.run(graph.labels.labelsOf, [id])) {
          if (typeof label !== 'string' || !graph.copies.has(label)) continue;
          const p = this.copyPlansFor(table, graph.tableOf.get(label)!);
          if (p.update) this.asCopying(() => this.host.run(p.update!, [id, ...p.homeCols.map((c) => row[c]!)]));
        }
      }
      return;
    }
    if (role.kind === 'labels') {
      const l = role.labels;
      if (old && old[l.node] === row[l.node] && old[l.label] === row[l.label]) return;
      const home = this.checkLabel(role.graph, l, row);
      if (old) this.dropCopy(role.graph, old[l.label]!, old[l.node]!);
      const label = row[l.label] as string;
      if (role.graph.copies.has(label)) {
        const id = asId(row[l.node]!)!;
        const p = this.copyPlansFor(home, role.graph.tableOf.get(label)!);
        const values = this.host.run(p.read, [id])[0] ?? [];
        this.asCopying(() => this.host.run(p.insert, [id, ...values]));
      }
      return;
    }
    const { edge, graph } = role;
    for (const c of [edge.start, edge.end]) {
      if (old && old[c] === row[c]) continue;
      const id = asId(row[c]!);
      if (id === null || !graph.nodes.some((t) => this.host.rowExists(t, id))) {
        throw new ConstraintError(
          'SMALT_CONSTRAINT_FOREIGNKEY',
          `property graph ${graph.name}: ${table.name}.${table.columns[c]!.name} ${row[c] === null ? 'is NULL' : `= ${String(row[c])} is not a node of the graph`}`,
          { table: table.name, columns: [table.columns[c]!.name], name: graph.name },
        );
      }
    }
  }

  /** Before a row of `table` is deleted. */
  beforeDelete(table: TableSchema, row: readonly SqlValue[]): void {
    this.refresh();
    const role = this.roles.get(table);
    if (role?.kind === 'labels') {
      this.dropCopy(role.graph, row[role.labels.label]!, row[role.labels.node]!);
      return;
    }
    if (role?.kind !== 'node' || this.copying > 0) return;
    const id = asId(row[table.rowidAlias]!);
    if (id === null) return;
    if (this.isCopy(role.graph, table, id)) this.refuseCopy(role.graph, table, id, 'deleted');
    this.refuseIfConnected(role.graph, table, id, 'delete');
    if (role.graph.labels) this.host.run(role.graph.labels.forget, [id]);
  }

  private asCopying(f: () => unknown): void {
    this.copying++;
    try {
      f();
    } finally {
      this.copying--;
    }
  }

  /** Whether row `id` of node table `t` is a copy: its label keeps copies and the label index gives node `id` that label. */
  private isCopy(graph: Graph, t: TableSchema, id: number | bigint): boolean {
    const label = graph.labelOf.get(t)!;
    return graph.copies.has(label) && graph.labels !== undefined && this.host.run(graph.labels.has, [id, label]).length > 0;
  }

  /** The table that holds node `id` itself (not a copy of it), if any. */
  private homeOf(graph: Graph, id: number | bigint): TableSchema | undefined {
    return graph.nodes.find((t) => this.host.rowExists(t, id) && !this.isCopy(graph, t, id));
  }

  private refuseCopy(graph: Graph, t: TableSchema, id: number | bigint, what: string): never {
    const home = graph.nodes.find((x) => x !== t && this.host.rowExists(x, id));
    throw new ConstraintError(
      'SMALT_CONSTRAINT_FOREIGNKEY',
      `property graph ${graph.name}: row ${id} of ${t.name} is a copy of node ${id}${home ? ` of ${home.name}` : ''}, kept by the engine, and can't be ${what}: ${what === 'deleted' ? `delete the node, or its label ${graph.labelOf.get(t)} in ${graph.labels!.table.name}` : `change node ${id} in ${home?.name ?? 'its table'}`}`,
      { table: t.name, columns: [t.columns[t.rowidAlias]!.name], name: graph.name },
    );
  }

  /** Delete node `node`'s copy for `label`, when that label keeps copies. */
  private dropCopy(graph: Graph, label: SqlValue, node: SqlValue): void {
    const id = asId(node);
    if (typeof label !== 'string' || id === null || !graph.copies.has(label)) return;
    const t = graph.tableOf.get(label)!;
    let p = this.dropPlans.get(t);
    if (!p) this.dropPlans.set(t, (p = remove(t.name, filter(scan(t.name, [t.rowidAlias, -1]), eqParam(0, 0, 'int')), 1)));
    this.asCopying(() => this.host.run(p!, [id]));
  }

  /** The plans that copy a node of `home` into `copy`: its id, and the columns the two tables share by name. */
  private copyPlansFor(home: TableSchema, copy: TableSchema): CopyPlans {
    const key = `${home.name}|${copy.name}`;
    let p = this.copyPlans.get(key);
    if (p) return p;
    const pairs: [number, number][] = [];
    home.columns.forEach((c, i) => {
      if (i === home.rowidAlias) return;
      const j = copy.columns.findIndex((x) => x.name.toLowerCase() === c.name.toLowerCase());
      if (j >= 0 && j !== copy.rowidAlias) pairs.push([i, j]);
    });
    const homeCols = pairs.map(([i]) => i);
    const all = [...copy.columns.keys(), -1];
    p = {
      read: project(filter(scan(home.name, [...home.columns.keys()]), eqParam(home.rowidAlias, 0, 'int')), homeCols.map((c) => col(0, c, 'any'))),
      homeCols,
      insert: append(copy.name, values([[param(0, 'int'), ...pairs.map((_, k) => param(k + 1))]]), [copy.rowidAlias, ...pairs.map(([, j]) => j)]),
      update: pairs.length === 0 ? null : update(copy.name, filter(scan(copy.name, all), eqParam(copy.rowidAlias, 0, 'int')), copy.columns.length, pairs.map(([, j], k) => ({ column: j, value: param(k + 1) }))),
    };
    this.copyPlans.set(key, p);
    return p;
  }

  /** A label index entry: a node of the graph, and one of its labels other than its table's. Returns the node's table. */
  private checkLabel(graph: Graph, l: Labels, row: readonly SqlValue[]): TableSchema {
    const t = l.table;
    const fail = (c: number, message: string): never => {
      throw new ConstraintError('SMALT_CONSTRAINT_FOREIGNKEY', `property graph ${graph.name}: ${t.name}.${t.columns[c]!.name} ${message}`, { table: t.name, columns: [t.columns[c]!.name], name: graph.name });
    };
    const id = asId(row[l.node]!);
    const label = row[l.label];
    if (id === null) fail(l.node, row[l.node] === null ? 'is NULL' : `= ${String(row[l.node])} is not a node of the graph`);
    if (typeof label !== 'string' || !graph.labelNames.has(label)) {
      const near = typeof label === 'string' ? [...graph.labelNames].find((x) => x.toLowerCase() === label.toLowerCase()) : undefined;
      fail(l.label, label === null ? 'is NULL' : `= ${JSON.stringify(label)} is not a label of the graph${near ? ` (labels are case-sensitive: ${near})` : ''}`);
    }
    // A row of the label's own table with this id is the node itself: its copy isn't written yet, and an entry it had
    // before would be this one (refused by the unique index first).
    const own = graph.tableOf.get(label as string)!;
    if (this.host.rowExists(own, id!)) fail(l.label, `= ${JSON.stringify(label)}: node ${String(id)} has that label already, as a row of ${own.name}`);
    const home = this.homeOf(graph, id!);
    if (!home) fail(l.node, `= ${String(id)} is not a node of the graph`);
    return home!;
  }

  private refuseIfConnected(graph: Graph, table: TableSchema, id: number | bigint, what: string): void {
    for (const e of graph.edges) {
      for (const [plan, column] of [
        [e.byStart, e.start],
        [e.byEnd, e.end],
      ] as const) {
        if (this.host.connected(e.table, column === e.start, id) ?? this.host.run(plan, [id]).length > 0) {
          throw new ConstraintError('SMALT_CONSTRAINT_FOREIGNKEY', `property graph ${graph.name}: can't ${what} node ${id} of ${table.name}: relationships in ${e.table.name}.${e.table.columns[column]!.name} refer to it (delete them first)`, {
            table: e.table.name,
            columns: [e.table.columns[column]!.name],
            name: graph.name,
          });
        }
      }
    }
  }
}
