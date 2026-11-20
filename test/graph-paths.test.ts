/**
 * `paths` over a property graph's edge tables (ADR 0040, section 2.3): one path per node is a breadth-first search the
 * engine runs itself (exec/graph-paths.ts), over the graph's index or the endpoint indexes, and an optional `target`
 * keeps only the paths that end at a node. Its rows, their order and each path are those of the rewrite to `iterate`,
 * which the same plans run here on the same tables outside a graph.
 */
import { describe, expect, it } from 'vitest';
import { Database, type DatabaseOptions } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';

type Rel = [table: 'e1' | 'e2', from: number, to: number];

/** Nodes 0 to `nodes - 1` and two edge tables with both endpoint indexes; `graph`: as a property graph. */
function make(nodes: number, rels: readonly Rel[], graph: boolean, options: DatabaseOptions = {}): Database {
  const db = Database.openMemory(options);
  db.exec(`
    CREATE TABLE n(id INTEGER PRIMARY KEY);
    CREATE TABLE e1(start INTEGER, end INTEGER); CREATE INDEX e1_s ON e1(start, end); CREATE INDEX e1_e ON e1(end, start);
    CREATE TABLE e2(a INTEGER, b INTEGER, w INTEGER); CREATE INDEX e2_a ON e2(a, b); CREATE INDEX e2_b ON e2(b, a);
  `);
  if (graph) {
    db.queryPlan({
      kind: 'schema',
      op: {
        op: 'createPropertyGraph',
        ifNotExists: false,
        graph: { name: 'g', nodes: [{ label: 'N', table: 'n', id: 'id' }], edges: [{ type: 'E1', table: 'e1', start: 'start', end: 'end' }, { type: 'E2', table: 'e2', start: 'a', end: 'b' }] },
      },
    } as unknown as PlanStatementInput);
  }
  for (let i = 0; i < nodes; i++) db.exec(`INSERT INTO n VALUES (${i})`);
  for (const [t, a, b] of rels) db.exec(t === 'e1' ? `INSERT INTO e1 VALUES (${a}, ${b})` : `INSERT INTO e2 VALUES (${a}, ${b}, 0)`);
  return db;
}

const EDGES = [
  { table: 'e1', start: 0, end: 1 },
  { table: 'e2', start: 0, end: 1 },
];
type Options = NonNullable<Parameters<typeof p.paths>[3]>;
/** The paths from each of `starts` (and to each of `targets`, when given). */
const search = (starts: (number | null)[], options: Options, targets?: (number | null)[], edges = EDGES): PlanOp =>
  p.paths(targets ? p.fromColumns([starts, targets], ['int', 'int']) : p.fromColumns([starts], ['int']), 0, edges, targets ? { ...options, target: 1 } : options);
const explain = (db: Database, plan: PlanOp): string => db.queryPlan({ kind: 'explain', mode: 'plan', query: { kind: 'query', plan } } as unknown as PlanStatementInput).rows.flat().join(' ');

function random(seed: number): (n: number) => number {
  let s = seed;
  return (n) => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s % n;
  };
}

