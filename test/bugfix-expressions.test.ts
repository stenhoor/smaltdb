/**
 * Regression tests for the expression, function and conflict-handling bugs found while writing
 * the user documentation. Each case is checked against SQLite (the official WASM build) where the
 * two can be compared, and against the exact expected value.
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { EngineServer } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { columnValue } from '../src/shared/protocol.js';
import { until } from './helpers/wait.js';

type Sqlite = { exec(sql: string): void; selectArrays(sql: string): unknown[][]; close(): void };
let sqlite3: { oo1: { DB: new (name: string) => Sqlite } };

beforeAll(async () => {
  sqlite3 = (await (sqliteInit as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} })) as never;
});

/** A value in a form both engines agree on: integers and REALs by value, text, blobs as hex. */
function canon(v: unknown): unknown {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : `${v}n`;
  if (v instanceof Uint8Array) return 'x' + Buffer.from(v).toString('hex');
  return v ?? null;
}

/** Result rows, or the error message. */
function outcome(f: () => unknown[][]): unknown {
  try {
    return f().map((r) => r.map(canon));
  } catch (e) {
    return { error: String((e as Error).message).replace(/^SQLITE_\w+: sqlite3 result code \d+: /, '') };
  }
}

/** Both engines, fresh, running the same statements; `check` compares one statement's outcome. */
function pair(setup = '') {
  const lite = new sqlite3.oo1.DB(':memory:');
  const smalt = Database.openFile(new MemoryVfs().openSync('t.db'));
  if (setup) {
    lite.exec(setup);
    smalt.exec(setup);
  }
  // Several statements (`;`) run as a script and yield no rows.
  const run = (sql: string): { sqlite: unknown; smalt: unknown } =>
    sql.includes(';')
      ? { sqlite: outcome(() => (lite.exec(sql), [])), smalt: outcome(() => (smalt.exec(sql), [])) }
      : { sqlite: outcome(() => lite.selectArrays(sql)), smalt: outcome(() => smalt.query(sql).rows) };
  /** Run `sql` on both; the outcomes must agree and equal `want` (rows, or { error }). */
  const check = (sql: string, want: unknown): void => {
    const r = run(sql);
    expect(r.smalt, sql).toEqual(want);
    expect(r.sqlite, `${sql} (SQLite)`).toEqual(want);
  };
  /** Run `sql` on both; the outcomes must agree. */
  const same = (sql: string): void => {
    const r = run(sql);
    expect(r.smalt, sql).toEqual(r.sqlite);
  };
  return { lite, smalt, check, same, run };
}

const err = (message: string) => ({ error: message });

describe('constant folding does not raise errors from branches that never run', () => {
  it('CASE, ifnull, coalesce, iif, AND, OR', () => {
    const t = pair();
    const big = 'abs(-9223372036854775808)';
    t.check(`SELECT CASE WHEN 1 THEN 1 ELSE ${big} END`, [[1]]);
    t.check(`SELECT CASE 1 WHEN 1 THEN 1 ELSE ${big} END`, [[1]]);
    t.check(`SELECT CASE WHEN 0 THEN ${big} ELSE 2 END`, [[2]]);
    t.check(`SELECT ifnull(1, ${big})`, [[1]]);
    t.check(`SELECT coalesce(1, ${big})`, [[1]]);
    t.check(`SELECT iif(1, 1, ${big})`, [[1]]);
    t.check(`SELECT iif(0, ${big}, 3)`, [[3]]);
    t.check(`SELECT 0 AND ${big}`, [[0]]);
    t.check(`SELECT 1 OR ${big}`, [[1]]);
    t.check(`SELECT 1 IN (1, ${big})`, [[1]]);
    // A branch that runs still raises.
    t.check(`SELECT CASE WHEN 1 THEN ${big} ELSE 2 END`, err('integer overflow'));
    t.check(`SELECT coalesce(NULL, ${big})`, err('integer overflow'));
    t.check(`SELECT 1 AND ${big}`, err('integer overflow'));
    t.check(`SELECT ${big}`, err('integer overflow'));
  });

  it('x AND 0 and x OR 1 do not evaluate x when the constant is a plain integer literal or TRUE/FALSE', () => {
    const t = pair('CREATE TABLE m(a); INSERT INTO m VALUES (-9223372036854775808)');
    t.check('SELECT abs(-9223372036854775808) AND 0', [[0]]);
    t.check('SELECT abs(-9223372036854775808) OR 1', [[1]]);
    t.check('SELECT abs(a) AND 0, abs(a) OR 2147483647, abs(a) AND FALSE, abs(a) OR TRUE, abs(a) AND (0), abs(a) OR 0x10 FROM m', [[0, 1, 0, 1, 0, 1]]);
    t.check('SELECT 1 FROM m WHERE abs(a) OR 1', [[1]]);
    t.check('SELECT 1 FROM m WHERE NOT (abs(a) AND 0)', [[1]]);
    // Not plain integer literals: evaluated.
    for (const k of ['0.0', '-0', '+0', '(1-1)', "'0'", '2147483648']) t.check(`SELECT abs(a) AND ${k === '2147483648' ? '0 OR abs(a) OR ' + k : k} FROM m`, err('integer overflow'));
  });

  it('a prepared statement raises only on the executions that take the branch', () => {
    const d = Database.openMemory();
    const s = d.prepare('SELECT CASE WHEN ? THEN 1 ELSE abs(-9223372036854775808) END');
    expect(s.all([1])).toEqual([[1]]);
    expect(() => s.all([0])).toThrow('integer overflow');
  });
});

