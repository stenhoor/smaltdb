import { describe, expect, it } from 'vitest';
import type * as A from '../src/engine/sql/ast.js';
import { tokenize, TK_BLOB, TK_EOF, TK_FLOAT, TK_ILLEGAL, TK_INT, TK_OP, TK_PARAM, TK_QID, TK_STRING } from '../src/engine/sql/lexer.js';
import { parse, parseExpr, parseOne, SqlSyntaxError } from '../src/engine/sql/parser.js';

/** Compact rendering of an expression tree for precedence tests. */
function sx(e: A.Expr): string {
  switch (e.kind) {
    case 'literal':
      return e.value === null ? 'NULL' : typeof e.value === 'string' ? `'${e.value}'` : String(e.value);
    case 'column':
      return [e.schema, e.table, e.name].filter((x) => x !== undefined).join('.');
    case 'param':
      return e.name ?? `?${e.index}`;
    case 'unary':
      return `(${e.op} ${sx(e.operand)})`;
    case 'binary':
      return `(${sx(e.left)} ${e.op} ${sx(e.right)})`;
    case 'between':
      return `(${sx(e.expr)} ${e.not ? 'NOT ' : ''}BETWEEN ${sx(e.low)} AND ${sx(e.high)})`;
    case 'inList':
      return `(${sx(e.expr)} ${e.not ? 'NOT ' : ''}IN [${e.list.map(sx).join(', ')}])`;
    case 'inSelect':
      return `(${sx(e.expr)} ${e.not ? 'NOT ' : ''}IN <select>)`;
    case 'like':
      return `(${sx(e.expr)} ${e.not ? 'NOT ' : ''}${e.op} ${sx(e.pattern)}${e.escape ? ` ESCAPE ${sx(e.escape)}` : ''})`;
    case 'isNull':
      return `(${sx(e.expr)} ${e.not ? 'NOTNULL' : 'ISNULL'})`;
    case 'collate':
      return `(${sx(e.expr)} COLLATE ${e.collation})`;
    case 'cast':
      return `CAST(${sx(e.expr)} AS ${e.type})`;
    case 'call':
      return `${e.name}(${e.star ? '*' : (e.distinct ? 'DISTINCT ' : '') + e.args.map(sx).join(', ')})`;
    case 'case':
      return `CASE${e.base ? ' ' + sx(e.base) : ''}${e.whens.map((w) => ` WHEN ${sx(w.when)} THEN ${sx(w.then)}`).join('')}${e.else ? ' ELSE ' + sx(e.else) : ''} END`;
    case 'subquery':
      return '<subquery>';
    case 'exists':
      return `${e.not ? 'NOT ' : ''}EXISTS <select>`;
  }
}

const ex = (sql: string) => sx(parseExpr(sql));
const one = (sql: string) => parseOne(sql).stmt;
const sel = (sql: string) => one(sql) as A.SelectStmt;
const core = (sql: string) => sel(sql).core as A.SelectCoreSelect;

function syntaxError(sql: string): SqlSyntaxError {
  try {
    parse(sql);
  } catch (e) {
    expect(e).toBeInstanceOf(SqlSyntaxError);
    return e as SqlSyntaxError;
  }
  throw new Error(`expected a syntax error for: ${sql}`);
}

describe('lexer', () => {
  it('produces token kinds and offsets', () => {
    const t = tokenize("SELECT x'0aFF', 'it''s', \"a\"\"b\", 1.5, ?3 -- c\n/* d */ ;");
    expect(t.kinds).toEqual([2, TK_BLOB, TK_OP, TK_STRING, TK_OP, TK_QID, TK_OP, TK_FLOAT, TK_OP, TK_PARAM, TK_OP, TK_EOF]);
    expect(t.vals[1]).toEqual(new Uint8Array([0x0a, 0xff]));
    expect(t.vals[3]).toBe("it's");
    expect(t.vals[5]).toBe('a"b');
    expect(t.vals[9]).toBe('?3');
    expect(t.starts[1]).toBe(7);
    expect(t.ends[1]).toBe(14);
    expect(t.kws[0]).toBe('SELECT');
  });

  it('scans operators', () => {
    const t = tokenize('|| -> ->> * / % + - << >> & | ~ < <= > >= = == != <> . , ( ) ;');
    expect(t.vals.slice(0, -1)).toEqual(
      ['||', '->', '->>', '*', '/', '%', '+', '-', '<<', '>>', '&', '|', '~', '<', '<=', '>', '>=', '=', '=', '!=', '!=', '.', ',', '(', ')', ';'],
    );
  });

  it('handles unterminated block comments and comment-only input', () => {
    expect(tokenize('1 /* never closed').count).toBe(2);
    expect(parse('-- nothing here\n/* or here */')).toEqual([]);
  });

  it('marks illegal tokens', () => {
    expect(tokenize('1abc').kinds[0]).toBe(TK_ILLEGAL);
    expect(tokenize("x'abc'").kinds[0]).toBe(TK_ILLEGAL);
    expect(tokenize("x'zz'").kinds[0]).toBe(TK_ILLEGAL);
    expect(tokenize('#').kinds[0]).toBe(TK_ILLEGAL);
    expect(tokenize('1e').kinds[0]).toBe(TK_ILLEGAL);
    expect(tokenize('0x1FFFFFFFFFFFFFFFF').kinds[0]).toBe(TK_ILLEGAL);
  });

  it('quoted identifier forms', () => {
    const t = tokenize('[a b] `c``d` "e"');
    expect(t.kinds.slice(0, 3)).toEqual([TK_QID, TK_QID, TK_QID]);
    expect(t.vals.slice(0, 3)).toEqual(['a b', 'c`d', 'e']);
  });

  it('number kinds', () => {
    const t = tokenize('1 .5 1. 1e3 1E-2 0x1F 9007199254740992');
    expect(t.kinds.slice(0, 7)).toEqual([TK_INT, TK_FLOAT, TK_FLOAT, TK_FLOAT, TK_FLOAT, TK_INT, TK_INT]);
    expect(t.vals.slice(0, 7)).toEqual([1, 0.5, 1, 1000, 0.01, 31, 9007199254740992n]);
  });
});

