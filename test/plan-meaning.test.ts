/**
 * A plan says everything about its meaning (ADR 0016 section 2): what SQL's front end knows of an expression besides
 * its type (the collation it carries and from where, its affinity, whether code generation inlines it) and of an
 * operation (whether decorrelation applies) are plan fields, so a plan built by hand, or read back from JSON, means
 * exactly what SQL's does. Format version 1; version 0 kept them as hidden `$sql` / `$flattened` metadata.
 */
import { describe, expect, it } from 'vitest';
import { sqlLanguage } from 'smaltql';
import { Database, plan as p } from '../src/engine/index.js';
import { SmaltError } from '../src/engine/errors.js';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import { planFromJSON, planToJSON } from '../src/engine/plan/codec.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import { PLAN_FORMAT_VERSION } from '../src/engine/plan/types.js';

function setup(): { db: Database; catalog: BindContext } {
  const db = Database.openMemory();
  db.exec(`
    CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, s TEXT COLLATE NOCASE);
    CREATE TABLE u(x INT, y REAL);
    CREATE VIEW v AS SELECT a AS va, s FROM t WHERE a > 0;
    INSERT INTO t VALUES (1, 7, 'X'), (2, 8, 'y'), (3, 9, 'x');
  `);
  return { db, catalog: (db as unknown as { bindContext(): BindContext }).bindContext() };
}

const bind = (catalog: BindContext, q: string): PlanOp => (sqlLanguage.parseOne!(q).bind(catalog) as { plan: PlanOp }).plan;
const json = (plan: PlanOp): string => planToJSON(plan);

/** Every `key` field anywhere in `x`. */
function fields(x: unknown, key: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(x)) for (const v of x) fields(v, key, out);
  else if (x && typeof x === 'object' && !(x instanceof Uint8Array)) {
    for (const [k, v] of Object.entries(x)) {
      if (k === key) out.push(v);
      fields(v, key, out);
    }
  }
  return out;
}

describe('SQL plans carry their meaning as fields', () => {
  it('collation, affinity, inlining and decorrelation are plain fields, with no hidden metadata', () => {
    const { catalog } = setup();
    const explicit = bind(catalog, "SELECT id FROM t WHERE s COLLATE BINARY = 'x'");
    expect(fields(explicit, 'carries')).toContainEqual({ collation: 'binary', from: 'explicit' });
    const column = bind(catalog, "SELECT id FROM t WHERE s = 'x'");
    expect(fields(column, 'carries')).toContainEqual({ collation: 'nocase', from: 'column' });
    expect(fields(bind(catalog, "SELECT id FROM t WHERE a = '7'"), 'affinity')).toContain('INTEGER');
    expect(fields(bind(catalog, 'SELECT id FROM t WHERE a BETWEEN 1 AND 8'), 'inline')).toContain(false);
    expect(fields(bind(catalog, 'SELECT va FROM v WHERE va > 7'), 'decorrelate')).toContain(false);
    for (const q of ["SELECT id FROM t WHERE s = 'x'", 'SELECT va FROM v', 'SELECT id FROM t WHERE a BETWEEN 1 AND 8']) {
      const text = json(bind(catalog, q));
      expect(text).not.toMatch(/\$sql|\$flattened/);
      expect(JSON.parse(text).version).toBe(PLAN_FORMAT_VERSION);
    }
  });

  it('a plan read back from JSON gives the same rows as SQL', () => {
    const { db, catalog } = setup();
    for (const q of ["SELECT id FROM t WHERE s = 'x' ORDER BY id", "SELECT id FROM t WHERE a = '8'", 'SELECT va FROM v WHERE va > 7 ORDER BY va', 'SELECT id FROM t WHERE a BETWEEN 8 AND 9 ORDER BY id']) {
      expect(db.queryPlan(planFromJSON(json(bind(catalog, q)))).rows, q).toEqual(db.query(q).rows);
    }
  });
});

