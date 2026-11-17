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
 *
 * The errors carry their code, table, columns and the graph's name, but no `constraint` kind: a language words those
 * kinds as its own constraints (SQL: SQLite's messages), and these are the graph's, so the engine's wording stands.
 *
 * Checks run when each row is written, so a statement that deletes a node and its relationships deletes the
 * relationships first. Tables outside graphs pay one map lookup per write (`involved`).
 */
import { ConstraintError, type TableSchema, findColumn } from '../catalog/schema.js';
import type { PropertyGraphDef } from '../plan/schema.js';
import { filter, limit, lit, project, scan } from '../plan/build.js';
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
}

interface Edge {
  table: TableSchema;
  start: number;
  end: number;
  /** SELECT 1 FROM edge WHERE start = ? LIMIT 1, and the same for end. */
  byStart: PlanOp;
  byEnd: PlanOp;
}

interface Graph {
  name: string;
  nodes: TableSchema[];
  edges: Edge[];
}

type Role = { kind: 'node'; graph: Graph } | { kind: 'edge'; graph: Graph; edge: Edge };

const asId = (v: SqlValue): number | bigint | null => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'bigint' ? v : null);

export class GraphRules {
  private roles = new Map<TableSchema, Role>();
  private version = -1;

  constructor(private readonly host: GraphHost) {}

  private refresh(): void {
    const v = this.host.schemaVersion();
    if (v === this.version) return;
    this.version = v;
    this.roles = new Map();
    for (const def of this.host.graphs()) {
      const graph: Graph = { name: def.name, nodes: [], edges: [] };
      for (const n of def.nodes) {
        const t = this.host.getTable(n.table);
        if (!t) continue;
        graph.nodes.push(t);
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

  /** After a row is written to `table` (a new row, or a changed one: `old` is the row before). */
  afterWrite(table: TableSchema, row: readonly SqlValue[], old?: readonly SqlValue[]): void {
    this.refresh();
    const role = this.roles.get(table);
    if (!role) return;
    if (role.kind === 'node') {
      const id = asId(row[table.rowidAlias]!);
      const oldId = old ? asId(old[table.rowidAlias]!) : null;
      if (old && oldId !== null && oldId !== id) this.refuseIfConnected(role.graph, table, oldId, 'change the id of');
      if (id !== null && (!old || oldId !== id)) {
        for (const t of role.graph.nodes) {
          if (t !== table && this.host.rowExists(t, id)) {
            throw new ConstraintError('SMALT_CONSTRAINT_PRIMARYKEY', `property graph ${role.graph.name}: node id ${id} is already a node of ${t.name}`, {
              table: table.name,
              columns: [table.columns[table.rowidAlias]!.name],
            });
          }
        }
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
    if (role?.kind !== 'node') return;
    const id = asId(row[table.rowidAlias]!);
    if (id !== null) this.refuseIfConnected(role.graph, table, id, 'delete');
  }

  private refuseIfConnected(graph: Graph, table: TableSchema, id: number | bigint, what: string): void {
    for (const e of graph.edges) {
      for (const [plan, column] of [
        [e.byStart, e.start],
        [e.byEnd, e.end],
      ] as const) {
        if (this.host.run(plan, [id]).length > 0) {
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
