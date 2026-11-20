/**
 * `relationships` (ADR 0040, section 2.2): a property graph's relationships as a relation, read whole, at a node (a
 * condition on `node` or on `other`) or between two nodes (a condition on both), from the graph's index in memory or,
 * without one, from the types' tables and their endpoint indexes: the same rows in the same order either way. Every
 * database here runs with the test setting on (test/setup-sql.ts): a query that reads the index is run again without
 * it, and its rows compared in order.
 */
import { describe, expect, it } from 'vitest';
import { Database, type DatabaseOptions } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import { planFromJSON, planToJSON } from '../src/engine/plan/codec.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import { printPlan } from '../src/engine/plan/print.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

type Type = 'A' | 'B' | 'C';
type Rel = [type: Type, from: number, to: number, props?: Record<string, unknown>];
const TYPES: readonly Type[] = ['A', 'B', 'C'];
const PROPS: PlanType = 'map<text, any>';

const statement = (db: Database, s: Record<string, unknown>) => db.queryPlan(s as unknown as PlanStatementInput);
const schema = (db: Database, op: Record<string, unknown>): void => void statement(db, { kind: 'schema', op });

/** The tables of a graph with three relationship types, in a database: nodes are rows of `n`. */
function tables(db: Database, bare: boolean): void {
  const column = (name: string, type: string, declaredType = type) => ({ name, declaredType, type, notNull: false, collation: 'binary' });
  const table = (name: string, columns: unknown[]): void => schema(db, { op: 'createTable', table: { name, columns, keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false });
  db.exec('CREATE TABLE n(id INTEGER PRIMARY KEY); CREATE TABLE ec(start INTEGER, end INTEGER);');
  table('ea', [column('start', 'INTEGER'), column('end', 'INTEGER'), column('props', 'MAP', PROPS)]);
  table('eb', [column('w', 'INTEGER'), column('b', 'INTEGER'), column('a', 'INTEGER'), column('props', 'MAP', PROPS)]);
  db.exec('CREATE INDEX ea_s ON ea(start, end); CREATE INDEX ea_e ON ea(end, start); CREATE INDEX eb_s ON eb(a, b); CREATE INDEX eb_e ON eb(b, a);');
  if (!bare) db.exec('CREATE INDEX ec_s ON ec(start, end); CREATE INDEX ec_e ON ec(end, start);');
}

const GRAPH = {
  name: 'g',
  nodes: [{ label: 'N', table: 'n', id: 'id' }],
  edges: [
    { type: 'A', table: 'ea', start: 'start', end: 'end', props: 'props' },
    { type: 'B', table: 'eb', start: 'a', end: 'b', props: 'props' },
    { type: 'C', table: 'ec', start: 'start', end: 'end' },
  ],
};

/**
 * A graph `g` of nodes 0 to `nodes - 1` with three relationship types: A and B have props and both endpoint indexes
 * (B's endpoints are named `a` and `b`, in the other order in its table); C has no props and, with `bare`, no indexes.
 */
function make(nodes: number, rels: readonly Rel[], options: DatabaseOptions = {}, bare = false): Database {
  const db = Database.openMemory(options);
  tables(db, bare);
  schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: GRAPH });
  load(db, nodes, rels);
  return db;
}

function load(db: Database, nodes: number, rels: readonly Rel[]): void {
  db.exec(`WITH RECURSIVE x(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM x WHERE i < ${nodes - 1}) INSERT INTO n SELECT i FROM x`);
  for (const r of rels) add(db, r);
}

function add(db: Database, [type, from, to, props]: Rel): void {
  const append = (table: string, input: PlanOp, columns: number[]): void => void statement(db, { kind: 'write', plan: { op: 'append', table, db: 'main', input, columns, upserts: [] } });
  if (type === 'C') return append('ec', p.fromColumns([[from], [to]], ['int', 'int']), [0, 1]);
  const row = p.fromColumns([[from], [to], [props ?? null]], ['int', 'int', PROPS]);
  if (type === 'A') append('ea', row, [0, 1, 2]);
  else append('eb', row, [2, 1, 3]);
}

