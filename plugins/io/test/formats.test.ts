/**
 * The csv, tsv and json formats and read_csv / read_json. Files come from a tiny in-test source
 * (`mem:` locations served from a Map), so these tests do not depend on @smaltdb/external.
 */
import { describe, expect, it } from 'vitest';
import io from '@smaltdb/io';
import { exportCSV, exportJSON } from '@smaltdb/io/client';
import { Database } from '../../../src/engine/database.js';
import type { SmaltPlugin } from '../../../src/engine/plugin.js';
import { MemoryVfs } from '../../../src/engine/vfs/memory.js';

/** A source plugin serving `mem:<name>` from `files` (validator: a version bumped on each change). */
function memSource(files: Map<string, string | Uint8Array>): SmaltPlugin {
  const file = (location: string): string | Uint8Array => {
    const f = files.get(location.slice('mem:'.length));
    if (f === undefined) throw new Error(`no such file '${location}'`);
    return f;
  };
  return {
    name: 'mem',
    version: '0',
    apiVersion: 1,
    setup(host) {
      host.addSource({
        name: 'mem',
        prefixes: ['mem:'],
        async open(target) {
          const f = file(target.location);
          return { bytes: async () => ({ bytes: typeof f === 'string' ? new TextEncoder().encode(f) : f, validator: String(f.length) }) };
        },
        async validator(target) {
          return String(file(target.location).length);
        },
      });
    },
  };
}

async function setup(entries: Record<string, string | Uint8Array> = {}): Promise<{ db: Database; files: Map<string, string | Uint8Array> }> {
  const files = new Map(Object.entries(entries));
  const db = await Database.open(new MemoryVfs(), 'db', { plugins: [memSource(files), io] });
  return { db, files };
}

const errorOf = async (p: Promise<unknown> | (() => unknown)): Promise<{ code: string; message: string }> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
  throw new Error('expected an error');
};

describe('CSV reader', () => {
  it('infers columns and types, keeps quoted text, empty fields are NULL', async () => {
    const { db } = await setup({ p: 'id,name,price,code\n1,apple,1.5,007\n2,"pear, ""green""",2,010\n3,,,\n' });
    const r = await db.queryAsync("SELECT * FROM read_csv('mem:p')");
    expect(r.columns).toEqual(['id', 'name', 'price', 'code']);
    expect(r.rows).toEqual([
      [1, 'apple', 1.5, 7],
      [2, 'pear, "green"', 2, 10],
      [3, null, null, null],
    ]);
    expect((await db.queryAsync("SELECT typeof(price), typeof(name) FROM read_csv('mem:p') WHERE id = 2")).rows).toEqual([['real', 'text']]);
  });

  it('honors header, delimiter, quote, null, skip and tsv', async () => {
    const { db } = await setup({
      semi: "# exported 2026\n'a;b';2;NA\nc;3;x\n",
      't.tsv': 'k\tv\nx\t1\n',
      dup: 'a,a,\n1,2,3\n',
      tabs: 'k\tv\nz\t3\n',
    });
    expect((await db.queryAsync("SELECT * FROM read_csv('mem:semi', header => false, delimiter => ';', quote => '''', null => 'NA', skip => 1)")).rows).toEqual([
      ['a;b', 2, null],
      ['c', 3, 'x'],
    ]);
    expect(await db.queryAsync("SELECT * FROM read_csv('mem:t.tsv')")).toEqual({ columns: ['k', 'v'], rows: [['x', 1]] });
    expect(await db.queryAsync("SELECT * FROM read_csv('mem:tabs', format => 'tsv')")).toEqual({ columns: ['k', 'v'], rows: [['z', 3]] });
    expect((await db.queryAsync("SELECT * FROM read_csv('mem:dup')")).columns).toEqual(['a', 'a_2', 'column3']);
  });

  it('reports malformed input with the source and line', async () => {
    const { db } = await setup({ bad: 'a,b\n1,2\n3\n', open: 'a\n"x\n' });
    expect(await errorOf(db.queryAsync("SELECT * FROM read_csv('mem:bad')"))).toEqual({ code: 'SMALT_EXTERNAL', message: "read_csv('mem:bad'): CSV line 3: expected 2 fields but found 1" });
    expect(await errorOf(db.queryAsync("SELECT * FROM read_csv('mem:open')"))).toEqual({ code: 'SMALT_EXTERNAL', message: "read_csv('mem:open'): CSV line 2: unterminated quoted field" });
    expect((await errorOf(db.queryAsync("SELECT * FROM read_csv('mem:bad', delim => ';')"))).message).toMatch(/unknown option 'delim'/);
    expect((await errorOf(db.queryAsync("SELECT * FROM read_csv('mem:bad', delimiter => ';;')"))).message).toBe("read_csv('mem:bad'): delimiter and quote must be single characters");
    expect((await errorOf(db.queryAsync("SELECT * FROM read_csv('mem:bad', skip => -1)"))).message).toBe("read_csv('mem:bad'): skip must be a non-negative integer");
    expect((await errorOf(db.queryAsync("SELECT * FROM read_csv('mem:bad', encoding => 'klingon')"))).message).toBe("read_csv('mem:bad'): unsupported encoding 'klingon'");
  });

  it('decodes the encoding option', async () => {
    const { db } = await setup({ latin: new Uint8Array([0x6e, 0x0a, 0xe9, 0x0a]) });
    expect((await db.queryAsync("SELECT n FROM read_csv('mem:latin', encoding => 'latin1')")).rows).toEqual([['é']]);
    expect((await db.queryAsync("SELECT n FROM read_csv('mem:latin')")).rows).toEqual([['�']]);
  });
});