describe('sign()', () => {
  it('converts numeric-looking text like SQLite', () => {
    const t = pair();
    t.check("SELECT sign('3'), sign('-2.5'), sign('abc'), sign(''), sign(' 3'), sign('3x'), sign(x'01'), sign(NULL)", [[1, -1, null, null, 1, null, null, null]]);
    t.check("SELECT sign('3 '), sign(' -0 '), sign('0x10'), sign('1e3'), sign('+5'), sign('.5'), sign('5.'), sign('inf'), sign('1e999'), sign('-1e999')", [[1, 0, null, 1, 1, 1, 1, null, 1, -1]]);
  });
});

describe('printf() / format()', () => {
  it('the reported cases', () => {
    const t = pair();
    t.check("SELECT printf('%g', 1000000), printf('%G', 1e20), printf('%u', -5), printf('%y', 1), printf('a%yb'), printf('%5')", [['1e+06', '1E+20', '18446744073709551611', '', 'a', '']]);
  });

  it('matches SQLite over a table of conversions, flags, widths, precisions and arguments', () => {
    const t = pair();
    const specs = ['%d', '%i', '%u', '%x', '%X', '%o', '%e', '%E', '%f', '%g', '%G', '%c', '%s', '%z', '%q', '%Q', '%w', '%%', '%r', '%p', '%n', '%5d', '%-5d|', '%05d', '%+d', '% d', '%,d', '%.3d', '%#x', '%#o', '%08.3f', '%-8.2e|', '%+.2g', '%#g', '%.0f', '%#.0f', '%10s|', '%.2s', '%!.3f', '%!g', '%!.20g', '%.20g', '%.30f', '%,.2f', '%-5c|', '%.3c', '%5.3c|', '%10.3q|', '%.2Q', '%#q', '%#Q', '%7s|', '%!7s|', '%.1!s', '%lld', '%hd', '%5%|', '%!.17g', '%!.16e', '%#.3e'];
    const args = ['0', '1', '-5', '255', '3.14159', '-2.5', '1000000', '1e20', '1e-5', '9223372036854775807', '-9223372036854775808', '0.1', '1e300', '-0.0', "'abc'", "'12x'", "'it''s'", "'é'", 'NULL', "x'4142'", '12.0', '49.47', '2.675', '0.5', '1e308*10', "char(1, 92)"];
    for (const spec of specs) t.same(`SELECT ${args.map((a) => `printf('${spec}', ${a})`).join(', ')}`);
    t.same("SELECT printf('%*.*g|', 10, 3, 3.14159), printf('%-*s|', 6, 'ab'), printf('%.*s|', -3, 'abcdef'), printf('%*d|', -7, 5), printf('%d %d', 1), printf('%s'), printf('abc%')");
    t.same('SELECT printf(), format(), printf(NULL, 1), printf(12.5), format(12.0)');
  });

  it('REAL to text uses %!.17g, as in SQLite 3.54', () => {
    const t = pair('CREATE TABLE r(x REAL); INSERT INTO r VALUES (1.0/3), (1e15), (1e16), (1e17), (5e-324), (0.1), (100.0), (49.47)');
    t.check("SELECT CAST(x AS TEXT), x || '' FROM r ORDER BY rowid", [
      ['0.33333333333333332', '0.33333333333333332'],
      ['1000000000000000.0', '1000000000000000.0'],
      ['10000000000000000.0', '10000000000000000.0'],
      ['1.0e+17', '1.0e+17'],
      ['4.9406564584124654e-324', '4.9406564584124654e-324'],
      ['0.1', '0.1'],
      ['100.0', '100.0'],
      ['49.47', '49.47'],
    ]);
  });
});

