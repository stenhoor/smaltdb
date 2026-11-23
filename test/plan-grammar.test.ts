/**
 * The plan language's grammar (docs/grammar.ebnf), which the syntax diagrams on the plan language pages are drawn
 * from, against the plan format: every kind of operation and expression has its rule, the sample data's statements
 * match it, and so do the plans SQL binds to (smaltql, test/setup-sql.ts) for a corpus of statements that reach every
 * part of the format a language uses. The plans on the reference pages are checked in test/docs-examples.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { encodeDataJSON } from '../src/engine/plan/codec.js';
import { GrammarMatcher, loadGrammar, planKinds, ruleName } from './helpers/plan-grammar.js';
import type { Node } from '../docs/.vitepress/theme/railroad.js';

const grammar = loadGrammar();
const matcher = new GrammarMatcher(grammar);
const TOKENS = new Set(['string', 'integer', 'number', 'boolean', 'json', 'object', 'field-name']);
/** A statement as JSON would carry it: tagged values (bigints, blobs), no undefined fields. */
const asJSON = (x: unknown): unknown => JSON.parse(encodeDataJSON(x));

/** The sample data of the plan language pages (docs/reference/plan/sample.json). */
export const SAMPLE = 'docs/reference/plan/sample.json';

function refs(n: Node, out: Set<string>): Set<string> {
  switch (n.t) {
    case 'ref':
      out.add(n.name);
      break;
    case 'seq':
    case 'choice':
      n.items.forEach((i) => refs(i, out));
      break;
    case 'opt':
      refs(n.item, out);
      break;
    case 'rep':
      refs(n.item, out);
      if (n.sep) refs(n.sep, out);
      break;
    default:
  }
  return out;
}

const alternatives = (name: string): string[] => {
  const n = grammar.rules.get(name)!;
  return n.t === 'choice' ? n.items.map((i) => (i.t === 'ref' ? i.name : '?')) : [];
};