describe('literals', () => {
  const lit = (sql: string) => parseExpr(sql) as A.LiteralExpr;
  it('integers and bigint boundaries', () => {
    expect(lit('42').value).toBe(42);
    expect(lit('9007199254740991').value).toBe(9007199254740991);
    expect(lit('9007199254740992').value).toBe(9007199254740992n);
    expect(lit('-9007199254740991').value).toBe(-9007199254740991);
    expect(lit('-9007199254740992').value).toBe(-9007199254740992n);
    expect(lit('9223372036854775807').value).toBe(9223372036854775807n);
    expect(lit('-9223372036854775808').value).toBe(-9223372036854775808n);
    expect(lit('-9223372036854775808').isReal).toBeUndefined();
    // Beyond int64: REAL, as in SQLite.
    expect(lit('9223372036854775808')).toMatchObject({ value: 9223372036854775808, isReal: true });
    expect(lit('-9223372036854775809')).toMatchObject({ value: -9223372036854775809, isReal: true });
    expect(lit('-0').value).toBe(0);
    expect(Object.is(lit('-0').value, -0)).toBe(false);
  });

  it('hex integers are 64-bit two\'s complement', () => {
    expect(lit('0x1F').value).toBe(31);
    expect(lit('0xFFFFFFFFFFFFFFFF').value).toBe(-1);
    expect(lit('0x7FFFFFFFFFFFFFFF').value).toBe(9223372036854775807n);
    expect(lit('-0x10').value).toBe(-16);
    expect(syntaxError('SELECT 0x10000000000000000').reason).toBe('hex literal too big: 0x10000000000000000');
  });

  it('reals', () => {
    expect(lit('1.0')).toMatchObject({ value: 1, isReal: true });
    expect(lit('.5')).toMatchObject({ value: 0.5, isReal: true });
    expect(lit('1e3')).toMatchObject({ value: 1000, isReal: true });
    expect(lit('-2.5e-1')).toMatchObject({ value: -0.25, isReal: true });
    expect(lit('1').isReal).toBeUndefined();
  });

  it('strings, blobs, NULL, booleans', () => {
    expect(lit("'it''s'").value).toBe("it's");
    expect(lit("''").value).toBe('');
    expect(lit("X'CAFE'").value).toEqual(new Uint8Array([0xca, 0xfe]));
    expect(lit("x''").value).toEqual(new Uint8Array(0));
    expect(lit('NULL').value).toBeNull();
    expect(lit('TRUE').value).toBe(1);
    expect(lit('false').value).toBe(0);
  });

  it('CURRENT_* keywords become zero-arg calls', () => {
    expect(parseExpr('CURRENT_TIMESTAMP')).toMatchObject({ kind: 'call', name: 'current_timestamp', args: [], star: false });
    expect(parseExpr('current_date')).toMatchObject({ kind: 'call', name: 'current_date' });
    expect(parseExpr('CURRENT_TIME')).toMatchObject({ kind: 'call', name: 'current_time' });
  });
});