type Direction = 'out' | 'in' | 'both';
const rel = (direction: Direction, types?: readonly string[], graph = 'g'): PlanOp => p.relationships(graph, direction, types ? { types } : {});
const at = (input: number, index: number, type: PlanType = 'int'): PlanExpr => p.col(input, index, type);
const eq = (a: PlanExpr, b: PlanExpr): PlanExpr => p.call('cmp_eq', [a, b], 'bool');
type Where = { node?: number | null; other?: number | null };
/** The relationships whose `node` and `other` are as `where` says, by conditions on the relation's own columns. */
const reading = (direction: Direction, types: readonly string[] | undefined, where: Where): PlanOp => {
  const conds = [...('node' in where ? [eq(at(0, 0), p.lit(where.node!, 'int'))] : []), ...('other' in where ? [eq(at(0, 1), p.lit(where.other!, 'int'))] : [])];
  return conds.length === 0 ? rel(direction, types) : p.filter(rel(direction, types), conds.length === 1 ? conds[0]! : p.and(...conds));
};
/** The relationships at each of `nodes` (and with each of `others` at the other end), by a join: in no promised order. */
const joined = (nodes: (number | null)[], direction: Direction, types?: readonly string[], others?: (number | null)[]): PlanOp => {
  const left = others ? p.fromColumns([nodes, others], ['int', 'int']) : p.fromColumns([nodes], ['int']);
  const w = others ? 2 : 1;
  const on = others ? p.and(eq(at(1, 0), at(0, 0)), eq(at(1, 1), at(0, 1))) : eq(at(1, 0), at(0, 0));
  const join: PlanOp = { op: 'join', kind: 'inner', inputs: [left, rel(direction, types)], on };
  return { op: 'project', input: join, exprs: [at(0, w), at(0, w + 1), at(0, w + 2, 'text'), at(0, w + 3), at(0, w + 4, 'bool'), at(0, w + 5, PROPS)] };
};
const sorted = (rows: unknown[][]): string[] => rows.map((r) => JSON.stringify(r)).sort();
const explain = (db: Database, plan: PlanOp): string => (statement(db, { kind: 'explain', mode: 'plan', query: { kind: 'query', plan } }).rows as unknown[][]).map((r) => String(r[3])).join('\n');
const rows = (db: Database, plan: PlanOp): unknown[][] => db.queryPlan(plan).rows as unknown[][];
const state = (db: Database) => db.graphIndexState.state()[0]!;
const error = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return '';
};

/**
 * What `relationships` gives, worked out from the list of relationships, in its order: by reading (outgoing first), by
 * type, then by rowid when read whole, else by the node at the far end and rowid.
 */
function expected(rels: readonly Rel[], direction: Direction, types: readonly string[] | undefined, where: Where = {}): unknown[][] {
  const ids = new Map<string, number>();
  const all = rels.map(([type, from, to, props]) => {
    const id = (ids.get(type) ?? 0) + 1;
    ids.set(type, id);
    return { type, from, to, id, props: type === 'C' ? null : (props ?? null) };
  });
  const out: unknown[][] = [];
  for (const outgoing of direction === 'both' ? [true, false] : [direction === 'out']) {
    for (const type of TYPES) {
      if (types && !types.includes(type)) continue;
      const found = all
        .filter((r) => r.type === type && !(direction === 'both' && !outgoing && r.from === r.to))
        .map((r) => ({ ...r, node: outgoing ? r.from : r.to, other: outgoing ? r.to : r.from }))
        .filter((r) => (!('node' in where) || r.node === where.node) && (!('other' in where) || r.other === where.other));
      if ('node' in where) found.sort((x, y) => x.other - y.other || x.id - y.id);
      else if ('other' in where) found.sort((x, y) => x.node - y.node || x.id - y.id);
      for (const r of found) out.push([r.node, r.other, r.type, r.id, outgoing, r.props]);
    }
  }
  return out;
}