describe('char()', () => {
  it('NULL is U+0000 and out-of-range values are U+FFFD', () => {
    const t = pair();
    t.check("SELECT hex(char(72, NULL, 105)), hex(char(-1)), hex(char(1114112)), hex(char(1114111)), hex(char('65')), hex(char(65.7)), hex(char('1e2')), hex(char(x'3637')), hex(char(9223372036854775807)), hex(char(4294967361))", [
      ['480069', 'EFBFBD', 'EFBFBD', 'F48FBFBF', '41', '41', '01', '43', 'EFBFBD', 'EFBFBD'],
    ]);
  });
});

describe('text functions convert a REAL argument as SQLite does', () => {
  it('REAL literals', () => {
    const t = pair();
    t.check("SELECT trim(12.0, '1'), ltrim(12.0, '1'), rtrim(12.0, '0'), trim(-0.0)", [['2.0', '2.0', '12.', '0.0']]);
    t.check("SELECT substr(12.0, 1), substr(12.0, 2, 2), substring(12.0, -2), instr(12.0, '.0'), instr('a12.0', 12.0)", [['12.0', '2.', '.0', 3, 2]]);
    t.check("SELECT concat_ws(1.0, 'a', 'b'), printf(12.0), printf('%q|%Q|%w', 12.0, 12.0, 12.0)", [['a1.0b', '12.0', "12.0|'12.0'|12.0"]]);
    t.check("SELECT 'a' LIKE 'a' ESCAPE 1.0", err('ESCAPE expression must be a single character'));
    t.check("SELECT '12.0' LIKE 12.0, '12.0' GLOB 12.0", [[1, 1]]);
    t.check("SELECT group_concat(x, 1.0), string_agg(x, 0.0) FROM (SELECT 'a' AS x UNION ALL SELECT 'b')", [['a1.0b', 'a0.0b']]);
  });

  it('REAL columns, subquery columns, and REAL results', () => {
    const t = pair('CREATE TABLE r(x REAL); INSERT INTO r VALUES (12)');
    t.check("SELECT rtrim(x, '0'), trim(x, '1'), substr(x, 3), instr(x, '.'), printf('%q', x) FROM r", [['12.', '2.0', '.0', 3, '12.0']]);
    t.check("SELECT rtrim(x, '0') FROM (SELECT 12.0 AS x UNION ALL SELECT 13.0)", [['12.'], ['13.']]);
    t.check("SELECT rtrim(coalesce(NULL, 12.0), '0'), rtrim(+12.0, '0'), rtrim(-12.0, '0'), rtrim(12.0 * 1, '0'), rtrim(abs(12.0), '0'), rtrim(round(12.4), '0')", [['12.', '12.', '-12.', '12.', '12.', '12.']]);
  });
});

