/**
 * Snapshot of generated code (ADR 0014, step 3a): the JavaScript that code generation emits for expressions, fused
 * pipelines and row loaders, over typed tables, compared with test/codegen-source/*.txt. The plan layer's steps
 * move expression compilation and code generation onto plan expressions; generated code is where the performance
 * of ADR 0003 lives, so it must not change unnoticed. An intended change updates the files with
 * `npx vitest run test/codegen-source.test.ts -u`, and the diff shows in review.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { traceGeneratedCode } from '../src/engine/exec/codegen.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

async function fixture(): Promise<Database> {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec(`
    CREATE TABLE t(id INTEGER PRIMARY KEY, i INT, r REAL, s TEXT, n NUMERIC, u, c TEXT COLLATE NOCASE, b BLOB);
    CREATE INDEX t_i ON t(i);
    CREATE TABLE k(id INTEGER PRIMARY KEY, g INT, v REAL, w INT, s TEXT) WITH (storage = 'columnar');
  `);
  db.exec('BEGIN');
  db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 500)
    INSERT INTO t SELECT x, x % 17, x / 8.0, 'v' || (x % 9), CASE WHEN x % 3 = 0 THEN '1.5' ELSE x END,
      CASE x % 4 WHEN 0 THEN 'text' WHEN 1 THEN x WHEN 2 THEN x * 0.5 ELSE NULL END, CASE WHEN x % 2 THEN 'Abc' ELSE 'abc' END, NULL FROM n`);
  db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 20000)
    INSERT INTO k SELECT x, x % 8, (x % 100) / 4.0, x % 1000, 's' || (x % 5) FROM n`);
  db.exec('COMMIT');
  return db;
}

const CORPUS: Record<string, string[]> = {
  expressions: [
    'SELECT i + 1, i - r, i * 2, i / 3, i % 5 FROM t',
    'SELECT r * 2.5 + 1, -r, -i FROM t',
    'SELECT n + 1, u * 2, s + 1 FROM t',
    'SELECT i = 3, i <> r, i < n, r >= 2.0, s = u, s < 5, c = s FROM t',
    'SELECT i IS NULL, u IS NOT NULL, i IS u FROM t',
    'SELECT (i > 3 AND r < 10) OR s = ?, NOT (i = 1) FROM t',
    'SELECT i & 3, i | 4, i << 2, ~i FROM t',
    'SELECT s || i, s LIKE ?, c GLOB ? FROM t',
    'SELECT i IN (1, 2, 3), s IN (?, ?), r BETWEEN 1 AND 2 FROM t',
    'SELECT CASE WHEN i > 5 THEN r ELSE i END, CASE i WHEN 1 THEN ? ELSE 0 END FROM t',
    'SELECT CAST(r AS INTEGER), CAST(i AS TEXT), CAST(s AS REAL) FROM t',
    'SELECT sqrt(r), pow(i, 2) + ln(r + 1), abs(i), coalesce(u, i) FROM t',
    'SELECT i + ? * 2, ? - r FROM t',
    'SELECT s NOT LIKE ?, i NOT IN (1, 2), i NOT BETWEEN 1 AND 3, NOT (s LIKE ?), NOT (i IN (1, 2)) FROM t',
    'SELECT +i + 1, (i + 1) COLLATE NOCASE, -(+r), (i COLLATE NOCASE) + 1, s COLLATE NOCASE = ? FROM t',
  ],
  'fused-row': [
    'SELECT id FROM t WHERE i = 3 AND r > 10',
    "SELECT count(*) FROM t WHERE s = 'v3'",
    'SELECT sum(i), avg(r), min(n), max(u), count(u) FROM t WHERE r * 2 > 5',
    'SELECT i, sum(r), count(*) FROM t GROUP BY i',
    'SELECT s, total(i * r) FROM t WHERE c = ? GROUP BY s',
    'SELECT sum(sqrt(r)) FROM t WHERE i BETWEEN 2 AND 9',
    'SELECT var_samp(r), covar_pop(i, r) FROM t',
    'SELECT count(*) FROM t WHERE i NOT BETWEEN 2 AND 9 AND s NOT LIKE ? AND i NOT IN (3, 4)',
    "SELECT count(*) FROM t WHERE c = 'abc' AND s COLLATE NOCASE = 'V1' AND +i > 2",
  ],
  'fused-columnar': [
    'SELECT count(*) FROM k WHERE v > 10',
    'SELECT g, sum(v), avg(w), max(w) FROM k GROUP BY g',
    'SELECT sum(v * w) FROM k WHERE g = 3 AND w < 500',
    "SELECT s, count(*) FROM k WHERE s <> 's1' GROUP BY s",
    'SELECT id, v FROM k WHERE w = 999',
    'SELECT median(v), stddev(v) FROM k WHERE g < 4',
  ],
};

// SMALT_PLAN=shadow generates code for both planners' operators; CI checks the physical planner's with SMALT_PLAN=plan.
describe.skipIf(!!env.SMALT_NO_CODEGEN || env.SMALT_PLAN === 'shadow')('generated code (snapshot)', async () => {
  const db = await fixture();
  for (const [group, queries] of Object.entries(CORPUS)) {
    it(group, async () => {
      const out: string[] = [];
      for (const q of queries) {
        const st = db.prepare(q);
        const params = Array.from({ length: (q.match(/\?/g) ?? []).length }, (_, i) => (i % 2 ? 2 : 'v1'));
        traceGeneratedCode(true);
        try {
          st.all(params);
        } finally {
          const sources = traceGeneratedCode(false);
          out.push(`> ${q}\n${sources.length ? sources.join('\n--\n') : '(no generated code)'}`);
        }
      }
      await expect(out.join('\n\n') + '\n').toMatchFileSnapshot(`codegen-source/${group}.txt`);
    });
  }
});