const RELS: Rel[] = [
  ['A', 0, 1, { since: 2001 }],
  ['A', 1, 2],
  ['B', 0, 2, { w: 1.5 }],
  ['A', 2, 0],
  ['C', 0, 3],
  ['A', 0, 0, { loop: true }],
  ['B', 3, 0],
  ['A', 0, 1, { since: 2002 }],
  ['C', 3, 3],
  // Relationships among other nodes, so that the tables are worth seeking into.
  ...Array.from({ length: 120 }, (_, i): Rel => [TYPES[i % 3]!, 10 + i, 11 + i]),
];
const DIRECTIONS = ['out', 'in', 'both'] as const;

describe('relationships of a property graph', () => {
  const db = make(140, RELS);

  it('gives every relationship, at its start, its end or both', () => {
    for (const direction of DIRECTIONS) {
      expect(rows(db, rel(direction)), direction).toEqual(expected(RELS, direction, undefined));
      expect(rows(db, rel(direction, ['B', 'A'])), direction).toEqual(expected(RELS, direction, ['A', 'B']));
      expect(rows(db, rel(direction, [])), direction).toEqual([]);
    }
    expect(db.queryPlan(rel('both')).columnTypes).toEqual(['int', 'int', 'text', 'int', 'bool', PROPS]);
    expect(explain(db, rel('both'))).toContain('SCAN RELATIONSHIPS OF g');
    // Read whole, the index is not asked for.
    expect(db.preparePlan(rel('both')).usesGraphIndex).toBe(false);
  });

  it('gives the relationships at a node, in order of reading, type, far node and rowid', () => {
    for (const direction of DIRECTIONS) {
      for (const types of [undefined, ['A'], ['C', 'B'], ['B']]) {
        for (const node of [0, 1, 2, 3, 4, 50]) {
          const what = `${direction} ${types} at ${node}`;
          expect(rows(db, reading(direction, types, { node })), what).toEqual(expected(RELS, direction, types, { node }));
          expect(rows(db, reading(direction, types, { other: node })), `${what} as other`).toEqual(expected(RELS, direction, types, { other: node }));
          expect(sorted(rows(db, joined([node], direction, types))), what).toEqual(sorted(expected(RELS, direction, types, { node })));
        }
      }
    }
    expect(explain(db, reading('both', undefined, { node: 0 }))).toContain('SEARCH RELATIONSHIPS OF g (node=?)');
    expect(explain(db, reading('both', undefined, { other: 0 }))).toContain('SEARCH RELATIONSHIPS OF g (other=?)');
    expect(db.preparePlan(reading('both', undefined, { node: 0 })).usesGraphIndex).toBe(true);
    // Several nodes; a node that is NULL or no node's id has none.
    expect(sorted(rows(db, joined([3, null, 0, 99999], 'both')))).toEqual(sorted([...expected(RELS, 'both', undefined, { node: 3 }), ...expected(RELS, 'both', undefined, { node: 0 })]));
    for (const node of [null, -1, 99999]) expect(rows(db, reading('both', undefined, { node }))).toEqual([]);
  });

  it('gives the relationships between two nodes', () => {
    for (const direction of DIRECTIONS) {
      for (const types of [undefined, ['A'], ['B', 'C']]) {
        for (let node = 0; node < 4; node++) {
          for (let other = 0; other < 4; other++) {
            const what = `${direction} ${types} ${node} to ${other}`;
            expect(rows(db, reading(direction, types, { node, other })), what).toEqual(expected(RELS, direction, types, { node, other }));
            expect(sorted(rows(db, joined([node], direction, types, [other]))), what).toEqual(sorted(expected(RELS, direction, types, { node, other })));
          }
        }
      }
    }
    expect(explain(db, reading('out', undefined, { node: 0, other: 1 }))).toContain('SEARCH RELATIONSHIPS OF g (node=? AND other=?)');
    expect(rows(db, reading('both', undefined, { node: 0, other: null }))).toEqual([]);
  });

  it('compares a node as its column does: a whole real matches, a fraction, text and NULL do not', () => {
    const where = (value: PlanExpr): PlanOp => p.project(p.filter(rel('out', ['A']), eq(at(0, 0), value)), [at(0, 1), at(0, 3)]);
    expect(rows(db, where(p.lit(1)))).toEqual([[2, 2]]);
    expect(rows(db, where(p.lit(1.0, 'real')))).toEqual([[2, 2]]);
    expect(rows(db, where(p.lit(1.5, 'real')))).toEqual([]);
    expect(rows(db, where(p.lit(null, 'int')))).toEqual([]);
    expect(rows(db, where(p.lit(2 ** 40)))).toEqual([]);
    // A parameter: the statement is prepared once.
    const st = db.preparePlan({ kind: 'query', plan: where(p.param(0, 'int')), paramCount: 1 } as unknown as PlanStatementInput);
    expect(st.result([1]).rows).toEqual([[2, 2]]);
    expect(st.result([2]).rows).toEqual([[0, 3]]);
    expect(st.result([null]).rows).toEqual([]);
  });

  it('reads a relationship\'s props from its row, and only when asked', () => {
    const props = (node: number): unknown[][] => rows(db, p.project(reading('out', undefined, { node }), [at(0, 2, 'text'), at(0, 5, PROPS)]));
    expect(props(0)).toEqual([['A', { loop: true }], ['A', { since: 2001 }], ['A', { since: 2002 }], ['B', { w: 1.5 }], ['C', null]]);
    // A condition on a property, and a count that reads none.
    const since = p.call('map_get', [at(0, 5, PROPS), p.lit('since')], 'any');
    expect(rows(db, p.project(p.filter(reading('out', ['A'], { node: 0 }), p.call('cmp_gt', [since, p.lit(2001)], 'bool')), [at(0, 3)]))).toEqual([[5]]);
    expect(rows(db, p.aggregate(reading('both', undefined, { node: 0 }), [], [p.agg('count', [], 'int', { star: true })]))).toEqual([[expected(RELS, 'both', undefined, { node: 0 }).length]]);
  });

  it('is a source of a join like a table: hops are joins, and a node without relationships joins nothing', () => {
    // Two hops out of node 1, over A: 1 -> 2 -> 0.
    const hop1 = reading('out', ['A'], { node: 1 });
    const two: PlanOp = { op: 'join', kind: 'inner', inputs: [hop1, rel('out', ['A'])], on: eq(at(1, 0), at(0, 1)) };
    expect(rows(db, p.project(two, [at(0, 0), at(0, 1), at(0, 7)]))).toEqual([[1, 2, 0]]);
    expect(explain(db, two).match(/SEARCH RELATIONSHIPS OF g/g)).toHaveLength(2);
    // A left join keeps the node that has none.
    const left: PlanOp = { op: 'join', kind: 'left', inputs: [p.fromColumns([[4, 1]], ['int']), rel('out', ['A'])], on: eq(at(1, 0), at(0, 0)) };
    expect(sorted(rows(db, p.project(left, [at(0, 0), at(0, 2), at(0, 3, 'text')])))).toEqual(sorted([[4, null, null], [1, 2, 'A']]));
    // Joined on nothing the index can use, it is read whole.
    const count = (plan: PlanOp): unknown => rows(db, p.aggregate(plan, [], [p.agg('count', [], 'int', { star: true })]))[0]![0];
    const anyNode: PlanOp = { op: 'join', kind: 'inner', inputs: [p.scan('n', [0]), rel('out')], on: eq(at(1, 0), at(0, 0)) };
    expect(count(anyNode)).toBe(RELS.length);
  });

  it('survives the plan round trip, and prints', () => {
    const plan = reading('both', ['A', 'C'], { node: 0 });
    expect(planFromJSON(planToJSON(plan))).toEqual(plan);
    expect(printPlan(rel('in', ['B']))).toBe('relationships g in [B]');
    expect(printPlan(rel('both'))).toBe('relationships g both');
  });
});