describe('iif / if, likelihood, ntile', () => {
  it('iif() with two arguments, more pairs, and the if() alias (SQLite 3.48+)', () => {
    const t = pair();
    t.check("SELECT iif(1, 2), iif(0, 2), typeof(iif(0, 2)), iif(0, 1, 0, 2), iif(0, 1, 1, 2), iif(0, 1, 0, 2, 3), iif(1, 'a', 1, 'b', 'c')", [[2, null, 'null', null, 2, 3, 'a']]);
    t.check("SELECT if(1, 2, 3), if(0, 2), IF(1, 'x')", [[2, null, 'x']]);
    t.check('SELECT iif(1)', err('wrong number of arguments to function iif()'));
    t.check('SELECT if(1)', err('wrong number of arguments to function if()'));
  });

  it('likelihood() needs a REAL literal between 0.0 and 1.0', () => {
    const t = pair();
    t.check('SELECT likelihood(3, 0.5), likelihood(3, 1.0), likelihood(3, 0.0), likelihood(3, 1e0), likelihood(3, .5)', [[3, 3, 3, 3, 3]]);
    for (const p of ['2', '1', '-0.0', '1.5', "'a'", 'NULL', '0.5 + 0.1']) {
      t.check(`SELECT likelihood(3, ${p})`, err('second argument to likelihood() must be a constant between 0.0 and 1.0'));
    }
  });

  it('ntile() converts its argument like sqlite3_value_int64()', () => {
    const t = pair('CREATE TABLE n(x); INSERT INTO n VALUES (1), (2), (3)');
    t.check("SELECT ntile('2') OVER (ORDER BY x), ntile(2.7) OVER (ORDER BY x), ntile('2x') OVER (ORDER BY x), ntile(' 2 ') OVER (ORDER BY x), ntile(x'32') OVER (ORDER BY x) FROM n", [
      [1, 1, 1, 1, 1],
      [1, 1, 1, 1, 1],
      [2, 2, 2, 2, 2],
    ]);
    for (const a of ["'a'", '0', '-1', 'NULL', '0.5']) t.check(`SELECT ntile(${a}) OVER (ORDER BY x) FROM n`, err('argument of ntile must be a positive integer'));
  });
});

describe('window and aggregate misuse messages', () => {
  it('match SQLite', () => {
    const t = pair('CREATE TABLE t(a, b)');
    for (const f of ['row_number()', 'rank()', 'dense_rank()', 'percent_rank()', 'cume_dist()', 'ntile(2)', 'lag(a)', 'lead(a)', 'first_value(a)', 'last_value(a)', 'nth_value(a, 1)']) {
      const name = f.slice(0, f.indexOf('('));
      t.check(`SELECT ${f} FROM t`, err(`misuse of window function ${name}()`));
    }
    t.check('SELECT a FROM t ORDER BY row_number()', err('misuse of window function row_number()'));
    t.check('SELECT row_number(1) FROM t', err('wrong number of arguments to function row_number()'));
    t.check('SELECT lag() FROM t', err('wrong number of arguments to function lag()'));
    t.check('SELECT sum(rank() OVER ()) OVER () FROM t', err('misuse of window function rank()'));
    t.check('SELECT sum(1 + lag(a) OVER ()) OVER () FROM t', err('misuse of window function lag()'));
    t.check('SELECT max(sum(a)) FROM t', err('misuse of aggregate function sum()'));
    t.check('SELECT abs(1) OVER () FROM t', err('abs() may not be used as a window function'));
  });
});