describe('one path per node over a property graph', () => {
  const rels: Rel[] = [
    ['e1', 0, 1],
    ['e1', 1, 2],
    ['e1', 0, 2],
    ['e2', 2, 3],
    ['e1', 3, 0],
    ['e2', 4, 4],
    ['e1', 5, 4],
  ];
  const db = make(7, rels, true);

  it('is a search the engine runs itself', () => {
    expect(explain(db, search([0], { selector: 'anyShortest' }))).toContain('smalt_paths');
    expect(explain(db, search([0], { selector: 'any', minHops: 0, direction: 'both' }, [3]))).toContain('smalt_paths');
    // Every path, and paths that may not repeat, are the rewrite's.
    expect(explain(db, search([0], { selector: 'all', maxHops: 2 }))).not.toContain('smalt_paths');
    expect(explain(db, search([0], { selector: 'anyShortest', mode: 'trail' }))).not.toContain('smalt_paths');
    expect(explain(db, search([0], { selector: 'anyShortest', minHops: 2 }))).not.toContain('smalt_paths');
    expect(explain(make(3, [], false), search([0], { selector: 'anyShortest' }))).not.toContain('smalt_paths');
  });

  it('gives each node its shortest path, nearest first', () => {
    expect(db.queryPlan(search([0], { selector: 'anyShortest' })).rows).toEqual([
      [0, 1, 1, [{ edge: 0, rowid: 1, from: 0, to: 1 }]],
      [0, 2, 1, [{ edge: 0, rowid: 3, from: 0, to: 2 }]],
      [0, 3, 2, [{ edge: 0, rowid: 3, from: 0, to: 2 }, { edge: 1, rowid: 1, from: 2, to: 3 }]],
      // Back to the start: a path of at least one hop.
      [0, 0, 3, [{ edge: 0, rowid: 3, from: 0, to: 2 }, { edge: 1, rowid: 1, from: 2, to: 3 }, { edge: 0, rowid: 4, from: 3, to: 0 }]],
    ]);
  });

  it('with a target, gives the one path to it, or none', () => {
    const to = (start: number | null, target: number | null, options: Options = { selector: 'anyShortest' }) => db.queryPlan(search([start], options, [target])).rows;
    expect(to(0, 3)).toEqual([[0, 3, 3, 2, [{ edge: 0, rowid: 3, from: 0, to: 2 }, { edge: 1, rowid: 1, from: 2, to: 3 }]]]);
    expect(to(0, 5)).toEqual([]);
    expect(to(0, 99)).toEqual([]);
    expect(to(99, 0)).toEqual([]);
    expect(to(null, 0)).toEqual([]);
    expect(to(0, null)).toEqual([]);
    // To itself: no hops when none are needed, else round a cycle; a loop is a cycle of one.
    expect(to(0, 0, { selector: 'anyShortest', minHops: 0 })).toEqual([[0, 0, 0, 0, []]]);
    expect(to(0, 0).map((r) => r[3])).toEqual([3]);
    expect(to(4, 4)).toEqual([[4, 4, 4, 1, [{ edge: 1, rowid: 2, from: 4, to: 4 }]]]);
    expect(to(1, 1)).toEqual([[1, 1, 1, 4, expect.anything()]]);
    // Against the arrows, and either way.
    expect(to(4, 5)).toEqual([]);
    expect(to(4, 5, { selector: 'anyShortest', direction: 'in' })).toEqual([[4, 5, 5, 1, [{ edge: 0, rowid: 5, from: 4, to: 5 }]]]);
    expect(to(4, 5, { selector: 'anyShortest', direction: 'both' }).map((r) => r[3])).toEqual([1]);
    expect(to(3, 1, { selector: 'anyShortest', direction: 'both' }).map((r) => r[3])).toEqual([2]);
    // No further than maxHops.
    expect(to(0, 3, { selector: 'anyShortest', maxHops: 1 })).toEqual([]);
    expect(to(0, 3, { selector: 'anyShortest', maxHops: 2 }).length).toBe(1);
  });

  it('keeps the input rows in order, each with its paths', () => {
    const rows = db.queryPlan(search([3, null, 5, 0], { selector: 'anyShortest', maxHops: 1 })).rows;
    expect(rows.map((r) => [r[0], r[1], r[2]])).toEqual([
      [3, 0, 1],
      [5, 4, 1],
      [0, 1, 1],
      [0, 2, 1],
    ]);
  });
});