describe('without the graph index', () => {
  it('gives the same rows with the index off', () => {
    const db = make(140, RELS, { graphIndexMem: 0 });
    for (const direction of DIRECTIONS) {
      expect(rows(db, rel(direction))).toEqual(expected(RELS, direction, undefined));
      for (const types of [undefined, ['A'], ['C', 'B']]) {
        for (const node of [0, 1, 3, 50]) {
          expect(sorted(rows(db, reading(direction, types, { node })))).toEqual(sorted(expected(RELS, direction, types, { node })));
          expect(sorted(rows(db, reading(direction, types, { other: node })))).toEqual(sorted(expected(RELS, direction, types, { other: node })));
          expect(sorted(rows(db, reading(direction, types, { node, other: 0 })))).toEqual(sorted(expected(RELS, direction, types, { node, other: 0 })));
        }
      }
    }
    expect(state(db).built).toBe(false);
  });

  it('seeks into the endpoint indexes when the tables are worth it, and gives the index\'s order', () => {
    // More relationships among the other nodes: a seek now costs less than reading a type's table.
    const more: Rel[] = [...RELS, ...Array.from({ length: 900 }, (_, i): Rel => [TYPES[i % 3]!, 10 + (i % 120), 11 + (i % 120)])];
    const db = make(140, more, { graphIndexMem: 0 });
    for (const direction of DIRECTIONS) {
      for (const where of [{ node: 0 }, { other: 0 }, { node: 0, other: 1 }, { node: 15 }]) {
        const plan = reading(direction, ['A'], where);
        expect(explain(db, plan), direction).toContain('SEARCH RELATIONSHIPS OF g');
        expect(rows(db, plan), direction).toEqual(expected(more, direction, ['A'], where));
      }
    }
    expect(db.preparePlan(reading('out', ['A'], { node: 0 })).usesGraphIndex).toBe(false);
    expect(state(db).built).toBe(false);
  });

  it('reads a type whose table has no endpoint indexes, in the same order', () => {
    for (const options of [{}, { graphIndexMem: 0 }]) {
      const db = make(140, RELS, options, true);
      for (const direction of DIRECTIONS) {
        for (const node of [0, 3]) {
          expect(sorted(rows(db, reading(direction, undefined, { node })))).toEqual(sorted(expected(RELS, direction, undefined, { node })));
          expect(sorted(rows(db, reading(direction, ['C'], { node, other: 3 })))).toEqual(sorted(expected(RELS, direction, ['C'], { node, other: 3 })));
          expect(sorted(rows(db, reading(direction, ['C', 'A'], { other: node })))).toEqual(sorted(expected(RELS, direction, ['A', 'C'], { other: node })));
        }
      }
    }
    // With the index (built from the table's rows), and suspended by the test setting: the same order.
    const db = make(140, RELS, {}, true);
    expect(rows(db, reading('both', ['C'], { node: 3 }))).toEqual(expected(RELS, 'both', ['C'], { node: 3 }));
  });

  it('ids past 2^31 - 1: the graph is read from the B+trees', () => {
    const db = make(140, RELS);
    rows(db, reading('both', undefined, { node: 0 }));
    expect(state(db).built).toBe(true);
    db.exec('INSERT INTO n VALUES (3000000000); INSERT INTO ec VALUES (0, 3000000000)');
    expect(state(db).built).toBe(false);
    const big: Rel[] = [...RELS, ['C', 0, 3000000000]];
    expect(rows(db, reading('both', undefined, { node: 0 }))).toEqual(expected(big, 'both', undefined, { node: 0 }));
    expect(rows(db, reading('in', ['C'], { node: 3000000000 }))).toEqual([[3000000000, 0, 'C', 43, false, null]]);
  });

  it('a reader reads the tables', async () => {
    const vfs = new MemoryVfs();
    const owner = await Database.open(vfs, 'db', { sharedHandles: true });
    tables(owner, false);
    schema(owner, { op: 'createPropertyGraph', ifNotExists: false, graph: GRAPH });
    load(owner, 140, RELS);
    const reader = await Database.openReader(vfs, 'db');
    const plan = reading('both', undefined, { node: 0 });
    expect(sorted(rows(reader, plan))).toEqual(sorted(expected(RELS, 'both', undefined, { node: 0 })));
    expect(reader.preparePlan(plan).usesGraphIndex).toBe(false);
    expect(owner.preparePlan(plan).usesGraphIndex).toBe(true);
  });
});