describe('date and time functions in index expressions and CHECK constraints', () => {
  it('are allowed, and fail at run time when they read the clock or the time zone', () => {
    const t = pair("CREATE TABLE d(x, y); INSERT INTO d VALUES ('2024-01-15', 1), ('now', 2)");
    t.check('CREATE INDEX di ON d(date(x))', err('non-deterministic use of date() in an index'));
    t.check('DELETE FROM d WHERE y = 2', []);
    t.check('CREATE INDEX di ON d(date(x))', []);
    t.check("INSERT INTO d VALUES ('2024-02-01', 3)", []);
    for (const v of ['now', 'NOW', 'subsec', 'subsecond']) t.check(`INSERT INTO d VALUES ('${v}', 4)`, err('non-deterministic use of date() in an index'));
    t.check("INSERT INTO d VALUES (' now', 4)", []); // not 'now': an invalid date, NULL
    t.check("UPDATE d SET x = 'now' WHERE y = 3", err('non-deterministic use of date() in an index'));
    t.check("SELECT x FROM d WHERE date(x) = '2024-02-01'", [['2024-02-01']]);
    t.check('CREATE INDEX di2 ON d(datetime(x, y))', []);
    t.check("INSERT INTO d VALUES ('2024-03-01', '+1 day'), ('2024-03-01', 'subsec')", []);
    for (const m of ['utc', 'localtime']) t.check(`INSERT INTO d VALUES ('2024-03-01', '${m}')`, err('non-deterministic use of datetime() in an index'));
    t.check("CREATE INDEX di3 ON d(datetime(x, 'localtime'))", err('non-deterministic use of datetime() in an index'));
    t.check('CREATE INDEX di4 ON d(date())', err('non-deterministic use of date() in an index'));
    t.check("CREATE INDEX di5 ON d(strftime('%Y', x), julianday(x), unixepoch(x), time(x), timediff(x, '2020-01-01'))", []);
    t.check("CREATE INDEX di6 ON d(timediff(x, 'now'))", err('non-deterministic use of timediff() in an index'));
    t.check("CREATE INDEX di7 ON d(x) WHERE date(x) > '2000-01-01'", []);
    t.check("CREATE INDEX di8 ON d(x) WHERE date('now') > '2000-01-01'", err('non-deterministic use of date() in an index'));
    t.check('CREATE INDEX di9 ON d(current_date)', err('non-deterministic functions prohibited in index expressions'));
    t.check('CREATE INDEX di10 ON d(random())', err('non-deterministic functions prohibited in index expressions'));
    t.check('SELECT count(*) FROM d', [[5]]);

    t.check('CREATE TABLE c(x CHECK (date(x) IS NOT NULL))', []);
    t.check("INSERT INTO c VALUES ('2024-01-01')", []);
    t.check("INSERT INTO c VALUES ('now')", err('non-deterministic use of date() in a CHECK constraint'));
    t.check("INSERT INTO c VALUES ('nonsense')", err('CHECK constraint failed: date(x) IS NOT NULL'));
    t.check("CREATE TABLE c2(x CHECK (x < date('now')))", []);
    t.check("INSERT INTO c2 VALUES ('2000-01-01')", err('non-deterministic use of date() in a CHECK constraint'));
    // DEFAULT is not restricted.
    t.check("CREATE TABLE c3(x DEFAULT (date('now')))", []);
    t.check('INSERT INTO c3 DEFAULT VALUES', []);
  });

  it("still re-reads 'now' on each execution (not folded)", async () => {
    const d = Database.openMemory();
    const s = d.prepare("SELECT unixepoch('now', 'subsec')");
    const first = s.all()[0][0];
    let later = first;
    await until('the clock to move', () => {
      later = s.all()[0][0];
      return later !== first;
    });
    expect(later).toBeGreaterThan(first as number);
  });

  it('an index on a date expression survives reopening', () => {
    const vfs = new MemoryVfs();
    let d = Database.openFile(vfs.openSync('i.db'), {}, vfs.openSync('i.db-wal'));
    d.exec("CREATE TABLE d(x); CREATE INDEX di ON d(date(x)); INSERT INTO d VALUES ('2024-01-15 10:00')");
    d.close();
    d = Database.openFile(vfs.openSync('i.db'), {}, vfs.openSync('i.db-wal'));
    expect(d.query("SELECT x FROM d WHERE date(x) = '2024-01-15'").rows).toEqual([['2024-01-15 10:00']]);
    expect(() => d.exec("INSERT INTO d VALUES ('now')")).toThrow('non-deterministic use of date() in an index');
  });
});

