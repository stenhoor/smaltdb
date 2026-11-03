/** Binding the parser's expressions to plan expressions (ADR 0014, step 3b): SQL's rules become explicit. */
import { describe, expect, it } from 'vitest';
import { type CompileScope, bindExpr, compilePlanExpr } from '../src/engine/exec/expr.js';
import type { Affinity, StaticType } from '../src/engine/exec/convert.js';
import { parseOne } from '../src/engine/sql/parser.js';
import type { Expr, SelectStmt } from '../src/engine/sql/ast.js';
import { printExpr } from '../src/engine/plan/print.js';
import { Collation } from '../src/engine/values.js';

/** Columns i INTEGER (r0), r REAL (r1), s TEXT (r2), c TEXT COLLATE NOCASE (r3), u without affinity (r4). */
const COLUMNS: Record<string, { reg: number; type: StaticType; affinity: Affinity; collation: Collation }> = {
  i: { reg: 0, type: 'int', affinity: 'INTEGER', collation: Collation.Binary },
  r: { reg: 1, type: 'real', affinity: 'REAL', collation: Collation.Binary },
  s: { reg: 2, type: 'text', affinity: 'TEXT', collation: Collation.Binary },
  c: { reg: 3, type: 'text', affinity: 'TEXT', collation: Collation.NoCase },
  u: { reg: 4, type: 'any', affinity: 'NONE', collation: Collation.Binary },
};

const scope: CompileScope = {
  resolveColumn: (e) => {
    const b = COLUMNS[e.name];
    if (!b) throw new Error(`no such column: ${e.name}`);
    return b;
  },
  scalarSubquery: () => {
    throw new Error('no subqueries here');
  },
  existsSubquery: () => {
    throw new Error('no subqueries here');
  },
  inSubquery: () => {
    throw new Error('no subqueries here');
  },
  funcCtx: { lastInsertRowid: () => 0, changes: () => 0, totalChanges: () => 0, now: () => 0 },
};

const expr = (sql: string): Expr => {
  const s = parseOne(`SELECT ${sql}`).stmt as SelectStmt;
  const col = (s.core as { columns: { kind: string; expr: Expr }[] }).columns[0];
  return col.expr;
};
const bound = (sql: string): string => printExpr(bindExpr(expr(sql), scope));
const run = (sql: string, row: unknown[]): unknown => compilePlanExpr(bindExpr(expr(sql), scope), scope.funcCtx).fn(row as never);

describe('binding', () => {
  it('makes comparison collations and affinity conversions explicit', () => {
    // SQLite applies the column's numeric affinity to the other operand, even a number (where it changes nothing).
    expect(bound('i = 5')).toBe('sql.eq(r0, sql.affinity_numeric(5))');
    expect(bound('i = r')).toBe('sql.eq(r0, r1)');
    expect(bound("i = '5'")).toBe("sql.eq(r0, sql.affinity_numeric('5'))");
    expect(bound('s = 5')).toBe("sql.eq(r2, sql.affinity_text(5))");
    expect(bound("c = 'x'")).toBe("sql.eq(r3, sql.affinity_text('x'))[nocase]");
    expect(bound("s = c COLLATE RTRIM")).toBe('sql.eq(r2, r3)[rtrim]');
    expect(bound('u < 3')).toBe('sql.lt(r4, 3)');
  });

  it('names an sql function for each operator', () => {
    expect(bound('i + r * 2')).toBe('sql.add(r0, sql.mul(r1, 2))');
    expect(bound("s || 'x' LIKE 'a%'")).toBe("sql.like(sql.concat(r2, 'x'), 'a%')");
    expect(bound('u NOT BETWEEN 1 AND 3')).toBe('not (sql.ge(r4, 1) and sql.le(r4, 3))');
    expect(bound('CASE i WHEN 1 THEN s ELSE upper(s) END')).toBe('case when sql.eq(r0, sql.affinity_numeric(1)) then r2 else upper(r2) end');
    expect(bound('CAST(s AS INTEGER)')).toBe('sql.cast_integer(r2)');
    expect(bound('i IN (1, 2)')).toBe('sql.in_list(r0, 1, 2)');
    expect(bound('-i')).toBe('sql.neg(r0)');
    expect(bound('?2')).toBe('$1');
  });

  it('types expressions as the compiler does', () => {
    for (const sql of ['i + r', 'i + 1', 'u + 1', 's || i', 'abs(r)', 'round(i)', 'floor(r)', 'coalesce(i, r)', 'CASE WHEN 1 THEN i ELSE r END', 'sqrt(i)', 'substr(s, 1)']) {
      const b = bindExpr(expr(sql), scope);
      expect(compilePlanExpr(b, scope.funcCtx).type, sql).toBe(b.k === 'call' || b.k === 'case' ? b.type : compilePlanExpr(b, scope.funcCtx).type);
    }
  });

  it('compiles to the same results', () => {
    const row = [3, 2.5, 'Abc', 'abc', '7'];
    expect(run("i = '3'", row)).toBe(1);
    expect(run("c = 'ABC'", row)).toBe(1);
    expect(run("s = 'abc'", row)).toBe(0);
    expect(run('u = 7', row)).toBe(0); // no affinity on either side: text is not 7
    expect(run('+s = 3', [3, 0, '3', null, null])).toBe(0); // unary plus drops the TEXT affinity
    expect(run('s = 3', [3, 0, '3', null, null])).toBe(1);
    expect(run('i NOT IN (1, 2)', row)).toBe(1);
    expect(run("s NOT LIKE 'a%'", row)).toBe(0);
  });

  it('keeps errors', () => {
    expect(() => bindExpr(expr("s COLLATE nope = 'x'"), scope)).toThrow(/no such collation sequence: nope/i);
    expect(() => bindExpr(expr('nosuch(1)'), scope)).toThrow('no such function: nosuch');
    expect(() => bindExpr(expr('abs(1, 2)'), scope)).toThrow('wrong number of arguments to function abs()');
    expect(() => bindExpr(expr('sum(i)'), scope)).toThrow('misuse of aggregate function sum()');
  });
});