describe('writes and transactions', () => {
  it('a relationship written, changed or deleted is read at once', () => {
    const db = make(140, RELS);
    const now: Rel[] = [...RELS];
    const check = (): void => {
      for (const node of [0, 1, 5]) expect(rows(db, reading('both', undefined, { node })), `at ${node}`).toEqual(expected(now, 'both', undefined, { node }));
    };
    check();
    add(db, ['A', 5, 0, { n: 1 }]);
    now.push(['A', 5, 0, { n: 1 }]);
    add(db, ['C', 1, 5]);
    now.push(['C', 1, 5]);
    check();
    // The second A (1 -> 2) now goes 1 -> 5.
    db.exec('UPDATE ea SET end = 5 WHERE rowid = 2');
    now[1] = ['A', 1, 5];
    check();
    expect(state(db).builds).toBe(1);
  });

  it('a rollback that undid a relationship is not read', () => {
    const db = make(140, RELS);
    const plan = reading('out', ['C'], { node: 0 });
    const before = rows(db, plan);
    db.exec('BEGIN; INSERT INTO ec VALUES (0, 7)');
    expect(rows(db, plan)).toHaveLength(before.length + 1);
    db.exec('ROLLBACK');
    expect(rows(db, plan)).toEqual(before);
  });

  it('a statement that reads a node\'s relationships while it writes others at the node reads them all', () => {
    const db = make(140, RELS);
    // Node 20 gets 30 relationships of type A, to nodes 100 to 129.
    for (let i = 0; i < 30; i++) add(db, ['A', 20, 100 + i]);
    rows(db, reading('out', ['A'], { node: 20 }));
    // For each of them, one of type C beside it: the node's list changes under the scan that reads it.
    statement(db, { kind: 'write', plan: { op: 'append', table: 'ec', db: 'main', input: p.project(reading('out', ['A'], { node: 20 }), [at(0, 0), at(0, 1)]), columns: [0, 1], upserts: [] } });
    const others = (type: Type): unknown[] => rows(db, p.project(reading('out', [type], { node: 20 }), [at(0, 1)])).map((r) => r[0]);
    expect(others('A')).toEqual(Array.from({ length: 30 }, (_, i) => 100 + i));
    expect(others('C')).toEqual(others('A'));
    expect(state(db).builds).toBe(1);
  });
});