describe('OR ROLLBACK', () => {
  it('rolls back the whole transaction on a constraint failure', () => {
    const t = pair("CREATE TABLE r(a UNIQUE, b); INSERT INTO r VALUES (1, 'x'); CREATE TABLE rc(a CHECK (a > 0))");
    t.check('BEGIN', []);
    t.check("INSERT INTO r VALUES (2, 'y')", []);
    t.check("INSERT OR ROLLBACK INTO r VALUES (1, 'z')", err('UNIQUE constraint failed: r.a'));
    t.check('SELECT * FROM r ORDER BY a', [[1, 'x']]);
    t.check('COMMIT', err('cannot commit - no transaction is active'));
    expect(t.smalt.inTransaction).toBe(false);
    t.check('BEGIN', []);
    t.check("INSERT INTO r VALUES (3, 'y')", []);
    t.check('UPDATE OR ROLLBACK r SET a = 1 WHERE a = 3', err('UNIQUE constraint failed: r.a'));
    t.check('SELECT * FROM r ORDER BY a', [[1, 'x']]);
    t.check('SAVEPOINT s1', []);
    t.check('INSERT INTO rc VALUES (6)', []);
    t.check('INSERT OR ROLLBACK INTO rc VALUES (-1)', err('CHECK constraint failed: a > 0'));
    t.check('SELECT count(*) FROM rc', [[0]]);
    t.check('RELEASE s1', err('no such savepoint: s1'));
    // In autocommit mode it is the same as ABORT.
    t.check('INSERT OR ROLLBACK INTO rc VALUES (-1)', err('CHECK constraint failed: a > 0'));
    // Other actions leave the transaction open.
    t.check('BEGIN', []);
    t.check('INSERT INTO rc VALUES (9)', []);
    t.check("INSERT OR ABORT INTO r VALUES (1, 'w')", err('UNIQUE constraint failed: r.a'));
    t.check('COMMIT', []);
    t.check('SELECT count(*) FROM rc', [[1]]);
  });

  it('the server sees the transaction end: other sessions are not kept waiting', async () => {
    const log: { session: string; msg: Response }[] = [];
    const server = new EngineServer((session, msg) => log.push({ session, msg }), { open: () => Database.openMemory(), watchSession: () => {} });
    let id = 1;
    const send = (session: string, body: Record<string, unknown>): number => {
      const rid = id++;
      server.receive(session, { ...body, id: rid } as Request);
      return rid;
    };
    const of = (session: string, rid: number) => log.filter((m) => m.session === session && m.msg.id === rid).map((m) => m.msg);
    const done = (session: string, rid: number) => of(session, rid).some((m) => m.kind === 'ok' || m.kind === 'done' || m.kind === 'error');
    send(EngineServer.LOCAL, { op: 'open', name: ':memory:', storage: 'memory' });
    send('local', { op: 'exec', sql: 'CREATE TABLE t(a UNIQUE); INSERT INTO t VALUES (1)' });
    send('tab-a', { op: 'exec', sql: 'BEGIN; INSERT INTO t VALUES (2)' });
    const bad = send('tab-a', { op: 'exec', sql: 'INSERT OR ROLLBACK INTO t VALUES (1)' });
    await until('the failing insert', () => done('tab-a', bad));
    expect(of('tab-a', bad)[0]).toMatchObject({ kind: 'error', code: 'SMALT_CONSTRAINT_UNIQUE' });
    expect(server.db!.inTransaction).toBe(false);
    const read = send('tab-b', { op: 'query', sql: 'SELECT count(*) FROM t' });
    await until("tab-b's read", () => done('tab-b', read));
    const rows: unknown[][] = [];
    for (const m of of('tab-b', read)) if (m.kind === 'batch') for (let i = 0; i < m.length; i++) rows.push(m.cols.map((c) => columnValue(c, i)));
    expect(rows).toEqual([[1]]);
    const commit = send('tab-a', { op: 'exec', sql: 'COMMIT' });
    await until('COMMIT', () => done('tab-a', commit));
    expect(of('tab-a', commit)[0]).toMatchObject({ kind: 'error', message: 'cannot commit - no transaction is active' });
  });
});

