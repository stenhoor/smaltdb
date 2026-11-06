/** Plans as data (ADR 0015 step 5, plan/codec.ts): JSON and structured-clone forms decode to the same plan. */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { sqlLanguage } from 'smaltql';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import { decodePlan, encodePlan, planFromJSON, planToJSON } from '../src/engine/plan/codec.js';
import { printPlan } from '../src/engine/plan/print.js';
import { getMeta, isFlattened } from '../src/engine/exec/sql-meta.js';
import type { BoundExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const QUERIES = [
  "SELECT id, s COLLATE NOCASE FROM t WHERE a BETWEEN 1 AND 9223372036854775807 AND s = 'x' ORDER BY s",
  "SELECT x'00ff10', 1e999, -1e999, 9007199254740993, a + 1.5 FROM t WHERE s NOT LIKE 'a%' AND a NOT IN (1, 2)",
  'SELECT a, count(*), avg(x) FROM t JOIN u ON u.x = t.a GROUP BY a HAVING count(*) > 1',
  'SELECT id, (SELECT max(y) FROM u WHERE u.x = t.a) FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.x = t.a)',
  'SELECT a, rank() OVER (PARTITION BY s ORDER BY id) FROM t',
  'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n',
  'SELECT va FROM v UNION SELECT x FROM u',
  'SELECT * FROM (SELECT a, s FROM t WHERE a > 1) WHERE s > ?',
];

async function setup(): Promise<{ db: Database; catalog: BindContext }> {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec(`
    CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, s TEXT COLLATE NOCASE);
    CREATE TABLE u(x INT, y REAL);
    CREATE VIEW v AS SELECT a AS va, s FROM t WHERE a > 0;
  `);
  return { db, catalog: (db as unknown as { bindContext(): BindContext }).bindContext() };
}

/** Every node's SQL metadata and flattening mark, in walk order. */
function annotations(p: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(p)) for (const x of p) annotations(x, out);
  else if (p && typeof p === 'object' && !(p instanceof Uint8Array)) {
    const o = p as Record<string, unknown>;
    if (typeof o.k === 'string' || typeof o.op === 'string') out.push([o.k ?? o.op, getMeta(o as unknown as BoundExpr) ?? null, isFlattened(o as unknown as PlanOp)]);
    for (const v of Object.values(o)) annotations(v, out);
  }
  return out;
}

describe('plan codec', () => {
  it('JSON and structured-clone forms decode to the same plan, SQL metadata included', async () => {
    const { catalog } = await setup();
    for (const q of QUERIES) {
      const plan = (sqlLanguage.parseOne!(q).bind(catalog) as { plan: PlanOp }).plan;
      const viaJson = planFromJSON(planToJSON(plan));
      const viaClone = decodePlan(structuredClone(encodePlan(plan)));
      for (const d of [viaJson, viaClone]) {
        expect(printPlan(d), q).toBe(printPlan(plan));
        expect(d, q).toEqual(plan);
        expect(annotations(d), q).toEqual(annotations(plan));
      }
      // The text form is JSON (no bigints or blobs left untagged).
      expect(() => JSON.parse(planToJSON(plan)), q).not.toThrow();
    }
  });

  it('refuse another format version', () => {
    expect(() => decodePlan({ version: 99, plan: {} })).toThrow(/format version 99/);
  });
});