describe('the graph', () => {
  it('reads a type added later', () => {
    const db = make(140, RELS);
    rows(db, reading('both', undefined, { node: 0 }));
    schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addType', type: 'D' } });
    db.exec('INSERT INTO D(start, end) VALUES (0, 9), (9, 0)');
    expect(rows(db, p.project(reading('both', ['D'], { node: 0 }), [at(0, 1), at(0, 2, 'text'), at(0, 4, 'bool')]))).toEqual([[9, 'D', true], [9, 'D', false]]);
    expect(rows(db, reading('both', undefined, { node: 0 }))).toHaveLength(expected(RELS, 'both', undefined, { node: 0 }).length + 2);
  });

  it('takes its type names as the graph spells them, or ignoring case when the graph does', () => {
    const db = Database.openMemory();
    tables(db, false);
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { ...GRAPH, caseSensitive: false } });
    load(db, 140, RELS);
    expect(rows(db, reading('out', ['a', 'C'], { node: 0 }))).toEqual(expected(RELS, 'out', ['A', 'C'], { node: 0 }));
    const strict = make(5, []);
    expect(error(() => rows(strict, rel('out', ['a'])))).toContain('property graph g has no relationship type a');
  });

  it('refuses what it cannot read', () => {
    const db = make(5, []);
    expect(error(() => rows(db, rel('out', undefined, 'nope')))).toContain('no such property graph: nope');
    expect(error(() => rows(db, rel('out', ['A', 'Z'])))).toContain('property graph g has no relationship type Z');
    expect(error(() => rows(db, rel('out', ['A', 'A'])))).toContain('A is listed twice');
    expect(error(() => rows(db, { ...rel('out'), direction: 'up' } as unknown as PlanOp))).toContain('unknown direction "up"');
    expect(error(() => rows(db, p.relationships('g', 'out', { asOf: { commit: p.lit(1) } })))).toContain('property graph g keeps no history');
  });

  it('reads a graph that keeps history as it was', () => {
    const db = Database.openMemory();
    schema(db, { op: 'createTable', table: { name: 'n', columns: [{ name: 'id', declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' }], keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }], checks: [], foreignKeys: [], storage: 'row', history: 'versions' }, temp: false, ifNotExists: false });
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'h', nodes: [{ label: 'N', table: 'n', id: 'id' }], edges: [], history: 'versions' } });
    schema(db, { op: 'alterPropertyGraph', name: 'h', action: { kind: 'addType', type: 'E' } });
    db.exec('INSERT INTO n VALUES (0), (1), (2)');
    db.exec('INSERT INTO E(start, end) VALUES (0, 1)');
    const first = Number(db.query('SELECT max(id) FROM smalt_commits').rows[0]![0]);
    db.exec('INSERT INTO E(start, end) VALUES (0, 2), (2, 0)');
    db.exec('DELETE FROM E WHERE end = 1');
    const ends = (plan: PlanOp): unknown[][] => rows(db, p.project(plan, [at(0, 0), at(0, 1), at(0, 4, 'bool')]));
    const then = p.relationships('h', 'both', { asOf: { commit: p.lit(first) } });
    expect(sorted(ends(then))).toEqual(sorted([[0, 1, true], [1, 0, false]]));
    expect(sorted(ends(p.filter(then, eq(at(0, 0), p.lit(1)))))).toEqual(sorted([[1, 0, false]]));
    expect(sorted(ends(p.relationships('h', 'both')))).toEqual(sorted([[0, 2, true], [2, 0, true], [2, 0, false], [0, 2, false]]));
  });
});