describe('ON CONFLICT on column and table constraints', () => {
  it('is the default resolution for UNIQUE, PRIMARY KEY and NOT NULL', () => {
    const t = pair();
    t.check('CREATE TABLE u1(a UNIQUE ON CONFLICT IGNORE, b)', []);
    t.check("INSERT INTO u1 VALUES (1, 'x'), (1, 'y')", []);
    t.check("INSERT OR ABORT INTO u1 VALUES (1, 'z')", err('UNIQUE constraint failed: u1.a'));
    t.check("INSERT OR REPLACE INTO u1 VALUES (1, 'r')", []);
    t.check("INSERT INTO u1 VALUES (2, 'two')", []);
    t.check('UPDATE u1 SET a = 1 WHERE a = 2', []);
    t.check('SELECT * FROM u1 ORDER BY a', [
      [1, 'r'],
      [2, 'two'],
    ]);
    t.check("CREATE TABLE u2(a UNIQUE ON CONFLICT REPLACE, b); INSERT INTO u2 VALUES (1, 'x'), (1, 'y')", []);
    t.check('SELECT * FROM u2', [[1, 'y']]);
    t.check("CREATE TABLE p1(id INTEGER PRIMARY KEY ON CONFLICT IGNORE, v); INSERT INTO p1 VALUES (1, 'a'), (1, 'b')", []);
    t.check('SELECT * FROM p1', [[1, 'a']]);
    t.check("CREATE TABLE p2(id INTEGER PRIMARY KEY ON CONFLICT REPLACE, v); INSERT INTO p2 VALUES (1, 'a'), (1, 'b')", []);
    t.check('SELECT * FROM p2', [[1, 'b']]);
    t.check("CREATE TABLE p3(k TEXT PRIMARY KEY ON CONFLICT REPLACE, v); INSERT INTO p3 VALUES ('k', 'a'), ('k', 'b')", []);
    t.check('SELECT * FROM p3', [['k', 'b']]);
    t.check('CREATE TABLE p4(a, b, PRIMARY KEY (a, b) ON CONFLICT IGNORE); INSERT INTO p4 VALUES (1, 2), (1, 2), (1, 3)', []);
    t.check('SELECT * FROM p4', [
      [1, 2],
      [1, 3],
    ]);
    t.check('CREATE TABLE n1(a NOT NULL ON CONFLICT IGNORE, b); INSERT INTO n1 VALUES (NULL, 1), (2, 2)', []);
    t.check('UPDATE n1 SET a = NULL', []);
    t.check('SELECT * FROM n1', [[2, 2]]);
    t.check('CREATE TABLE n2(a NOT NULL ON CONFLICT REPLACE DEFAULT 7, b); INSERT INTO n2 VALUES (NULL, 1)', []);
    t.check('SELECT * FROM n2', [[7, 1]]);
    t.check('CREATE TABLE n3(a NOT NULL ON CONFLICT REPLACE, b)', []);
    t.check('INSERT INTO n3 VALUES (NULL, 1)', err('NOT NULL constraint failed: n3.a'));
    // The last NOT NULL clause decides.
    t.check('CREATE TABLE n4(a NOT NULL ON CONFLICT IGNORE NOT NULL ON CONFLICT ABORT)', []);
    t.check('INSERT INTO n4 VALUES (NULL)', err('NOT NULL constraint failed: n4.a'));
    // ON CONFLICT ROLLBACK on a constraint ends the transaction.
    t.check('CREATE TABLE rk(a UNIQUE ON CONFLICT ROLLBACK)', []);
    t.check('BEGIN; INSERT INTO rk VALUES (1)', []);
    t.check('INSERT INTO rk VALUES (1)', err('UNIQUE constraint failed: rk.a'));
    t.check('SELECT count(*) FROM rk', [[0]]);
    // An upsert takes precedence over the constraint's action.
    t.check("CREATE TABLE ups(a UNIQUE ON CONFLICT IGNORE, b); INSERT INTO ups VALUES (1, 1); INSERT INTO ups VALUES (1, 2) ON CONFLICT (a) DO UPDATE SET b = 9", []);
    t.check('SELECT * FROM ups', [[1, 9]]);
  });

  it('constraints are checked in SQLite order: rowid, then indexes newest first, REPLACE ones last', () => {
    const t = pair();
    t.check('CREATE TABLE m(a UNIQUE, b UNIQUE); INSERT INTO m VALUES (1, 1)', []);
    t.check('INSERT INTO m VALUES (1, 1)', err('UNIQUE constraint failed: m.b'));
    t.check('CREATE TABLE mx(a UNIQUE ON CONFLICT IGNORE, b UNIQUE); INSERT INTO mx VALUES (1, 1)', []);
    t.check('INSERT INTO mx VALUES (1, 1)', err('UNIQUE constraint failed: mx.b'));
    t.check('INSERT INTO mx VALUES (1, 2)', []);
    t.check('CREATE TABLE my(a UNIQUE, b UNIQUE ON CONFLICT IGNORE); INSERT INTO my VALUES (1, 1), (1, 1)', []);
    t.check('CREATE TABLE mz(a UNIQUE ON CONFLICT REPLACE, b UNIQUE); INSERT INTO mz VALUES (1, 1), (2, 2)', []);
    t.check('INSERT INTO mz VALUES (1, 2)', err('UNIQUE constraint failed: mz.b'));
    t.check('CREATE TABLE mr(a UNIQUE ON CONFLICT REPLACE, b UNIQUE ON CONFLICT IGNORE); INSERT INTO mr VALUES (1, 1), (2, 2), (1, 2)', []);
    t.check('SELECT * FROM mr ORDER BY a', [
      [1, 1],
      [2, 2],
    ]);
    t.check('CREATE TABLE ip(id INTEGER PRIMARY KEY ON CONFLICT REPLACE, b UNIQUE ON CONFLICT IGNORE); INSERT INTO ip VALUES (1, 1), (2, 2), (1, 2)', []);
    t.check('SELECT * FROM ip ORDER BY id', [
      [1, 1],
      [2, 2],
    ]);
    t.check('CREATE TABLE d12(a INTEGER PRIMARY KEY ON CONFLICT IGNORE, b UNIQUE); INSERT INTO d12 VALUES (1, 1), (1, 1)', []);
    t.check('INSERT INTO d12 VALUES (2, 1)', err('UNIQUE constraint failed: d12.b'));
  });

  it('identical constraints share their action; different actions are an error', () => {
    const t = pair();
    t.check('CREATE TABLE d4(a UNIQUE ON CONFLICT IGNORE, UNIQUE(a) ON CONFLICT REPLACE)', err('conflicting ON CONFLICT clauses specified'));
    t.check('CREATE TABLE d8(a PRIMARY KEY ON CONFLICT IGNORE, UNIQUE(a) ON CONFLICT REPLACE)', err('conflicting ON CONFLICT clauses specified'));
    t.check('CREATE TABLE d5(a UNIQUE ON CONFLICT IGNORE, UNIQUE(a)); INSERT INTO d5 VALUES (1), (1)', []);
    t.check('CREATE TABLE d6(a UNIQUE, UNIQUE(a) ON CONFLICT IGNORE); INSERT INTO d6 VALUES (1), (1)', []);
    t.check('SELECT (SELECT count(*) FROM d5), (SELECT count(*) FROM d6)', [[1, 1]]);
    // A table CHECK accepts (and ignores) an ON CONFLICT clause.
    t.check('CREATE TABLE ck(a, CHECK (a > 0) ON CONFLICT IGNORE)', []);
    t.check('INSERT INTO ck VALUES (-1)', err('CHECK constraint failed: a > 0'));
  });

  it('the actions come from the stored CREATE TABLE, so they survive reopening', () => {
    const vfs = new MemoryVfs();
    let d = Database.openFile(vfs.openSync('c.db'), {}, vfs.openSync('c.db-wal'));
    d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY ON CONFLICT REPLACE, a UNIQUE ON CONFLICT IGNORE, b NOT NULL ON CONFLICT IGNORE)');
    d.close();
    d = Database.openFile(vfs.openSync('c.db'), {}, vfs.openSync('c.db-wal'));
    d.exec("INSERT INTO t VALUES (1, 'a', 'x'), (2, 'a', 'y'), (3, 'c', NULL), (1, 'd', 'z')");
    expect(d.query('SELECT * FROM t ORDER BY id').rows).toEqual([[1, 'd', 'z']]);
  });
});