describe('expression precedence', () => {
  it.each([
    ['1 + 2 * 3', '(1 + (2 * 3))'],
    ['1 * 2 + 3', '((1 * 2) + 3)'],
    ['1 - 2 - 3', '((1 - 2) - 3)'],
    ['a OR b AND c', '(a OR (b AND c))'],
    ['a AND b OR c', '((a AND b) OR c)'],
    ['NOT a = b', '(NOT (a = b))'],
    ['NOT a AND b', '((NOT a) AND b)'],
    ['NOT NOT a', '(NOT (NOT a))'],
    ['a = b IS NOT NULL', '((a = b) NOTNULL)'],
    ['a < b = c', '((a < b) = c)'],
    ['a = b < c', '(a = (b < c))'],
    ["a || b * c", '((a || b) * c)'],
    ['a & b + c', '(a & (b + c))'],
    ['a << 1 < b', '((a << 1) < b)'],
    ['-a * b', '((- a) * b)'],
    ['~a + 1', '((~ a) + 1)'],
    ['- - 1', '(- -1)'],
    ['a -> b ->> c', '((a -> b) ->> c)'],
    ['a == b', '(a = b)'],
    ['a <> b', '(a != b)'],
    ['a IS b', '(a IS b)'],
    ['a IS NOT b', '(a IS NOT b)'],
    ['a IS DISTINCT FROM b', '(a IS NOT b)'],
    ['a IS NOT DISTINCT FROM b', '(a IS b)'],
    ['a IS NULL', '(a ISNULL)'],
    ['a ISNULL', '(a ISNULL)'],
    ['a NOTNULL', '(a NOTNULL)'],
    ['a NOT NULL', '(a NOTNULL)'],
    ['a NOT NULL AND b', '((a NOTNULL) AND b)'],
    ['x COLLATE nocase = y', '((x COLLATE NOCASE) = y)'],
    ['-x COLLATE nocase', '(- (x COLLATE NOCASE))'],
    ['a || b COLLATE rtrim', '(a || (b COLLATE RTRIM))'],
    ['a BETWEEN 1 AND 2', '(a BETWEEN 1 AND 2)'],
    ['a BETWEEN 1 AND 2 AND b', '((a BETWEEN 1 AND 2) AND b)'],
    ['a NOT BETWEEN b + 1 AND c * 2 OR d', '((a NOT BETWEEN (b + 1) AND (c * 2)) OR d)'],
    ['a BETWEEN 1 AND 2 = 1', '((a BETWEEN 1 AND 2) = 1)'],
    ['a IN (1, 2)', '(a IN [1, 2])'],
    ['a NOT IN ()', '(a NOT IN [])'],
    ['a + 1 IN (b)', '((a + 1) IN [b])'],
    ['a IN (SELECT 1)', '(a IN <select>)'],
    ["a LIKE 'x%'", "(a LIKE 'x%')"],
    ["a NOT LIKE 'x!%' ESCAPE '!'", "(a NOT LIKE 'x!%' ESCAPE '!')"],
    ["a GLOB 'x*' AND b NOT GLOB 'y'", "((a GLOB 'x*') AND (b NOT GLOB 'y'))"],
    ['a MATCH b', '(a MATCH b)'],
    ['a NOT REGEXP b', '(a NOT REGEXP b)'],
    ['NOT a LIKE b', "(NOT (a LIKE b))"],
    ['1 + NOT 2 = 3', '(1 + (NOT (2 = 3)))'],
    ['EXISTS (SELECT 1)', 'EXISTS <select>'],
    ['NOT EXISTS (SELECT 1)', 'NOT EXISTS <select>'],
    ['(SELECT 1) + 1', '(<subquery> + 1)'],
    ['(1 + 2) * 3', '((1 + 2) * 3)'],
    ['CAST(a AS varchar(10))', 'CAST(a AS VARCHAR(10))'],
    ['CAST(a AS double  precision)', 'CAST(a AS DOUBLE PRECISION)'],
    ['CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END', 'CASE WHEN a THEN 1 WHEN b THEN 2 ELSE 3 END'],
    ['CASE x WHEN 1 THEN 2 END', 'CASE x WHEN 1 THEN 2 END'],
    ['t.c + s.t.c', '(t.c + s.t.c)'],
    ['count(*)', 'count(*)'],
    ['COUNT(DISTINCT a)', 'count(DISTINCT a)'],
    ['Max(a, b)', 'max(a, b)'],
    ['random()', 'random()'],
    ['replace(a, b, c)', 'replace(a, b, c)'],
    ['like(a, b)', 'like(a, b)'],
  ])('%s', (sql, expected) => {
    expect(ex(sql)).toBe(expected);
  });

  it('records positions on every node', () => {
    const e = parseExpr('a + b * 3') as A.BinaryExpr;
    expect(e.pos).toBe(0);
    expect(e.right.pos).toBe(4);
    expect((e.right as A.BinaryExpr).right.pos).toBe(8);
    expect(parseExpr('  -5').pos).toBe(2);
    expect(parseExpr('x NOT IN (1)').pos).toBe(0);
  });

  it('end offsets reproduce the source text of expressions and result columns', () => {
    const exprs = ['a + 1', 'f(x,  y) FILTER (WHERE y > 0)', '-  5', 'x NOT BETWEEN 1 AND 2', 'a IS NOT NULL', 'a NOTNULL', "b COLLATE nocase", 'CAST(a AS INT)', 'CASE WHEN a THEN b END', 't.c', '(a+1)', '(a + 1) * 2', 'NOT EXISTS (SELECT 1)', 'x IN (1, 2)', ':p', "'s'", 'count(*) OVER (ORDER BY a)'];
    for (const text of exprs) {
      const sql = `SELECT ${text} AS c, ${text} FROM t`;
      const cols = core(sql).columns as { expr: A.Expr; pos: number; end: number }[];
      expect(sql.slice(cols[0].expr.pos, cols[0].expr.end)).toBe(text);
      expect(sql.slice(cols[0].pos, cols[0].end)).toBe(`${text} AS c`);
      expect(sql.slice(cols[1].expr.pos, cols[1].expr.end)).toBe(text);
    }
    // Inner nodes have spans too; a parenthesized expression's span includes its parentheses.
    const sql = 'SELECT (a+1) * b';
    const e = core(sql).columns[0] as { expr: A.BinaryExpr };
    expect(sql.slice(e.expr.left.pos, e.expr.left.end)).toBe('(a+1)');
    expect(sql.slice(e.expr.right.pos, e.expr.right.end)).toBe('b');
  });

  it('statement and clause nodes carry spans', () => {
    const sql = 'SELECT * FROM a JOIN b ON a.x = b.x WHERE 1 ORDER BY a.x DESC';
    const s = sel(sql);
    expect(sql.slice(s.pos, s.end)).toBe(sql);
    const j = (s.core as A.SelectCoreSelect).from as A.JoinRef;
    expect(sql.slice(j.pos, j.end)).toBe('a JOIN b ON a.x = b.x');
    expect(sql.slice(s.orderBy[0].pos, s.orderBy[0].end)).toBe('a.x DESC');
    const ct = 'CREATE TABLE t (a INT NOT NULL, b TEXT DEFAULT (1)) STRICT';
    const c = one(ct) as A.CreateTableStmt;
    expect(c.end).toBe(ct.length);
    expect(ct.slice(c.columns[0].pos, c.columns[0].end)).toBe('a INT NOT NULL');
    expect(ct.slice(c.columns[1].constraints[0].pos, c.columns[1].constraints[0].end)).toBe('DEFAULT (1)');
  });

  it('rejects row values and IN table', () => {
    expect(syntaxError('SELECT (1, 2)').reason).toBe('row values are not supported');
    expect(syntaxError('SELECT 1 IN t').reason).toBe('near "t": syntax error');
  });

  it('function call extras: FILTER, OVER, ORDER BY in aggregates', () => {
    const c = parseExpr('sum(x) FILTER (WHERE x > 0) OVER (PARTITION BY g ORDER BY t ROWS BETWEEN 1 PRECEDING AND CURRENT ROW EXCLUDE TIES)') as A.CallExpr;
    expect(sx(c.filter!)).toBe('(x > 0)');
    const w = c.over as A.WindowSpec;
    expect(w.partitionBy.map(sx)).toEqual(['g']);
    expect(w.orderBy.map((o) => sx(o.expr))).toEqual(['t']);
    expect(w.frame).toMatchObject({ unit: 'ROWS', start: { kind: 'preceding' }, end: { kind: 'currentRow' }, exclude: 'TIES' });
    expect((parseExpr('row_number() OVER w') as A.CallExpr).over).toBe('w');
    const g = parseExpr("group_concat(x, ',' ORDER BY y DESC)") as A.CallExpr;
    expect(g.args).toHaveLength(2);
    expect(g.orderBy![0].desc).toBe(true);
    const r = (parseExpr('sum(x) OVER (base RANGE UNBOUNDED PRECEDING)') as A.CallExpr).over as A.WindowSpec;
    expect(r.base).toBe('base');
    expect(r.frame).toMatchObject({ unit: 'RANGE', start: { kind: 'unboundedPreceding' } });
    expect(r.frame!.end).toBeUndefined();
    const gr = (parseExpr('sum(x) OVER (GROUPS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING EXCLUDE NO OTHERS)') as A.CallExpr).over as A.WindowSpec;
    expect(gr.frame).toMatchObject({ unit: 'GROUPS', start: { kind: 'currentRow' }, end: { kind: 'unboundedFollowing' }, exclude: 'NO OTHERS' });
  });
});

