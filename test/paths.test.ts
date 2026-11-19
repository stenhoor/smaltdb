/**
 * The `paths` operation (ADR 0033, G5): paths through a graph from each input row's start node, lowered to `iterate`.
 * Checked against a brute-force enumeration in JavaScript on random small graphs, for every mode, selector and
 * direction, and on cases chosen by hand.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { printPlan } from '../src/engine/plan/print.js';

type Mode = 'walk' | 'trail' | 'acyclic' | 'simple';
type Selector = 'all' | 'any' | 'anyShortest' | 'allShortest' | { shortest: number };
type Dir = 'out' | 'in' | 'both';
interface Hop {
  edge: number;
  rowid: number;
  from: number;
  to: number;
}
interface Options {
  direction?: Dir;
  minHops?: number;
  maxHops?: number;
  mode?: Mode;
  selector?: Selector;
}

const query = (db: Database, plan: unknown) => db.queryPlan({ kind: 'query', plan } as unknown as PlanStatementInput).rows;
const pathsOf = (db: Database, starts: (number | null)[], edges: { table: string; start: number; end: number }[], o: Options) =>
  query(db, p.paths(p.values(starts.map((s) => [p.lit(s)])), 0, edges, o as never)) as [number | null, number, number, Hop[]][];

/** Every path the options allow, by depth-first search: [start, end, hops, path]. */
function reference(edges: [number, number][][], starts: (number | null)[], o: Options): [number | null, number, number, Hop[]][] {
  const { direction = 'out', minHops = 1, mode = 'walk', selector = 'all' } = o;
  const keepOne = mode === 'walk' && (selector === 'any' || selector === 'anyShortest');
  const maxHops = o.maxHops ?? Infinity;
  const out: [number | null, number, number, Hop[]][] = [];
  const steps = (at: number): number[] =>
    edges.flatMap((rows) => rows.flatMap(([a, b]) => (direction === 'out' ? (a === at ? [b] : []) : direction === 'in' ? (b === at ? [a] : []) : [...(a === at ? [b] : []), ...(b === at ? [a] : [])])));
  for (const s of starts) {
    if (s === null) continue;
    if (keepOne) {
      // The shortest walk of at least minHops to each node: breadth first over (node, min(hops, minHops)).
      const seen = new Set<string>([`${s}:0`]);
      const ended = new Set<number>();
      let level = [s];
      for (let h = 0; level.length > 0; h++) {
        if (h >= minHops) for (const n of level) if (!ended.has(n)) (ended.add(n), out.push([s, n, h, []]));
        if (h >= maxHops) break;
        const next: number[] = [];
        for (const n of level)
          for (const t of steps(n)) {
            const k = `${t}:${Math.min(h + 1, minHops)}`;
            if (!seen.has(k)) (seen.add(k), next.push(t));
          }
        level = next;
      }
      continue;
    }
    const found: Hop[][] = [];
    const go = (at: number, path: Hop[]) => {
      if (path.length >= minHops) found.push(path);
      if (path.length >= maxHops) return;
      if (mode === 'simple' && path.length > 0 && at === s) return;
      edges.forEach((rows, ti) =>
        rows.forEach(([a, b], ri) => {
          const ways: [number, number][] = direction === 'out' ? [[a, b]] : direction === 'in' ? [[b, a]] : [[a, b], [b, a]];
          for (const [f, t] of ways) {
            if (f !== at) continue;
            const hop = { edge: ti, rowid: ri + 1, from: f, to: t };
            if (mode === 'trail' && path.some((h) => h.edge === ti && h.rowid === ri + 1)) continue;
            const seen: number[] = [s, ...path.map((h) => h.to)];
            if (mode === 'acyclic' && seen.includes(t)) continue;
            if (mode === 'simple' && seen.includes(t) && t !== s) continue;
            go(t, [...path, hop]);
          }
        }),
      );
    };
    go(s, []);
    // Per last node, the selected paths.
    const byEnd = new Map<number, Hop[][]>();
    for (const f of found) {
      const end = f.length ? f.at(-1)!.to : s;
      byEnd.set(end, [...(byEnd.get(end) ?? []), f]);
    }
    for (const [end, list] of byEnd) {
      const sorted = [...list].sort((x, y) => x.length - y.length);
      const best = sorted[0]!.length;
      const kept =
        selector === 'all' ? sorted : selector === 'allShortest' ? sorted.filter((x) => x.length === best) : typeof selector === 'object' ? sorted.slice(0, selector.shortest) : sorted.slice(0, 1);
      for (const k of kept) out.push([s, end, k.length, k]);
    }
  }
  return out;
}

/**
 * A comparable summary: one line per path, sorted. `any` compares last nodes only, and `anyShortest` and `shortest k`
 * lengths only: which of equally short paths they keep is free.
 */
const summary = (rows: [number | null, number, number, Hop[]][], o: Options) =>
  rows
    .map(([s, e, h, path]) =>
      o.selector === 'any' ? `${s}->${e}` : o.selector === 'anyShortest' || typeof o.selector === 'object' ? `${s}->${e} ${h}` : `${s}->${e} ${h} ${path.map((x) => `${x.edge}.${x.rowid}`).join(',')}`,
    )
    .sort();