describe('JSON reader', () => {
  it('reads arrays of objects and NDJSON, typing columns', async () => {
    const { db } = await setup({
      'a.json': '[{"id":1,"tags":["x"],"ok":true},{"id":2.5,"name":"b","ok":false}]',
      b: '{"k":"a","v":1}\n\n{"k":"b","v":2}\n',
      'c.json': '[[1,"x"],[2]]',
      'bad.json': '[1, {"a": 2}]',
      'broken.ndjson': '{"a":1}\n{oops}\n',
    });
    expect(await db.queryAsync("SELECT * FROM read_json('mem:a.json')")).toEqual({
      columns: ['id', 'tags', 'ok', 'name'],
      rows: [
        [1, '["x"]', 1, null],
        [2.5, null, 0, 'b'],
      ],
    });
    expect((await db.queryAsync("SELECT sum(v) FROM read_json('mem:b', format => 'ndjson')")).rows).toEqual([[3]]);
    expect((await db.queryAsync("SELECT sum(v) FROM read_json('mem:b', format => 'jsonl')")).rows).toEqual([[3]]);
    expect(await db.queryAsync("SELECT * FROM read_json('mem:c.json')")).toEqual({
      columns: ['column1', 'column2'],
      rows: [
        [1, 'x'],
        [2, null],
      ],
    });
    expect((await errorOf(db.queryAsync("SELECT * FROM read_json('mem:bad.json')"))).message).toMatch(/objects or arrays/);
    expect((await errorOf(db.queryAsync("SELECT * FROM read_json('mem:broken.ndjson')"))).message).toMatch(/^read_json\('mem:broken.ndjson'\): NDJSON line 2: /);
  });
});

describe('external tables', () => {
  it('pick the format by extension or format option; declared columns convert by type', async () => {
    const { db } = await setup({
      'a.csv': 'v,k\n10,1\n20,2\n',
      'notes.txt': 'n\n5\n',
      'p.json': '[{"id":"7","x":"1.5"}]',
      'arr.jsonl': '[[1,"2"]]',
      plain: 'a\n1\n',
    });
    // Declared columns match the header by name, in any order.
    await db.execAsync("CREATE EXTERNAL TABLE a (k INTEGER, v TEXT) WITH (location = 'mem:a.csv')");
    expect((await db.queryAsync('SELECT k, v, typeof(v) FROM a ORDER BY k')).rows).toEqual([
      [1, '10', 'text'],
      [2, '20', 'text'],
    ]);
    // `.txt` files are CSV.
    await db.execAsync("CREATE EXTERNAL TABLE t WITH (location = 'mem:notes.txt')");
    expect((await db.queryAsync('SELECT n FROM t')).rows).toEqual([[5]]);
    await db.execAsync("CREATE EXTERNAL TABLE p (id INTEGER, x REAL) WITH (location = 'mem:p.json')");
    expect((await db.queryAsync('SELECT id, x FROM p')).rows).toEqual([[7, 1.5]]);
    await db.execAsync("CREATE EXTERNAL TABLE arr (a INTEGER, b INTEGER) WITH (location = 'mem:arr.jsonl')");
    expect((await db.queryAsync('SELECT a, b FROM arr')).rows).toEqual([[1, 2]]);
    await db.execAsync("CREATE EXTERNAL TABLE pl (a INTEGER) WITH (location = 'mem:plain', format = 'CSV')");
    expect((await db.queryAsync('SELECT a FROM pl')).rows).toEqual([[1]]);
    // A header that does not name the declared columns must have as many fields.
    await db.execAsync("CREATE EXTERNAL TABLE w (x INTEGER, y INTEGER) WITH (location = 'mem:plain', format = 'csv')");
    expect((await errorOf(db.queryAsync('SELECT * FROM w'))).message).toBe('w: the header has 1 fields but 2 columns are declared');
    // `txt` is an extension, not a format name.
    expect((await errorOf(() => db.exec("CREATE EXTERNAL TABLE x (a INT) WITH (location = 'mem:plain', format = 'txt')"))).message).toMatch(/format/);
  });

  it('export over external data', async () => {
    const { db } = await setup({ f: 'a,b\n1,2.5\n2,x\n' });
    expect(await exportCSV(db, "SELECT * FROM read_csv('mem:f', format => 'csv') ORDER BY a")).toBe('a,b\n1,2.5\n2,x\n');
    expect(await exportJSON(db, "SELECT a FROM read_csv('mem:f') ORDER BY a")).toBe('[{"a":1},{"a":2}]');
  });
});
