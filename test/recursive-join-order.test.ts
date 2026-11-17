/**
 * ADR 0033 G1: a recursive step joins its working rows to other tables with the working rows outside. Each step reads
 * the rows of the step before, a handful at a time, so the other tables are the inner side and use their indexes. Before,
 * the working rows were costed as any nested plan (1,000 rows), so with no filter on them the step scanned the large
 * table outside and probed the working rows: unbounded reachability over 100,000 edges took 49 s against 139 ms
 * (docs/research/graph-on-plans.md, section 4).
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';

type Lite = { exec(s: string): void; selectArrays(s: string): unknown[][] };
let lite: Lite;
let db: Database;

const NODES = 400;
const EDGES = 4000;

beforeAll(async () => {
  const s3 = await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Lite } }>)({ print() {}, printErr() {} });
  lite = new s3.oo1.DB(':memory:');
  db = Database.openMemory();
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 0x1_0000_0000;
  const rows: string[] = [];
  for (let i = 0; i < EDGES; i++) rows.push(`(${1 + Math.floor(rnd() * NODES)}, ${1 + Math.floor(rnd() * NODES)}, ${i % 7})`);
  const setup = `CREATE TABLE edge(src INTEGER, dst INTEGER, w INTEGER); CREATE INDEX edge_src ON edge(src);
    INSERT INTO edge VALUES ${rows.join(', ')};`;
  lite.exec(setup);
  db.exec(setup);
});

const plan = (q: string): string => db.query('EXPLAIN QUERY PLAN ' + q).rows.map((r) => String(r[3])).join('\n');
const sorted = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

const QUERIES = [
  // Reachability: UNION, no filter on the working side (the case that scanned every edge per step).
  'WITH RECURSIVE r(n) AS (SELECT 1 UNION SELECT e.dst FROM r JOIN edge e ON e.src = r.n) SELECT n FROM r',
  // The same with the join written the other way round, and as a comma join.
  'WITH RECURSIVE r(n) AS (SELECT 1 UNION SELECT e.dst FROM edge e JOIN r ON r.n = e.src) SELECT n FROM r',
  'WITH RECURSIVE r(n) AS (SELECT 1 UNION SELECT e.dst FROM edge e, r WHERE e.src = r.n) SELECT n FROM r',
  // A depth bound and a filter on the edge (UNION ALL with a counter).
  'WITH RECURSIVE r(n, d) AS (SELECT 1, 0 UNION ALL SELECT e.dst, r.d + 1 FROM r JOIN edge e ON e.src = r.n WHERE r.d < 3 AND e.w < 3) SELECT n, d FROM r',
  // Aggregates over the result.
  'WITH RECURSIVE r(n) AS (SELECT 5 UNION SELECT e.dst FROM r JOIN edge e ON e.src = r.n) SELECT count(*), min(n), max(n) FROM r',
];

describe('recursive steps join their working rows first (ADR 0033 G1)', () => {
  it('reads the working rows outside and searches the edge index inside', () => {
    expect(plan(QUERIES[0])).toMatch(/SCAN r \(recursive step\)\nSEARCH edge USING INDEX edge_src \(=\?\)/);
    expect(plan(QUERIES[1])).toMatch(/SCAN r \(recursive step\)\nSEARCH e(dge)? USING INDEX edge_src \(=\?\)/);
  });

  it.each(QUERIES.map((q, i) => [i + 1, q]))('query %i gives the rows SQLite gives', (_i, q) => {
    expect(sorted(db.query(q).rows)).toEqual(sorted(lite.selectArrays(q)));
  });
});