/** A small random graph: a deterministic generator, so a failure repeats. */
function randomGraph(seed: number, nodes: number, count: number): [number, number][] {
  let x = seed;
  const next = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) % nodes) + 1;
  return Array.from({ length: count }, () => [next(), next()] as [number, number]);
}

describe('paths, against a brute-force enumeration', () => {
  const modes: Mode[] = ['walk', 'trail', 'acyclic', 'simple'];
  const selectors: Selector[] = ['all', 'any', 'anyShortest', 'allShortest', { shortest: 2 }];
  const dirs: Dir[] = ['out', 'in', 'both'];
  for (let seed = 1; seed <= 4; seed++) {
    it(`random graph ${seed}: every mode, selector and direction`, () => {
      const db = Database.openMemory();
      const e1 = randomGraph(seed, 5, 7);
      const e2 = randomGraph(seed + 100, 5, 3);
      db.exec('CREATE TABLE r1(a INTEGER, b INTEGER); CREATE TABLE r2(x TEXT, a INTEGER, b INTEGER)');
      db.exec(`INSERT INTO r1 VALUES ${e1.map(([a, b]) => `(${a}, ${b})`).join(', ')}`);
      db.exec(`INSERT INTO r2 VALUES ${e2.map(([a, b]) => `('x', ${a}, ${b})`).join(', ')}`);
      const edges = [
        { table: 'r1', start: 0, end: 1 },
        { table: 'r2', start: 1, end: 2 },
      ];
      const starts = [1, 3, null, 1];
      for (const mode of modes)
        for (const selector of selectors)
          for (const direction of dirs)
            for (const [minHops, maxHops] of [
              [1, 3],
              [0, 2],
              [2, undefined],
            ] as const) {
              const o: Options = { mode, selector, direction, minHops, ...(maxHops !== undefined ? { maxHops } : {}) };
              // An unbounded walk that enumerates has no end: the validator refuses it (tested below).
              if (mode === 'walk' && maxHops === undefined && selector !== 'any' && selector !== 'anyShortest') continue;
              const got = pathsOf(db, starts, edges, o);
              expect(summary(got, o), JSON.stringify(o)).toEqual(summary(reference([e1, e2], starts, o), o));
            }
    });
  }
});

describe('paths', () => {
  const db = Database.openMemory();
  db.exec('CREATE TABLE e(a INTEGER, b INTEGER); INSERT INTO e VALUES (1, 2), (2, 3), (3, 1), (2, 4), (1, 4)');
  const edges = [{ table: 'e', start: 0, end: 1 }];

  it('gives the input row, the last node, the hops and the path, shortest first, in the input order', () => {
    const rows = query(db, p.paths(p.values([[p.lit(2), p.lit('b')], [p.lit(1), p.lit('a')]]), 0, edges, { mode: 'acyclic', selector: 'anyShortest' }));
    expect(rows.map((r) => [r[0], r[1], r[2], r[3]])).toEqual([
      [2, 'b', 3, 1],
      [2, 'b', 4, 1],
      [2, 'b', 1, 2],
      [1, 'a', 2, 1],
      [1, 'a', 4, 1],
      [1, 'a', 3, 2],
    ]);
    expect(rows[2]![4]).toEqual([
      { edge: 0, rowid: 2, from: 2, to: 3 },
      { edge: 0, rowid: 3, from: 3, to: 1 },
    ]);
  });

  it('minHops 0 gives each start its empty path; a NULL start gives none', () => {
    const rows = query(db, p.paths(p.values([[p.lit(4)], [p.lit(null)]]), 0, edges, { minHops: 0, maxHops: 2 }));
    expect(rows).toEqual([[4, 4, 0, []]]);
  });

  it('a shortest path across a larger graph keeps one path per node (a chain of 2000)', () => {
    const big = Database.openMemory();
    big.exec('CREATE TABLE c(a INTEGER, b INTEGER); CREATE INDEX c_a ON c(a)');
    big.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO c SELECT i, i + 1 FROM n');
    big.exec('INSERT INTO c VALUES (1, 1000), (1000, 1)');
    const rows = query(big, p.filter(p.paths(p.values([[p.lit(1)]]), 0, [{ table: 'c', start: 0, end: 1 }], { selector: 'anyShortest' }), p.call('cmp_eq', [p.col(0, 1, 'int'), p.lit(2001)], 'bool')));
    expect(rows.map((r) => r[2])).toEqual([1002]);
  });

  it('the validator refuses an unbounded enumerated walk, and malformed options', () => {
    const bad = (o: object) => () => query(db, p.paths(p.values([[p.lit(1)]]), 0, edges, o as never));
    expect(bad({})).toThrow(/a walk with no maxHops has no end/);
    expect(bad({ mode: 'trail', maxHops: 0 })).toThrow(/at least minHops/);
    expect(bad({ mode: 'trail', selector: { shortest: 0 } })).toThrow(/shortest: k/);
    expect(bad({ mode: 'ring' })).toThrow(/unknown mode/);
    expect(() => query(db, p.paths(p.values([[p.lit(1)]]), 0, [{ table: 'e', start: 0, end: 5 }], { mode: 'trail' }))).toThrow(/column/);
    expect(() => query(db, p.paths(p.values([[p.lit(1)]]), 3, edges, { mode: 'trail' }))).toThrow(/no column 3/);
  });

  it('prints in EXPLAIN-style plan text', () => {
    expect(printPlan(p.paths(p.values([[p.lit(1)]]), 0, edges, { mode: 'trail', maxHops: 3, selector: { shortest: 2 } })).split('\n')[0]).toBe('paths from 0 out over [e(0 -> 1)] hops 1..3 trail shortest 2');
  });
});

