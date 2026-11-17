/**
 * Text that starts with U+FEFF (a byte-order mark) keeps it, as in SQLite. A default TextDecoder drops a leading BOM,
 * so the engine's decoders (records, index keys, columnar segments, casts, printf) are made with `ignoreBOM: true`.
 * Found by key-codec.test.ts's property test, which generated "﻿" (CI, smaltdb#243).
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { decodeKey, encodeKey } from '../src/engine/storage/key-codec.js';

type Lite = { exec(s: string | { sql: string; bind: unknown[] }): void; selectArrays(s: string): unknown[][] };
let lite: Lite;
let db: Database;

const VALUES = ['﻿', '﻿abc', 'a﻿b', '﻿﻿'];

beforeAll(async () => {
  const s3 = await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Lite } }>)({ print() {}, printErr() {} });
  lite = new s3.oo1.DB(':memory:');
  db = Database.openMemory();
  const setup = 'CREATE TABLE t(id INTEGER PRIMARY KEY, x TEXT); CREATE INDEX tx ON t(x)';
  lite.exec(setup);
  db.exec(setup);
  db.exec("CREATE TABLE c(id INTEGER, x TEXT) WITH (storage = 'columnar')");
  VALUES.forEach((v, i) => {
    lite.exec({ sql: 'INSERT INTO t VALUES (?, ?)', bind: [i, v] });
    db.prepare('INSERT INTO t VALUES (?, ?)').run([i, v]);
    db.prepare('INSERT INTO c VALUES (?, ?)').run([i, v]);
  });
});

describe('text starting with U+FEFF', () => {
  // Lengths and hex are compared with SQLite; the text itself with the values inserted, because sqlite-wasm's own
  // JavaScript binding decodes text with a default TextDecoder and drops the BOM (SQLite keeps it: length and hex).
  it.each([
    ['a table', 'SELECT id, length(x), hex(x) FROM t ORDER BY id'],
    ['an index (covering)', "SELECT length(x), hex(x) FROM t WHERE x >= '' ORDER BY x"],
    ['a cast from a blob', "SELECT length(CAST(X'EFBBBF61' AS TEXT)), hex(CAST(X'EFBBBF' AS TEXT))"],
    ['printf', "SELECT length(printf('%s', x)) FROM t ORDER BY id"],
  ])('keeps it when read from %s, as SQLite does', (_where, q) => {
    expect(db.query(q).rows).toEqual(lite.selectArrays(q));
  });

  it('gives the text back as it was inserted, from the table and from the index', () => {
    expect(db.query('SELECT x FROM t ORDER BY id').rows).toEqual(VALUES.map((v) => [v]));
    expect(db.query("SELECT x FROM t WHERE x >= '' ORDER BY x").rows.map((r) => r[0]).sort()).toEqual([...VALUES].sort());
  });

  it('keeps it in columnar tables', () => {
    expect(db.query('SELECT x FROM c ORDER BY id').rows).toEqual(VALUES.map((v) => [v]));
  });

  it('keeps it through the index-key codec', () => {
    for (const desc of [false, true]) expect(decodeKey(encodeKey(VALUES, VALUES.map(() => ({ desc }))), VALUES.map(() => ({ desc })))).toEqual(VALUES);
  });
});