describe('random graphs', () => {
  function random(seed: number): (n: number) => number {
    let s = seed;
    return (n) => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return s % n;
    };
  }

  it('reads the same as the list of relationships says, with and without the index', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const rnd = random(seed);
      const nodes = 40;
      // Dense enough for parallel relationships and loops; node 0 has many.
      const rels: Rel[] = Array.from({ length: 400 }, (): Rel => [TYPES[rnd(3)]!, rnd(4) === 0 ? 0 : rnd(nodes), rnd(nodes)]);
      for (const options of [{}, { graphIndexMem: 0 }]) {
        const db = make(nodes, rels, options);
        for (const direction of DIRECTIONS) {
          for (const types of [undefined, ['B'], ['A', 'C']]) {
            expect(rows(db, rel(direction, types))).toEqual(expected(rels, direction, types));
            for (let k = 0; k < 6; k++) {
              const node = k === 0 ? 0 : rnd(nodes);
              const other = rnd(nodes);
              const exact = explain(db, reading(direction, types, { node })).includes('SEARCH');
              const same = (plan: PlanOp, want: unknown[][]): void => (exact ? expect(rows(db, plan)).toEqual(want) : expect(sorted(rows(db, plan))).toEqual(sorted(want)));
              same(reading(direction, types, { node }), expected(rels, direction, types, { node }));
              same(reading(direction, types, { other: node }), expected(rels, direction, types, { other: node }));
              same(reading(direction, types, { node, other }), expected(rels, direction, types, { node, other }));
            }
          }
        }
      }
    }
  });
});
