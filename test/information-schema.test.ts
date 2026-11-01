import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

type Lite = { exec(s: string): void; selectArrays(s: string): unknown[][] };
let newLite: () => Lite;
beforeAll(async () => {
  const s3 = (await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Lite } }>)({ print() {}, printErr() {} }));
  newLite = () => new s3.oo1.DB(':memory:');
});

const DDL = `
  CREATE TABLE p(id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, a INT, b INT DEFAULT 7, CONSTRAINT p_ab UNIQUE(a, b));
  CREATE TABLE c(id INTEGER PRIMARY KEY, pid INT REFERENCES p(id) ON DELETE CASCADE, x INT, y INT,
    CONSTRAINT fk2 FOREIGN KEY (x, y) REFERENCES p(a, b), CONSTRAINT positive CHECK (x > 0));
  CREATE TABLE k(m TEXT COLLATE NOCASE, n INT, PRIMARY KEY (m, n));
  CREATE INDEX c_pid ON c(pid DESC, x);
  CREATE VIEW pv AS SELECT id, code AS label, a + b FROM p;
`;

function db(): Database {
  const d = Database.openFile(new MemoryVfs().openSync('i.db'));
  d.exec(DDL);
  return d;
}

describe('table-valued pragma functions', () => {
  it('match SQLite, including lateral use with sqlite_schema', () => {
    const lite = newLite();
    lite.exec(DDL);
    const d = db();
    const queries = [
      "SELECT * FROM pragma_table_info('p')",
      "SELECT name, pk FROM pragma_table_info('k') ORDER BY cid",
      "SELECT * FROM pragma_foreign_key_list('c')",
      "SELECT * FROM pragma_index_info('c_pid')",
      "SELECT * FROM pragma_index_xinfo('c_pid')",
      "SELECT * FROM pragma_table_info('nope')",
      "SELECT m.name, p.name, p.type FROM sqlite_schema m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' ORDER BY 1, p.cid",
      "SELECT m.name, count(*) FROM sqlite_schema AS m, pragma_table_info(m.name) AS p WHERE m.type = 'table' GROUP BY m.name ORDER BY 1",
      "SELECT t.name, f.\"table\", f.\"from\", f.\"to\" FROM sqlite_schema t JOIN pragma_foreign_key_list(t.name) f ORDER BY 1, f.id, f.seq",
    ];
    for (const q of queries) {
      expect(JSON.stringify(d.query(q).rows), q).toBe(JSON.stringify(lite.selectArrays(q)));
    }
  });
});

describe('information_schema', () => {
  it('tables, columns and views', () => {
    const d = db();
    expect(d.query('SELECT table_name, table_type FROM information_schema.tables ORDER BY 1').rows).toEqual([
      ['c', 'BASE TABLE'],
      ['k', 'BASE TABLE'],
      ['p', 'BASE TABLE'],
      ['pv', 'VIEW'],
    ]);
    expect(d.query("SELECT column_name, ordinal_position, data_type, is_nullable, column_default, is_identity FROM information_schema.columns WHERE table_name = 'p'").rows).toEqual([
      ['id', 1, 'INTEGER', 'NO', null, 'YES'],
      ['code', 2, 'TEXT', 'NO', null, 'NO'],
      ['a', 3, 'INT', 'YES', null, 'NO'],
      ['b', 4, 'INT', 'YES', '7', 'NO'],
    ]);
    expect(d.query("SELECT collation_name FROM information_schema.columns WHERE table_name = 'k' AND column_name = 'm'").rows).toEqual([['NOCASE']]);
    expect(d.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'pv'").rows).toEqual([
      ['id', 'INTEGER'],
      ['label', 'TEXT'],
      ['a + b', 'ANY'],
    ]);
    expect(d.query('SELECT table_name, view_definition FROM information_schema.views').rows).toEqual([['pv', 'SELECT id, code AS label, a + b FROM p']]);
    expect(d.query('SELECT schema_name FROM information_schema.schemata ORDER BY 1').rows).toEqual([['information_schema'], ['main']]);
  });

  it('constraints', () => {
    const d = db();
    expect(d.query('SELECT table_name, constraint_name, constraint_type FROM information_schema.table_constraints ORDER BY 1, 3, 2').rows).toEqual([
      ['c', 'positive', 'CHECK'],
      ['c', 'c_pid_fkey', 'FOREIGN KEY'],
      ['c', 'fk2', 'FOREIGN KEY'],
      ['c', 'c_pkey', 'PRIMARY KEY'],
      ['k', 'k_pkey', 'PRIMARY KEY'],
      ['p', 'p_pkey', 'PRIMARY KEY'],
      ['p', 'p_ab', 'UNIQUE'],
      ['p', 'p_code_key', 'UNIQUE'],
    ]);
    expect(d.query("SELECT constraint_name, column_name, ordinal_position FROM information_schema.key_column_usage WHERE table_name = 'c' ORDER BY 1, 3").rows).toEqual([
      ['c_pid_fkey', 'pid', 1],
      ['c_pkey', 'id', 1],
      ['fk2', 'x', 1],
      ['fk2', 'y', 2],
    ]);
    expect(d.query('SELECT constraint_name, unique_constraint_name, update_rule, delete_rule FROM information_schema.referential_constraints ORDER BY 1').rows).toEqual([
      ['c_pid_fkey', 'p_pkey', 'NO ACTION', 'CASCADE'],
      ['fk2', 'p_ab', 'NO ACTION', 'NO ACTION'],
    ]);
    expect(d.query('SELECT constraint_name, check_clause FROM information_schema.check_constraints').rows).toEqual([['positive', 'x > 0']]);
    expect(d.query("SELECT index_name, seq_in_index, column_name, collation, non_unique FROM information_schema.statistics WHERE table_name = 'c'").rows).toEqual([
      ['c_pid', 1, 'pid', 'D', 1],
      ['c_pid', 2, 'x', 'A', 1],
    ]);
  });

  it('routines, errors, joins with real tables', () => {
    const d = db();
    expect(d.query("SELECT routine_type FROM information_schema.routines WHERE routine_name IN ('sum', 'abs') ORDER BY routine_name").rows).toEqual([['FUNCTION'], ['AGGREGATE']]);
    expect(d.query("SELECT is_deterministic FROM information_schema.routines WHERE routine_name = 'random'").rows).toEqual([['NO']]);
    expect(() => d.query('SELECT * FROM information_schema.nope')).toThrow(/no such table: information_schema.nope/);
    expect(() => d.query('SELECT * FROM nope_fn(1)')).toThrow(/no such table-valued function/);
    expect(d.query("SELECT t.table_name, count(c.column_name) FROM information_schema.tables t LEFT JOIN information_schema.columns c ON c.table_name = t.table_name GROUP BY 1 ORDER BY 1").rows).toEqual([
      ['c', 4],
      ['k', 2],
      ['p', 4],
      ['pv', 3],
    ]);
    // Reflects schema changes in prepared statements.
    const st = d.prepare("SELECT count(*) FROM information_schema.tables WHERE table_type = 'BASE TABLE'");
    expect(st.all()).toEqual([[3]]);
    d.exec('CREATE TABLE z(q)');
    expect(st.all()).toEqual([[4]]);
  });
});