describe('identifiers', () => {
  it('quoted identifiers are unquoted', () => {
    expect(parseExpr('"My Col"')).toMatchObject({ kind: 'column', name: 'My Col' });
    expect(parseExpr('[select]')).toMatchObject({ kind: 'column', name: 'select' });
    expect(parseExpr('`a``b`.c')).toMatchObject({ kind: 'column', table: 'a`b', name: 'c' });
  });

  it('non-reserved keywords work as column and table names', () => {
    const names = ['key', 'value', 'data', 'name', 'type', 'text', 'date', 'time', 'count', 'first', 'last', 'replace', 'temp', 'row', 'action', 'view', 'match', 'do', 'filter', 'over', 'rows', 'range', 'groups', 'current', 'no', 'others', 'ties', 'exclude', 'generated', 'always', 'stored', 'virtual', 'materialized', 'refresh', 'strict', 'loose', 'include', 'analyze', 'vacuum', 'pragma', 'plan', 'query', 'begin', 'end', 'abort', 'fail', 'ignore', 'rollback', 'offset', 'asc', 'desc', 'if', 'column'];
    for (const n of names) {
      const s = one(`CREATE TABLE ${n} (${n} TEXT, x INTEGER)`) as A.CreateTableStmt;
      expect(s.name).toBe(n);
      expect(s.columns[0]).toMatchObject({ name: n, type: 'TEXT' });
      const c = core(`SELECT ${n}, t.${n} FROM ${n} AS t WHERE ${n} = 1 ORDER BY ${n}`);
      expect(c.columns[0]).toMatchObject({ kind: 'expr', expr: { kind: 'column', name: n } });
      expect(c.from).toMatchObject({ kind: 'table', name: n, alias: 't' });
      expect(sx(c.where!)).toBe(`(${n} = 1)`);
      const ins = one(`INSERT INTO t (${n}) VALUES (1)`) as A.InsertStmt;
      expect(ins.columns).toEqual([n]);
    }
  });

  it('keeps case of identifiers', () => {
    expect(core('SELECT Key FROM T').columns[0]).toMatchObject({ expr: { name: 'Key' } });
  });

  it('reserved keywords cannot be identifiers', () => {
    expect(syntaxError('SELECT * FROM select').reason).toBe('near "select": syntax error');
    expect(syntaxError('CREATE TABLE t (from INT)').reason).toBe('near "from": syntax error');
  });

  it('implicit aliases', () => {
    const c = core("SELECT a b, c 'd', e AS \"f g\", h AS 'i', j key FROM t x, u row");
    expect(c.columns.map((r) => (r.kind === 'expr' ? r.alias : undefined))).toEqual(['b', 'd', 'f g', 'i', 'key']);
    expect(c.from).toMatchObject({ kind: 'join', left: { alias: 'x' }, right: { alias: 'row' } });
  });
});

describe('parameters', () => {
  const params = (sql: string) => {
    const st = parseOne(sql);
    const out: string[] = [];
    const walk = (x: unknown): void => {
      if (x === null || typeof x !== 'object') return;
      if ((x as A.Expr).kind === 'param') {
        const p = x as A.ParamExpr;
        out.push(`${p.name ?? '?'}=${p.index}`);
        return;
      }
      for (const v of Object.values(x)) walk(v);
    };
    walk(st.stmt);
    return { list: out, count: st.paramCount, names: Object.fromEntries(st.paramNames) };
  };

  it('numbers positional parameters', () => {
    expect(params('SELECT ?, ?, ?')).toEqual({ list: ['?=1', '?=2', '?=3'], count: 3, names: {} });
  });

  it('?NNN sets the slot and later ? continue after the max', () => {
    expect(params('SELECT ?5, ?, ?2, ?')).toEqual({ list: ['?=5', '?=6', '?=2', '?=7'], count: 7, names: {} });
  });

  it('named parameters reuse their slot', () => {
    expect(params('SELECT :a, @b, :a, $c, ?, @b')).toEqual({
      list: [':a=1', '@b=2', ':a=1', '$c=3', '?=4', '@b=2'],
      count: 4,
      names: { ':a': 1, '@b': 2, '$c': 3 },
    });
  });

  it('numbering is per statement', () => {
    const [a, b] = parse('SELECT ?, ?; SELECT :x, ?');
    expect(a.paramCount).toBe(2);
    expect(b.paramCount).toBe(2);
    expect(b.paramNames.get(':x')).toBe(1);
  });

  it('rejects out-of-range ?NNN', () => {
    expect(syntaxError('SELECT ?0').reason).toBe('variable number must be between ?1 and ?32766');
    expect(syntaxError('SELECT ?40000').reason).toMatch(/variable number/);
  });
});