describe('the plan grammar', () => {
  it('defines every rule it refers to', () => {
    const missing: string[] = [];
    for (const [name, rule] of grammar.rules) for (const r of refs(rule, new Set())) if (!grammar.rules.has(r) && !TOKENS.has(r)) missing.push(`${name} → ${r}`);
    expect(missing).toEqual([]);
  });

  it('has a rule for every operation and expression kind, and lists them under plan and expr', () => {
    const { ops, exprs } = planKinds();
    expect(ops.length).toBeGreaterThan(20);
    expect(exprs.length).toBeGreaterThan(10);
    expect(new Set(alternatives('plan'))).toEqual(new Set(ops.map(ruleName)));
    expect(new Set(alternatives('expr'))).toEqual(new Set(exprs.map(ruleName)));
    // Each rule's object names its kind as the types do.
    for (const op of ops) expect(grammar.text.get(ruleName(op)), op).toContain(`'{"op": "${op}"'`);
    for (const k of exprs) expect(grammar.text.get(ruleName(k)), k).toContain(`'{"k": "${k}"'`);
  });

  it('matches the sample data, and refuses what is not a plan', () => {
    const stmts = JSON.parse(readFileSync(SAMPLE, 'utf8')) as unknown[];
    for (const s of stmts) expect(matcher.explain('statement', s), JSON.stringify(s).slice(0, 200)).toBeNull();
    expect(matcher.matches('plan', { op: 'scan', table: 'fruit' })).toBe(false); // no columns
    expect(matcher.matches('plan', { op: 'scan', table: 'fruit', columns: [0], extra: 1 })).toBe(false);
    expect(matcher.matches('expr', { k: 'lit', value: true, type: 'bool' })).toBe(false); // a literal is not a JS boolean
    expect(matcher.matches('expr', { k: 'lit', value: 1, type: 'integer' })).toBe(false); // not a plan type
    expect(matcher.matches('expr', { k: 'lit', value: { $bigint: '9007199254740993' }, type: 'int' })).toBe(true);
    expect(matcher.matches('plan', { op: 'sample', input: { op: 'values', rows: [], types: [] }, replace: false, seed: 1 })).toBe(false); // count or fraction
  });

  it('matches the plans SQL binds to', () => {
    const db = Database.openMemory();
    for (const s of JSON.parse(readFileSync(SAMPLE, 'utf8')) as unknown[]) db.queryPlan(s as never);
    db.exec(`CREATE TABLE ticks(sym TEXT, at INTEGER, price REAL); CREATE TABLE trades(sym TEXT, at INTEGER, n INTEGER);
             CREATE TABLE edges(a INTEGER, b INTEGER); CREATE INDEX edges_a ON edges(a);
             CREATE TABLE kv(k TEXT PRIMARY KEY, v INTEGER)`);
    const corpus = [
      'SELECT name, price * qty AS value FROM fruit WHERE color = ? ORDER BY value DESC NULLS LAST LIMIT 2 OFFSET 1',
      "SELECT f.name, sum(o.n), count(*), group_concat(DISTINCT o.day) FILTER (WHERE o.n > 1) FROM fruit f JOIN orders o ON o.fruit = f.id GROUP BY f.name HAVING count(*) > 1",
      'SELECT name FROM fruit f WHERE EXISTS (SELECT 1 FROM orders o WHERE o.fruit = f.id) AND id IN (SELECT fruit FROM orders) AND qty > (SELECT avg(n) FROM orders)',
      "SELECT CASE WHEN qty IS NULL THEN 'none' WHEN qty > 5 THEN 'many' ELSE 'few' END, NOT (price > 1 OR color LIKE 'r%' ESCAPE '!') FROM fruit",
      "SELECT CAST(price AS INTEGER), CAST(id AS TEXT), name COLLATE NOCASE = 'APPLE', coalesce(qty, 0), x'00ff', 9007199254740993 FROM fruit",
      'SELECT color, name, row_number() OVER w, sum(qty) OVER (PARTITION BY color ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES), lag(name, 1) OVER w FROM fruit WINDOW w AS (ORDER BY price)',
      'SELECT name FROM fruit UNION SELECT owner FROM baskets EXCEPT SELECT color FROM fruit',
      'SELECT a.name, b.name FROM fruit a LEFT JOIN fruit b ON a.color = b.color AND a.id < b.id CROSS JOIN (SELECT 1) RIGHT JOIN fruit c ON c.id = a.id FULL JOIN orders o ON o.id = c.id',
      'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5) SELECT x FROM n',
      'SELECT DISTINCT color FROM fruit',
      'SELECT value FROM range(1, 5)',
      'SELECT owner, items[1], len(counts) FROM baskets',
      'SELECT * FROM generate_series(1, 3)',
      "SELECT date('2026-11-02', '+1 day'), strftime('%Y', day), day + 1 FROM orders",
      'SELECT name FROM fruit WHERE id BETWEEN 2 AND 4 AND name GLOB \'p*\' AND qty IS NOT NULL',
      "SELECT json_extract('{\"a\":1}', '$.a')",
      'SELECT name, (SELECT count(*) FROM orders o WHERE o.fruit = f.id) FROM fruit f ORDER BY 2 DESC, name COLLATE NOCASE',
    ];
    const writes = [
      "INSERT INTO kv(k, v) VALUES ('a', 1), ('b', 2) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v WHERE excluded.v > 0 RETURNING k, v",
      'INSERT OR IGNORE INTO kv DEFAULT VALUES',
      "INSERT INTO kv SELECT name, qty FROM fruit WHERE qty IS NOT NULL ON CONFLICT DO NOTHING",
      "UPDATE OR REPLACE kv SET v = f.qty FROM fruit f WHERE f.name = kv.k RETURNING *",
      "DELETE FROM kv WHERE k IN (SELECT name FROM fruit) RETURNING k",
      'BEGIN IMMEDIATE',
      'COMMIT',
      'SAVEPOINT s1',
      'RELEASE s1',
      'PRAGMA foreign_keys = ON',
      'PRAGMA foreign_keys',
      'ANALYZE fruit',
      'VACUUM',
      'EXPLAIN QUERY PLAN SELECT * FROM fruit',
    ];
    let checked = 0;
    for (const sql of [...corpus, ...writes]) {
      let stmt: unknown;
      try {
        stmt = asJSON(db.boundPlan(sql));
      } catch (e) {
        // A statement this smaltql doesn't bind (a function it lacks) is no test of the grammar.
        if (/no such function|not supported|syntax error|no such table/i.test((e as Error).message)) continue;
        throw new Error(`${sql}: ${(e as Error).message}`);
      }
      expect(matcher.explain('statement', stmt), `${sql}\n${JSON.stringify(stmt).slice(0, 2000)}`).toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThan(25);
  });
});
