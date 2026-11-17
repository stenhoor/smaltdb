/**
 * ADR 0033 G2: `iterate` with `key` (deduplicate on columns: the first row wins, or with `order` the lowest) and
 * `maxDepth`. Shortest paths by hops and by weight, checked against a breadth-first search and Dijkstra in plain JS.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';

const NODES = 300;
const EDGES = 2400;
let db: Database;
const edges: [number, number, number][] = [];

beforeAll(() => {
  let seed = 11;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x1_0000_0000;
  for (let i = 0; i < EDGES; i++) edges.push([1 + Math.floor(rnd() * NODES), 1 + Math.floor(rnd() * NODES), 1 + Math.floor(rnd() * 9)]);
  db = Database.openMemory();
  db.exec(`CREATE TABLE edge(src INTEGER, dst INTEGER, w INTEGER); CREATE INDEX edge_src ON edge(src);
    INSERT INTO edge VALUES ${edges.map((e) => `(${e.join(', ')})`).join(', ')}`);
});

const int = (v: number) => p.lit(v);
const col = (i: number) => p.col(0, i, 'int');
const add = (a: ReturnType<typeof col>, b: ReturnType<typeof col>) => p.call('add', [a, b], 'int');

/** (node, cost) rows from node 1: each step follows an edge, adding 1 (hops) or its weight to the cost. */
function paths(id: number, weighted: boolean, options: Parameters<typeof p.iterate>[4]): PlanOp {
  // working (node, cost) joined to edge (src, dst, w): columns 0 node, 1 cost, 2 src, 3 dst, 4 w.
  const step = p.project(p.join('inner', p.working(id, ['int', 'int']), p.scan('edge', [0, 1, 2]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.col(1, 0, 'int')], 'int')), [
    col(3),
    add(col(1), weighted ? col(4) : int(1)),
  ]);
  return p.iterate(id, 'paths', p.values([[int(1), int(0)]], ['int', 'int']), [step], options);
}

function bfs(): Map<number, number> {
  const dist = new Map([[1, 0]]);
  let frontier = [1];
  while (frontier.length) {
    const next: number[] = [];
    for (const n of frontier) for (const [s, d] of edges) if (s === n && !dist.has(d)) (dist.set(d, dist.get(n)! + 1), next.push(d));
    frontier = next;
  }
  return dist;
}

function dijkstra(): Map<number, number> {
  const dist = new Map([[1, 0]]);
  const done = new Set<number>();
  for (;;) {
    let u = -1;
    for (const [n, d] of dist) if (!done.has(n) && (u === -1 || d < dist.get(u)!)) u = n;
    if (u === -1) return dist;
    done.add(u);
    for (const [s, d, w] of edges) if (s === u && (!dist.has(d) || dist.get(u)! + w < dist.get(d)!)) dist.set(d, dist.get(u)! + w);
  }
}

const asMap = (rows: unknown[][]) => new Map(rows.map((r) => [r[0] as number, r[1] as number]));

describe('iterate with key (ADR 0033 G2)', () => {
  it('without order, the first row per key wins: shortest paths by hops', () => {
    const rows = db.queryPlan(paths(1, false, { distinct: true, key: [0] })).rows;
    expect(rows.length).toBe(new Set(rows.map((r) => r[0])).size);
    expect(asMap(rows)).toEqual(bfs());
  });

  it('with order, the lowest row per key wins: shortest paths by weight (Dijkstra)', () => {
    const rows = db.queryPlan(paths(2, true, { distinct: true, key: [0], order: [p.asc(col(1))] })).rows;
    expect(rows.length).toBe(new Set(rows.map((r) => r[0])).size);
    expect(asMap(rows)).toEqual(dijkstra());
    // Rows come out in cost order, as a priority queue gives them.
    const costs = rows.map((r) => r[1] as number);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
  });

  it('a limit takes the nearest nodes first', () => {
    const all = db.queryPlan(paths(3, true, { distinct: true, key: [0], order: [p.asc(col(1))] })).rows;
    expect(db.queryPlan(paths(4, true, { distinct: true, key: [0], order: [p.asc(col(1))], limit: 10 })).rows).toEqual(all.slice(0, 10));
  });
});

describe('iterate with maxDepth (ADR 0033 G2)', () => {
  it('stops the steps that many steps from the initial rows, as a depth counter does in SQL', () => {
    for (const depth of [0, 1, 2]) {
      const rows = db.queryPlan(paths(5, false, { maxDepth: depth })).rows;
      const sql = db.query(`WITH RECURSIVE r(n, c) AS (SELECT 1, 0 UNION ALL SELECT e.dst, r.c + 1 FROM r JOIN edge e ON e.src = r.n WHERE r.c < ${depth}) SELECT n, c FROM r`).rows;
      const sorted = (x: unknown[][]) => x.map((r) => JSON.stringify(r)).sort();
      expect(sorted(rows)).toEqual(sorted(sql));
    }
  });

  it('bounds a recursion that would not end on its own (cycles, UNION ALL)', () => {
    const rows = db.queryPlan(paths(6, false, { maxDepth: 3 })).rows;
    expect(Math.max(...rows.map((r) => r[1] as number))).toBe(3);
  });

  it('combines with a key', () => {
    const rows = db.queryPlan(paths(7, false, { distinct: true, key: [0], maxDepth: 2 })).rows;
    const want = [...bfs()].filter(([, d]) => d <= 2);
    expect(asMap(rows)).toEqual(new Map(want));
  });
});

describe('the validator', () => {
  const bad = (options: Parameters<typeof p.iterate>[4], message: RegExp) => expect(() => db.queryPlan(paths(9, false, options))).toThrow(message);
  it('refuses a key without distinct, out of range or repeated, and a negative or fractional maxDepth', () => {
    bad({ key: [0] }, /a key needs distinct/);
    bad({ distinct: true, key: [2] }, /expected a column index below 2/);
    bad({ distinct: true, key: [0, 0] }, /listed twice/);
    bad({ distinct: true, key: [] }, /at least one key column/);
    bad({ maxDepth: -1 }, /non-negative integer/);
    bad({ maxDepth: 1.5 }, /non-negative integer/);
  });
});