describe('SELECT', () => {
  it('basic clauses', () => {
    const s = sel('SELECT DISTINCT a, t.*, * FROM t WHERE a > 1 GROUP BY a, b HAVING count(*) > 1 ORDER BY a DESC, b NULLS FIRST LIMIT 10 OFFSET 5');
    const c = s.core as A.SelectCoreSelect;
    expect(c.distinct).toBe(true);
    expect(c.columns.map((r) => r.kind)).toEqual(['expr', 'tableStar', 'star']);
    expect(c.columns[1]).toMatchObject({ table: 't', pos: 19 });
    expect(c.groupBy.map(sx)).toEqual(['a', 'b']);
    expect(sx(c.having!)).toBe('(count(*) > 1)');
    expect(s.orderBy.map((o) => [sx(o.expr), o.desc, o.nulls])).toEqual([
      ['a', true, undefined],
      ['b', false, 'FIRST'],
    ]);
    expect(sx(s.limit!)).toBe('10');
    expect(sx(s.offset!)).toBe('5');
  });

  it("LIMIT a, b puts the first value in OFFSET", () => {
    const s = sel('SELECT 1 LIMIT 3, 7');
    expect(sx(s.limit!)).toBe('7');
    expect(sx(s.offset!)).toBe('3');
  });

  it('SELECT without FROM and ALL', () => {
    const c = core('SELECT ALL 1');
    expect(c.distinct).toBe(false);
    expect(c.from).toBeUndefined();
  });

  it('compound selects and VALUES', () => {
    const s = sel('SELECT 1 UNION SELECT 2 UNION ALL VALUES (3), (4) INTERSECT SELECT 5 EXCEPT SELECT 6 ORDER BY 1');
    expect(s.compound.map((c) => c.op)).toEqual(['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT']);
    expect(s.compound[1].core).toMatchObject({ kind: 'values', rows: [[{ value: 3 }], [{ value: 4 }]] });
    expect(s.orderBy).toHaveLength(1);
    const v = sel("VALUES (1, 'a'), (2, 'b')");
    expect(v.core).toMatchObject({ kind: 'values', pos: 0 });
    expect((v.core as A.SelectCoreValues).rows).toHaveLength(2);
  });

  it('WITH clauses', () => {
    const s = sel('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 10), d AS MATERIALIZED (SELECT 2), e AS NOT MATERIALIZED (SELECT 3) SELECT * FROM c');
    expect(s.with!.recursive).toBe(true);
    expect(s.with!.ctes.map((c) => [c.name, c.columns, c.materialized])).toEqual([
      ['c', ['n'], undefined],
      ['d', undefined, true],
      ['e', undefined, false],
    ]);
    expect(s.with!.ctes[0].select.compound).toHaveLength(1);
    expect(s.pos).toBe(0);
  });

  it('joins', () => {
    const c = core('SELECT * FROM a JOIN b ON a.id = b.id LEFT OUTER JOIN c USING (id, x) NATURAL RIGHT JOIN d CROSS JOIN e INNER JOIN f FULL JOIN g, h');
    const kinds: string[] = [];
    let f = c.from!;
    while (f.kind === 'join') {
      kinds.unshift(`${f.natural ? 'NATURAL ' : ''}${f.joinType}${f.on ? ' ON' : ''}${f.using ? ' USING ' + f.using.join(',') : ''}`);
      f = f.left;
    }
    expect(f).toMatchObject({ kind: 'table', name: 'a' });
    expect(kinds).toEqual(['INNER ON', 'LEFT USING id,x', 'NATURAL RIGHT', 'CROSS', 'INNER', 'FULL', 'CROSS']);
  });

  it('nested joins, subqueries, table functions, schema names and index hints', () => {
    const c = core('SELECT * FROM (a JOIN b ON 1) LEFT JOIN (SELECT 1 AS x) sq ON 1, pragma_table_info(\'t\') AS p, main.t INDEXED BY i, u NOT INDEXED, (v) w');
    const j = c.from as A.JoinRef;
    expect(j.right).toMatchObject({ kind: 'table', name: 'v', alias: 'w' });
    const l1 = j.left as A.JoinRef;
    expect(l1.right).toMatchObject({ kind: 'table', name: 'u', indexedBy: null });
    const l2 = l1.left as A.JoinRef;
    expect(l2.right).toMatchObject({ kind: 'table', schema: 'main', name: 't', indexedBy: 'i' });
    const l3 = l2.left as A.JoinRef;
    expect(l3.right).toMatchObject({ kind: 'function', name: 'pragma_table_info', alias: 'p', args: [{ value: 't' }] });
    const l4 = l3.left as A.JoinRef;
    expect(l4.joinType).toBe('LEFT');
    expect(l4.right).toMatchObject({ kind: 'subquery', alias: 'sq' });
    expect(l4.left).toMatchObject({ kind: 'join', left: { name: 'a' }, right: { name: 'b' } });
  });

  it('named windows', () => {
    const c = core('SELECT sum(x) OVER w FROM t WINDOW w AS (PARTITION BY y), w2 AS (w ORDER BY z)');
    expect(c.windows.map((w) => w.name)).toEqual(['w', 'w2']);
    expect(c.windows[1].spec.base).toBe('w');
  });

  it('subqueries in expressions', () => {
    const sql = 'SELECT (SELECT max(x) FROM t), x IN (WITH q AS (SELECT 1) SELECT * FROM q) FROM u WHERE NOT EXISTS (SELECT 1 FROM v WHERE v.a = u.a)';
    const c = core(sql);
    expect(c.columns[0]).toMatchObject({ expr: { kind: 'subquery' } });
    expect(c.columns[1]).toMatchObject({ expr: { kind: 'inSelect', select: { with: { ctes: [{ name: 'q' }] } } } });
    expect(c.where).toMatchObject({ kind: 'exists', not: true, pos: sql.indexOf('NOT EXISTS'), end: sql.length });
  });
});