describe('the search and the rewrite give the same rows', () => {
  const variants: Options[] = [];
  for (const direction of ['out', 'in', 'both'] as const)
    for (const selector of ['any', 'anyShortest'] as const)
      for (const minHops of [0, 1]) for (const maxHops of [undefined, 2]) variants.push({ direction, selector, minHops, ...(maxHops !== undefined ? { maxHops } : {}) });

  type Hop = { edge: number; rowid: number; from: number; to: number };
  /**
   * What `paths` says of its rows: the input's order, then nearest first; one row for each node reached, with the
   * fewest hops there are to it; and a path that is one, of relationships the tables hold. Which of two nodes as near
   * comes first, and which of two paths as short is kept, it leaves open: the rewrite's answer depends on how its
   * planner reads the tables.
   */
  function summary(rows: unknown[][], width: number, rels: readonly Rel[], edges: typeof EDGES, direction: string): string[] {
    const tables = { e1: rels.filter((r) => r[0] === 'e1'), e2: rels.filter((r) => r[0] === 'e2') };
    let last = [-1, -1];
    return rows
      .map((r) => {
        const start = r[0] as number;
        const [end, hops, path] = r.slice(width) as unknown as [number, number, Hop[]];
        expect([start, hops] >= last || start > last[0]!, 'in the input\'s order, nearest first').toBe(true);
        last = [start, hops];
        expect(path.length).toBe(hops);
        let at = start;
        for (const h of path) {
          expect(h.from).toBe(at);
          const e = edges[h.edge]!;
          const [, a, b] = tables[e.table as 'e1' | 'e2'][h.rowid - 1]!;
          const [from, to] = e.start === 0 ? [a, b] : [b, a];
          expect((direction !== 'in' && from === h.from && to === h.to) || (direction !== 'out' && to === h.from && from === h.to), `hop ${JSON.stringify(h)}`).toBe(true);
          at = h.to;
        }
        expect(at).toBe(end);
        return `${start}>${end}:${hops}`;
      })
      .sort();
  }

  it.each([1, 2, 3, 4, 5, 6])('a random graph (%i)', (seed) => {
    const rnd = random(seed * 7919);
    const nodes = 6 + rnd(18);
    const rels: Rel[] = Array.from({ length: nodes + rnd(3 * nodes) }, () => [rnd(3) === 0 ? 'e2' : 'e1', rnd(nodes), rnd(nodes)]);
    const graph = make(nodes, rels, true);
    const plain = make(nodes, rels, false);
    const unindexed = make(nodes, rels, true, { graphIndexMem: 0 });
    const starts = Array.from({ length: nodes }, (_, i) => i);
    for (const options of variants) {
      const all = search(starts, options);
      const rows = graph.queryPlan(all).rows;
      expect(summary(rows, 1, rels, EDGES, options.direction!), JSON.stringify(options)).toEqual(summary(plain.queryPlan(all).rows, 1, rels, EDGES, options.direction!));
      // From the graph's index and from the endpoint indexes: the same rows, in order, with the same paths.
      expect(unindexed.queryPlan(all).rows, JSON.stringify(options)).toEqual(rows);
      // To a target: the row that ends there.
      const targets = starts.map(() => rnd(nodes + 1));
      const one = search(starts, options, targets);
      const found = graph.queryPlan(one).rows;
      expect(found, `to a target, ${JSON.stringify(options)}`).toEqual(rows.filter((r) => r[1] === targets[r[0] as number]).map((r) => [r[0], targets[r[0] as number], ...r.slice(1)]));
      expect(unindexed.queryPlan(one).rows, `to a target, ${JSON.stringify(options)}`).toEqual(found);
      expect(summary(found, 2, rels, EDGES, options.direction!), `to a target, ${JSON.stringify(options)}`).toEqual(summary(plain.queryPlan(one).rows, 2, rels, EDGES, options.direction!));
    }
    // One edge table of the two, read against its columns' order.
    const reversed = [{ table: 'e2', start: 1, end: 0 }];
    const back = search(starts, { direction: 'out', selector: 'anyShortest' }, undefined, reversed);
    expect(summary(graph.queryPlan(back).rows, 1, rels, reversed, 'out')).toEqual(summary(plain.queryPlan(back).rows, 1, rels, reversed, 'out'));
    expect(unindexed.queryPlan(back).rows).toEqual(graph.queryPlan(back).rows);
    expect(state(graph).built).toBe(true);
  });

  it('reads the tables when the graph is not indexed: ids past 2^31 - 1', () => {
    const rels: Rel[] = [
      ['e1', 0, 1],
      ['e1', 1, 2],
      ['e2', 2, 0],
    ];
    const graph = make(3, rels, true);
    const plain = make(3, rels, false);
    for (const db of [graph, plain]) db.exec('INSERT INTO n VALUES (5000000000); INSERT INTO e1 VALUES (2, 5000000000); INSERT INTO e1 VALUES (5000000000, 1)');
    const all = search([0, 5000000000], { selector: 'anyShortest', direction: 'both' });
    const rows = graph.queryPlan(all).rows;
    const reached = (xs: unknown[][]) => xs.map((r) => `${String(r[0])}>${String(r[1])}:${String(r[2])}`).sort();
    expect(reached(rows)).toEqual(reached(plain.queryPlan(all).rows));
    expect(rows.filter((r) => r[0] === 0 && r[1] === 5000000000).map((r) => r[2])).toEqual([2]);
    expect(rows.filter((r) => r[0] === 5000000000 && r[1] === 0).map((r) => r[2])).toEqual([2]);
    expect(state(graph).off).toContain('not an integer from 0 to 2147483647');
  });
});

const state = (db: Database) => db.graphIndexState.state()[0]!;