describe('hand-built plans mean what their fields say', () => {
  const db = Database.openMemory();
  const text = (meaning: object): PlanExpr => ({ ...p.col(0, 0, 'text'), ...meaning }) as PlanExpr;
  const inList = (input: PlanOp, probe: PlanExpr, ...xs: (string | number)[]) => db.queryPlan(p.filter(input, p.call('in_list', [probe, ...xs.map((x) => p.lit(x))], 'int'))).rows;

  it('a collation carried from a column compares as that collation', () => {
    const rows = p.values([[p.lit('X')], [p.lit('y')]]);
    expect(inList(rows, text({}), 'x', 'z')).toEqual([]);
    expect(inList(rows, text({ carries: { collation: 'nocase', from: 'column' } }), 'x', 'z')).toEqual([['X']]);
  });

  it('an affinity converts the other side of a comparison, as SQL does', () => {
    const rows = p.values([[p.lit('7')], [p.lit('8')]]);
    expect(inList(rows, text({}), 7, 9)).toEqual([]);
    expect(inList(rows, text({ affinity: 'TEXT' }), 7, 9)).toEqual([['7']]);
  });

  it('inline: false and decorrelate: false change no results', () => {
    const rows = p.values([[p.lit(1)], [p.lit(5)]]);
    const gt = (meaning: object) => p.filter(rows, { ...p.call('cmp_gt', [p.col(0, 0, 'int'), p.lit(2)], 'int'), ...meaning } as PlanExpr);
    expect(db.queryPlan(gt({ inline: false })).rows).toEqual(db.queryPlan(gt({})).rows);
    expect(db.queryPlan({ ...gt({}), decorrelate: false } as PlanOp).rows).toEqual([[5]]);
  });
});

describe('the validator checks the meaning fields', () => {
  const db = Database.openMemory();
  const rows = p.values([[p.lit('a')]]);
  const withField = (meaning: object): PlanOp => p.project(rows, [{ ...p.col(0, 0, 'text'), ...meaning } as PlanExpr]);
  const fails = (plan: PlanOp, msg: RegExp): void => {
    let err: unknown;
    try {
      db.queryPlan(plan);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SmaltError);
    expect((err as SmaltError).code).toBe('SMALT_PLAN');
    expect((err as Error).message).toMatch(msg);
  };

  it('refuses malformed fields', () => {
    fails(withField({ carries: 'nocase' }), /carries: expected \{ collation, from \}/);
    fails(withField({ carries: { collation: 'latin1', from: 'column' } }), /carries\.collation: unknown collation "latin1"/);
    fails(withField({ carries: { collation: 'nocase', from: 'table' } }), /carries\.from: unknown collation source "table"/);
    fails(withField({ affinity: 'int' }), /affinity: unknown affinity "int"/);
    fails(withField({ inline: true }), /inline: inline is false or absent/);
    fails({ ...rows, decorrelate: true } as unknown as PlanOp, /decorrelate: decorrelate is false or absent/);
  });
});

describe('format version 0', () => {
  it('JSON with $sql / $flattened metadata decodes to the meaning fields', () => {
    const v0 = JSON.stringify({
      version: 0,
      plan: {
        op: 'filter',
        $flattened: true,
        input: { op: 'values', rows: [[{ k: 'lit', value: 'X', type: 'text' }]], types: ['text'] },
        pred: {
          k: 'call',
          fn: 'in_list',
          type: 'int',
          args: [
            { k: 'col', input: 0, index: 0, depth: 0, type: 'text', collation: 'binary', $sql: { collation: 1, collSrc: 1, affinity: 'TEXT', opaque: true } },
            { k: 'lit', value: 'x', type: 'text' },
          ],
        },
      },
    });
    const plan = planFromJSON(v0);
    expect(plan.decorrelate).toBe(false);
    const probe = (plan as Extract<PlanOp, { op: 'filter' }>).pred as Extract<PlanExpr, { k: 'call' }>;
    expect(probe.args[0]).toMatchObject({ carries: { collation: 'nocase', from: 'column' }, affinity: 'TEXT', inline: false });
    expect(json(plan)).not.toMatch(/\$sql|\$flattened/);
    expect(Database.openMemory().queryPlan(plan).rows).toEqual([['X']]);
  });

  it('other versions are refused', () => {
    expect(() => planFromJSON(JSON.stringify({ version: PLAN_FORMAT_VERSION + 1, plan: {} }))).toThrow(/plan format version/);
  });
});