describe('INSERT', () => {
  it('values, columns, alias, schema', () => {
    const s = one('INSERT INTO main.t AS x (a, b) VALUES (1, 2), (3, 4)') as A.InsertStmt;
    expect(s).toMatchObject({ kind: 'insert', schema: 'main', table: 't', alias: 'x', columns: ['a', 'b'], upsert: [] });
    expect(s.source).toMatchObject({ kind: 'values' });
    expect((s.source as { rows: A.Expr[][] }).rows.map((r) => r.map(sx))).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('OR actions and REPLACE INTO', () => {
    for (const a of ['ROLLBACK', 'ABORT', 'FAIL', 'IGNORE', 'REPLACE']) {
      expect((one(`INSERT OR ${a} INTO t VALUES (1)`) as A.InsertStmt).or).toBe(a);
    }
    expect((one('REPLACE INTO t VALUES (1)') as A.InsertStmt).or).toBe('REPLACE');
    expect((one('INSERT INTO t VALUES (1)') as A.InsertStmt).or).toBeUndefined();
  });

  it('SELECT and DEFAULT VALUES sources', () => {
    expect((one('INSERT INTO t SELECT * FROM u') as A.InsertStmt).source.kind).toBe('select');
    expect((one('INSERT INTO t VALUES (1) UNION SELECT 2') as A.InsertStmt).source.kind).toBe('select');
    expect((one('INSERT INTO t DEFAULT VALUES') as A.InsertStmt).source).toEqual({ kind: 'default' });
    const w = one('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x') as A.InsertStmt;
    expect(w.with!.ctes[0].name).toBe('x');
  });

  it('upsert clauses and RETURNING', () => {
    const s = one(
      'INSERT INTO t (a, b) SELECT a, b FROM u ON CONFLICT (a COLLATE nocase, b) WHERE b > 0 DO UPDATE SET b = excluded.b, (c, d) = (1) WHERE t.b < excluded.b ON CONFLICT DO NOTHING RETURNING *, a AS z',
    ) as A.InsertStmt;
    expect(s.upsert).toHaveLength(2);
    const u = s.upsert[0];
    expect(u.target!.columns.map((c) => [sx(c.expr), c.collation])).toEqual([
      ['a', 'NOCASE'],
      ['b', undefined],
    ]);
    expect(sx(u.target!.where!)).toBe('(b > 0)');
    expect(u.action.kind).toBe('update');
    if (u.action.kind === 'update') {
      expect(u.action.set.map((x) => x.columns)).toEqual([['b'], ['c', 'd']]);
      expect(sx(u.action.where!)).toBe('(t.b < excluded.b)');
    }
    expect(s.upsert[1]).toMatchObject({ target: undefined, action: { kind: 'nothing' } });
    expect(s.returning!.map((r) => r.kind)).toEqual(['star', 'expr']);
  });
});

describe('UPDATE / DELETE', () => {
  it('UPDATE with all clauses', () => {
    const s = one('UPDATE OR IGNORE main.t AS x SET a = 1, (b, c) = (SELECT 1, 2) FROM u WHERE x.id = u.id RETURNING a ORDER BY a LIMIT 5 OFFSET 2') as A.UpdateStmt;
    expect(s).toMatchObject({ kind: 'update', or: 'IGNORE', schema: 'main', table: 't', alias: 'x' });
    expect(s.set.map((c) => c.columns)).toEqual([['a'], ['b', 'c']]);
    expect(s.from).toMatchObject({ kind: 'table', name: 'u' });
    expect(s.returning).toHaveLength(1);
    expect(s.orderBy).toHaveLength(1);
    expect(sx(s.limit!)).toBe('5');
    expect(sx(s.offset!)).toBe('2');
  });

  it('DELETE', () => {
    const s = one('WITH q AS (SELECT 1) DELETE FROM t INDEXED BY ix WHERE a IN (SELECT * FROM q) IS NULL') as A.DeleteStmt;
    expect(s).toMatchObject({ kind: 'delete', table: 't', indexedBy: 'ix', with: { ctes: [{ name: 'q' }] } });
  });

  it('DELETE with returning, order and limit', () => {
    const s = one('DELETE FROM t WHERE a = 1 RETURNING * ORDER BY b LIMIT 1') as A.DeleteStmt;
    expect(sx(s.where!)).toBe('(a = 1)');
    expect(s.returning).toEqual([{ kind: 'star', pos: 36, end: 37 }]);
    expect(s.orderBy).toHaveLength(1);
    expect(s.limit).toBeDefined();
  });
});

describe('CREATE TABLE', () => {
  it('normalizes type names', () => {
    const s = one('CREATE TABLE t (a varchar ( 20 ), b double   precision, c DECIMAL(10, 2), d unsigned big int, e, f INT(-1), g "text")') as A.CreateTableStmt;
    expect(s.columns.map((c) => c.type)).toEqual(['VARCHAR(20)', 'DOUBLE PRECISION', 'DECIMAL(10,2)', 'UNSIGNED BIG INT', undefined, 'INT(-1)', 'TEXT']);
  });

  it('column constraints', () => {
    const s = one(`CREATE TEMP TABLE IF NOT EXISTS main.t (
      id INTEGER CONSTRAINT pk PRIMARY KEY DESC ON CONFLICT REPLACE AUTOINCREMENT,
      a TEXT NOT NULL ON CONFLICT FAIL NULL UNIQUE CHECK (length(a) > 0) DEFAULT 'x' COLLATE nocase,
      b INT DEFAULT -1, c REAL DEFAULT +1.5, d DEFAULT (1 + 2), e DEFAULT CURRENT_TIMESTAMP, f DEFAULT abc, g DEFAULT NULL, h DEFAULT TRUE,
      i REFERENCES p(id) ON DELETE SET NULL ON UPDATE CASCADE MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED,
      j INT GENERATED ALWAYS AS (a || 'x') STORED, k AS (1) VIRTUAL, l AS (2)
    )`) as A.CreateTableStmt;
    expect(s).toMatchObject({ temp: true, ifNotExists: true, schema: 'main', name: 't' });
    const col = (n: string) => s.columns.find((c) => c.name === n)!.constraints;
    expect(col('id')).toMatchObject([
      { pos: expect.any(Number), name: 'pk', kind: 'primaryKey', desc: true, autoincrement: true, onConflict: 'REPLACE' },
    ]);
    expect(col('a').map((c) => c.kind)).toEqual(['notNull', 'null', 'unique', 'check', 'default', 'collate']);
    expect(col('a')[0]).toMatchObject({ onConflict: 'FAIL' });
    expect(col('a')[5]).toMatchObject({ collation: 'NOCASE' });
    const def = (n: string) => (col(n)[0] as { expr: A.Expr }).expr;
    expect(def('b')).toMatchObject({ kind: 'literal', value: -1 });
    expect(def('c')).toMatchObject({ kind: 'literal', value: 1.5, isReal: true });
    expect(sx(def('d'))).toBe('(1 + 2)');
    expect(def('e')).toMatchObject({ kind: 'call', name: 'current_timestamp' });
    expect(def('f')).toMatchObject({ kind: 'literal', value: 'abc' });
    expect(def('g')).toMatchObject({ kind: 'literal', value: null });
    expect(def('h')).toMatchObject({ kind: 'literal', value: 1 });
    expect(col('i')[0]).toMatchObject({ kind: 'references', table: 'p', columns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE', deferrable: true });
    expect(col('j')[0]).toMatchObject({ kind: 'generated', stored: true });
    expect(col('k')[0]).toMatchObject({ kind: 'generated', stored: false });
    expect(col('l')[0]).toMatchObject({ kind: 'generated', stored: false });
  });

  it('foreign key actions and deferrability', () => {
    const s = one('CREATE TABLE t (a REFERENCES p ON DELETE SET DEFAULT ON UPDATE NO ACTION NOT DEFERRABLE, b REFERENCES p ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE)') as A.CreateTableStmt;
    expect(s.columns[0].constraints[0]).toMatchObject({ table: 'p', columns: undefined, onDelete: 'SET DEFAULT', onUpdate: 'NO ACTION', deferrable: false });
    expect(s.columns[1].constraints[0]).toMatchObject({ onDelete: 'RESTRICT', deferrable: false });
  });

  it('table constraints', () => {
    const s = one(`CREATE TABLE t (a, b, c,
      CONSTRAINT pk PRIMARY KEY (a DESC, b COLLATE nocase) ON CONFLICT ROLLBACK,
      UNIQUE (b, c),
      CHECK (a > b)
      FOREIGN KEY (c) REFERENCES p (x) ON DELETE CASCADE)`) as A.CreateTableStmt;
    expect(s.constraints.map((c) => c.kind)).toEqual(['primaryKey', 'unique', 'check', 'foreignKey']);
    expect(s.constraints[0]).toMatchObject({ name: 'pk', onConflict: 'ROLLBACK' });
    const pk = s.constraints[0] as { columns: A.IndexedColumn[] };
    expect(pk.columns.map((c) => [sx(c.expr), c.desc, c.collation])).toEqual([
      ['a', true, undefined],
      ['b', false, 'NOCASE'],
    ]);
    expect(s.constraints[3]).toMatchObject({ kind: 'foreignKey', columns: ['c'], references: { table: 'p', onDelete: 'CASCADE' } });
    expect((s.constraints[3] as { references: A.ForeignKeyClause }).references.columns).toEqual(['x']); // parent columns are kept separately
  });

  it('table options and WITH storage options', () => {
    const s = one("CREATE TABLE t (a INT PRIMARY KEY) STRICT, WITHOUT ROWID, WITH (page_size = 8192, Compression = 'lz4', ratio = -0.5, flag = on)") as A.CreateTableStmt;
    expect(s.options).toEqual({ strict: true, loose: false, withoutRowid: true });
    expect(s.with).toEqual({ page_size: 8192, compression: 'lz4', ratio: -0.5, flag: 'on' });
    expect((one('CREATE TABLE t (a) LOOSE') as A.CreateTableStmt).options.loose).toBe(true);
  });

  it('CREATE TABLE AS SELECT', () => {
    const s = one('CREATE TABLE t AS SELECT 1 AS x') as A.CreateTableStmt;
    expect(s.asSelect).toBeDefined();
    expect(s.columns).toEqual([]);
  });

  it('rejects malformed definitions', () => {
    syntaxError('CREATE TABLE t ()');
    syntaxError('CREATE TABLE t (a,)');
    syntaxError('CREATE TABLE t (PRIMARY KEY (a))');
    syntaxError('CREATE TABLE t (a) STRICT,');
    syntaxError('CREATE TABLE t (a) WITHOUT x');
  });
});

describe('other DDL', () => {
  it('CREATE INDEX', () => {
    const s = one('CREATE UNIQUE INDEX IF NOT EXISTS main.ix ON t (a, lower(b) DESC, c COLLATE nocase ASC) INCLUDE (d, e) WHERE a > 0') as A.CreateIndexStmt;
    expect(s).toMatchObject({ kind: 'createIndex', unique: true, ifNotExists: true, schema: 'main', name: 'ix', table: 't', include: ['d', 'e'] });
    expect(s.columns.map((c) => [sx(c.expr), c.desc, c.collation])).toEqual([
      ['a', false, undefined],
      ['lower(b)', true, undefined],
      ['c', false, 'NOCASE'],
    ]);
    expect(sx(s.where!)).toBe('(a > 0)');
  });

  it('CREATE VIEW / MATERIALIZED VIEW', () => {
    expect(one('CREATE TEMP VIEW IF NOT EXISTS v (a, b) AS SELECT 1, 2')).toMatchObject({
      kind: 'createView',
      temp: true,
      materialized: false,
      ifNotExists: true,
      name: 'v',
      columns: ['a', 'b'],
    });
    const m = one("CREATE MATERIALIZED VIEW s.mv WITH (refresh = 'manual') AS SELECT day, sum(x) FROM t GROUP BY day") as A.CreateViewStmt;
    expect(m).toMatchObject({ materialized: true, temp: false, schema: 's', name: 'mv', with: { refresh: 'manual' } });
  });

  it('REFRESH MATERIALIZED VIEW', () => {
    expect(one('REFRESH MATERIALIZED VIEW mv')).toMatchObject({ kind: 'refresh', concurrently: false, name: 'mv' });
    expect(one('REFRESH MATERIALIZED VIEW CONCURRENTLY main.mv')).toMatchObject({ concurrently: true, schema: 'main', name: 'mv' });
    expect(one('REFRESH MATERIALIZED VIEW mv CONCURRENTLY')).toMatchObject({ concurrently: true, name: 'mv' });
  });

  it('DROP', () => {
    expect(one('DROP TABLE t')).toEqual({ kind: 'drop', pos: 0, end: 12, objectType: 'table', ifExists: false, schema: undefined, name: 't' });
    expect(one('DROP INDEX IF EXISTS main.i')).toMatchObject({ objectType: 'index', ifExists: true, schema: 'main', name: 'i' });
    expect(one('DROP VIEW v')).toMatchObject({ objectType: 'view' });
    expect(one('DROP MATERIALIZED VIEW mv')).toMatchObject({ objectType: 'materialized view' });
    expect(one('DROP TRIGGER tr')).toMatchObject({ objectType: 'trigger' });
  });

  it('ALTER TABLE', () => {
    expect((one('ALTER TABLE main.t RENAME TO u') as A.AlterTableStmt)).toMatchObject({ schema: 'main', table: 't', action: { kind: 'renameTable', newName: 'u' } });
    expect((one('ALTER TABLE t RENAME COLUMN a TO b') as A.AlterTableStmt).action).toEqual({ kind: 'renameColumn', column: 'a', newName: 'b' });
    expect((one('ALTER TABLE t RENAME a TO b') as A.AlterTableStmt).action).toEqual({ kind: 'renameColumn', column: 'a', newName: 'b' });
    const add = (one('ALTER TABLE t ADD COLUMN c TEXT NOT NULL DEFAULT \'\'') as A.AlterTableStmt).action;
    expect(add).toMatchObject({ kind: 'addColumn', column: { name: 'c', type: 'TEXT' } });
    expect((one('ALTER TABLE t ADD d') as A.AlterTableStmt).action).toMatchObject({ kind: 'addColumn', column: { name: 'd' } });
    expect((one('ALTER TABLE t DROP COLUMN c') as A.AlterTableStmt).action).toEqual({ kind: 'dropColumn', column: 'c' });
    expect((one('ALTER TABLE t DROP c') as A.AlterTableStmt).action).toEqual({ kind: 'dropColumn', column: 'c' });
  });
});

describe('transactions and utility statements', () => {
  it('BEGIN / COMMIT / ROLLBACK / SAVEPOINT / RELEASE', () => {
    expect(one('BEGIN')).toMatchObject({ kind: 'begin', pos: 0, mode: undefined });
    expect(one('BEGIN IMMEDIATE TRANSACTION')).toMatchObject({ mode: 'IMMEDIATE' });
    expect(one('begin exclusive')).toMatchObject({ mode: 'EXCLUSIVE' });
    expect(one('BEGIN DEFERRED')).toMatchObject({ mode: 'DEFERRED' });
    expect(one('COMMIT')).toMatchObject({ kind: 'commit', pos: 0 });
    expect(one('END TRANSACTION')).toMatchObject({ kind: 'commit', pos: 0 });
    expect(one('ROLLBACK')).toMatchObject({ kind: 'rollback', pos: 0, savepoint: undefined });
    expect(one('ROLLBACK TRANSACTION TO SAVEPOINT sp')).toMatchObject({ savepoint: 'sp' });
    expect(one('ROLLBACK TO sp')).toMatchObject({ savepoint: 'sp' });
    expect(one('SAVEPOINT sp')).toMatchObject({ kind: 'savepoint', pos: 0, name: 'sp' });
    expect(one('RELEASE SAVEPOINT sp')).toMatchObject({ kind: 'release', pos: 0, name: 'sp' });
    expect(one('RELEASE sp')).toMatchObject({ kind: 'release', pos: 0, name: 'sp' });
  });

  it('EXPLAIN variants', () => {
    expect(one('EXPLAIN SELECT 1')).toMatchObject({ kind: 'explain', queryPlan: false, analyze: false, stmt: { kind: 'select' } });
    expect(one('EXPLAIN QUERY PLAN SELECT 1')).toMatchObject({ queryPlan: true, analyze: false });
    expect(one('EXPLAIN ANALYZE SELECT 1')).toMatchObject({ queryPlan: false, analyze: true, stmt: { kind: 'select' } });
    expect(one('EXPLAIN ANALYZE t')).toMatchObject({ analyze: false, stmt: { kind: 'analyze', target: 't' } });
    expect(one('EXPLAIN ANALYZE')).toMatchObject({ analyze: false, stmt: { kind: 'analyze' } });
  });

  it('PRAGMA', () => {
    expect(one('PRAGMA journal_mode')).toMatchObject({ kind: 'pragma', pos: 0, schema: undefined, name: 'journal_mode', value: undefined });
    expect(one('PRAGMA main.Cache_Size = -2000')).toMatchObject({ schema: 'main', name: 'cache_size', value: { kind: 'literal', value: -2000 } });
    expect(one('PRAGMA foreign_keys = ON')).toMatchObject({ value: { kind: 'literal', value: 'ON' } });
    expect(one('PRAGMA journal_mode = wal')).toMatchObject({ value: { kind: 'literal', value: 'wal' } });
    expect(one("PRAGMA table_info('t')")).toMatchObject({ name: 'table_info', value: { kind: 'literal', value: 't' } });
    expect(one('PRAGMA table_info(t)')).toMatchObject({ value: { kind: 'literal', value: 't' } });
  });

  it('ANALYZE / VACUUM', () => {
    expect(one('ANALYZE')).toMatchObject({ kind: 'analyze', pos: 0, target: undefined });
    expect(one('ANALYZE main.t')).toMatchObject({ target: 'main.t' });
    expect(one('VACUUM')).toMatchObject({ kind: 'vacuum', pos: 0 });
  });
});

describe('scripts, spans and errors', () => {
  it('splits statements, skipping empty ones', () => {
    const sql = ';; SELECT 1 ;\n  -- comment\n INSERT INTO t VALUES (1) /* c */ ;;; DELETE FROM t ;';
    const list = parse(sql);
    expect(list.map((s) => s.stmt.kind)).toEqual(['select', 'insert', 'delete']);
    expect(list.map((s) => s.text)).toEqual(['SELECT 1', 'INSERT INTO t VALUES (1)', 'DELETE FROM t']);
    for (const s of list) expect(sql.slice(s.start, s.end)).toBe(s.text);
    expect(list[1].stmt.pos).toBe(0); // positions are relative to the statement text
    expect(parse('')).toEqual([]);
    expect(parse(' ; ;')).toEqual([]);
  });

  it('text excludes trailing comments and the semicolon', () => {
    const [s] = parse('  SELECT  a\nFROM t -- trailing\n;');
    expect(s.text).toBe('SELECT  a\nFROM t');
  });

  it('parseOne requires exactly one statement', () => {
    expect(parseOne('SELECT 1;').stmt.kind).toBe('select');
    expect(() => parseOne('SELECT 1; SELECT 2')).toThrow(/near "SELECT": syntax error/);
    expect(() => parseOne('')).toThrow(/incomplete input/);
  });

  it('reports SQLite-style messages with line and column', () => {
    let e = syntaxError('SELEC 1');
    expect(e.message).toBe('near "SELEC": syntax error (line 1, column 1)');
    expect(e.code).toBe('SMALT_SYNTAX');
    expect(e.position).toBe(0);

    e = syntaxError('SELECT *\n  FORM t');
    expect(e.message).toBe('near "FORM": syntax error (line 2, column 3)');
    expect([e.position, e.line, e.column]).toEqual([11, 2, 3]);

    e = syntaxError("SELECT 'abc");
    expect(e.message).toBe(`unrecognized token: "'abc" (line 1, column 8)`);

    e = syntaxError('SELECT (1');
    expect(e.reason).toBe('incomplete input');
    expect(e.position).toBe(9);

    expect(syntaxError('SELECT 1 2').reason).toBe('near "2": syntax error');
    expect(syntaxError('SELECT * FROM t WHERE').reason).toBe('incomplete input');
    expect(syntaxError('SELECT 1abc').reason).toBe('unrecognized token: "1abc"');
    expect(syntaxError('SELECT "abc').reason).toBe('unrecognized token: ""abc"');
    expect(syntaxError("SELECT x'123'").reason).toBe(`unrecognized token: "x'123'"`);
    expect(syntaxError('SELECT a ! b').reason).toBe('unrecognized token: "!"');
    expect(syntaxError('SELECT 1; SELEC 2').position).toBe(10);
    expect(syntaxError('CREATE TRIGGER x').reason).toBe('near "TRIGGER": syntax error');
    expect(syntaxError('SELECT CASE x END').reason).toBe('near "END": syntax error');
  });

  it('an earlier syntax error wins over a later illegal token', () => {
    expect(syntaxError("SELECT * FORM t; SELECT 'x").reason).toBe('near "FORM": syntax error');
  });

  it('parses a large script quickly', () => {
    const stmts = [
      "INSERT INTO users (id, name, email, created) VALUES (1, 'alice', 'alice@example.com', CURRENT_TIMESTAMP);",
      'SELECT u.id, u.name, count(o.id) AS n FROM users u LEFT JOIN orders o ON o.user_id = u.id WHERE u.created > ? AND u.name LIKE :pat GROUP BY u.id HAVING n > 2 ORDER BY n DESC LIMIT 10;',
      'UPDATE orders SET total = total * 1.1, status = \'repriced\' WHERE id IN (SELECT id FROM orders WHERE status = "open") RETURNING id;',
      'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, a TEXT NOT NULL DEFAULT \'\', b REAL CHECK (b >= 0), c BLOB) STRICT;',
      '-- a comment line\nDELETE FROM t WHERE a BETWEEN 1 AND 100 OR b IS NULL;',
    ];
    let script = '';
    for (let i = 0; script.length < 200_000; i++) script += stmts[i % stmts.length] + '\n';
    parse(script); // warm-up
    const t0 = performance.now();
    const list = parse(script);
    const ms = performance.now() - t0;
    expect(list.length).toBeGreaterThan(1000);
    // Lenient bound; typical throughput is far above 1 MB/s.
    expect(ms).toBeLessThan(1000);
    console.log(`parsed ${(script.length / 1024).toFixed(0)} KB in ${ms.toFixed(1)} ms (${(script.length / 1e6 / (ms / 1000)).toFixed(1)} MB/s)`);
  });
});