/**
 * `paths` over a property graph's edge tables runs natively (exec/paths-op.ts) on in-memory copies of their `(start,
 * end)` and `(end, start)` indexes: the same random graphs as above, checked against the enumeration and, row for row
 * and in order, against `paths` over plain tables (lowered to `iterate`).
 */
describe('paths over a graph, run natively', () => {
  const modes: Mode[] = ['walk', 'trail', 'acyclic', 'simple'];
  const selectors: Selector[] = ['all', 'any', 'anyShortest', 'allShortest', { shortest: 2 }];
  const dirs: Dir[] = ['out', 'in', 'both'];
  const schema = (o: Record<string, unknown>) => ({ kind: 'schema', op: o }) as unknown as PlanStatementInput;
  for (let seed = 1; seed <= 4; seed++) {
    it(`random graph ${seed}: every mode, selector and direction, as the plain tables give them`, () => {
      const e1 = randomGraph(seed, 5, 7);
      const e2 = randomGraph(seed + 100, 5, 3);
      const plain = Database.openMemory();
      plain.exec('CREATE TABLE r1(a INTEGER, b INTEGER); CREATE TABLE r2(a INTEGER, b INTEGER)');
      plain.exec(`INSERT INTO r1 VALUES ${e1.map(([a, b]) => `(${a}, ${b})`).join(', ')}`);
      plain.exec(`INSERT INTO r2 VALUES ${e2.map(([a, b]) => `(${a}, ${b})`).join(', ')}`);
      const graph = Database.openMemory();
      graph.exec('CREATE TABLE n(id INTEGER PRIMARY KEY); INSERT INTO n VALUES (1), (2), (3), (4), (5)');
      graph.queryPlan(schema({ op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'N', table: 'n', id: 'id' }], edges: [] } }));
      graph.queryPlan(schema({ op: 'alterPropertyGraph', name: 'g', action: { kind: 'addType', type: 'R1', table: 'g1' } }));
      graph.queryPlan(schema({ op: 'alterPropertyGraph', name: 'g', action: { kind: 'addType', type: 'R2', table: 'g2' } }));
      graph.exec(`INSERT INTO g1(start, "end") VALUES ${e1.map(([a, b]) => `(${a}, ${b})`).join(', ')}`);
      graph.exec(`INSERT INTO g2(start, "end") VALUES ${e2.map(([a, b]) => `(${a}, ${b})`).join(', ')}`);
      const plainEdges = [
        { table: 'r1', start: 0, end: 1 },
        { table: 'r2', start: 0, end: 1 },
      ];
      const graphEdges = [
        { table: 'g1', start: 0, end: 1 },
        { table: 'g2', start: 0, end: 1 },
      ];
      const starts = [1, 3, null, 1];
      const plan = (edges: typeof plainEdges, o: Options) => p.paths(p.values(starts.map((s) => [p.lit(s)])), 0, edges, o as never);
      expect(printPlan(plan(graphEdges, {}) as never)).toContain('paths');
      for (const mode of modes)
        for (const selector of selectors)
          for (const direction of dirs)
            for (const [minHops, maxHops] of [
              [1, 3],
              [0, 2],
              [2, undefined],
            ] as const) {
              const o: Options = { mode, selector, direction, minHops, ...(maxHops !== undefined ? { maxHops } : {}) };
              if (mode === 'walk' && maxHops === undefined && selector !== 'any' && selector !== 'anyShortest') continue;
              const got = pathsOf(graph, starts, graphEdges, o);
              expect(summary(got, o), JSON.stringify(o)).toEqual(summary(reference([e1, e2], starts, o), o));
              // The order `paths` promises: the input's, then shortest first; equally long paths in any order.
              const promised = (rows: typeof got) => {
                const keyed = rows.map((r, i) => ({ r, i }));
                const runs: string[] = [];
                for (const { r } of keyed) runs.push(`${r[0]}|${r[2]}`);
                const sorted = [...rows].map((r) => JSON.stringify(r));
                return { runs: runs.filter((x, i) => i === 0 || x !== runs[i - 1]), rows: sorted.sort() };
              };
              // Which of several paths `any`, `anyShortest` and `shortest k` keep is free (checked above by `summary`).
              if (selector === 'all' || selector === 'allShortest') expect(promised(got), `${JSON.stringify(o)}: as over plain tables`).toEqual(promised(pathsOf(plain, starts, plainEdges, o)));
            }
    });
  }
});
