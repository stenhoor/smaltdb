import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { exportCSV, exportJSON, importCSV, importJSON } from '../src/engine/io/import-export.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const db = (): Database => Database.openFile(new MemoryVfs().openSync('io.db'));

describe('CSV import', () => {
  it('parses RFC 4180 (quotes, embedded delimiters/newlines, CRLF, BOM) into a typed table', () => {
    const d = db();
    d.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, score REAL, note TEXT DEFAULT 'n/a')");
    const csv = '﻿id,name,score\r\n1,"Smith, Ann",9.5\r\n2,"say ""hi""",\r\n3,"multi\nline",7\n\n4,,1e2\n';
    expect(importCSV(d, 't', csv)).toEqual({ rows: 4 });
    expect(d.query('SELECT * FROM t ORDER BY id').rows).toEqual([
      [1, 'Smith, Ann', 9.5, 'n/a'],
      [2, 'say "hi"', null, 'n/a'],
      [3, 'multi\nline', 7, 'n/a'],
      [4, null, 100, 'n/a'],
    ]);
    // Quoted "" is an empty string, unquoted empty is NULL (unless emptyAsNull: false).
    importCSV(d, 't', 'id,name\n5,""\n6,\n');
    importCSV(d, 't', 'id,name\n7,\n', { emptyAsNull: false });
    expect(d.query('SELECT id, name FROM t WHERE id >= 5 ORDER BY id').rows).toEqual([
      [5, ''],
      [6, null],
      [7, ''],
    ]);
  });

  it('creates tables with inferred types, supports delimiters and headerless input', () => {
    const d = db();
    importCSV(d, 'm', 'a;b;c;d\n1;2.5;x;\n-3;4;y;\n9007199254740993;1e3;z;\n', { delimiter: ';', create: true });
    expect(d.query("SELECT sql FROM sqlite_schema WHERE name = 'm'").rows).toEqual([['CREATE TABLE "m"("a" INTEGER, "b" REAL, "c" TEXT, "d" TEXT)']]);
    expect(d.query('SELECT a, typeof(a), b, c, d FROM m ORDER BY rowid').rows).toEqual([
      [1, 'integer', 2.5, 'x', null],
      [-3, 'integer', 4, 'y', null],
      [9007199254740993n, 'integer', 1000, 'z', null],
    ]);
    importCSV(d, 'm', '5,6,w,v\n', { header: false });
    expect(d.query('SELECT * FROM m WHERE a = 5').rows).toEqual([[5, 6, 'w', 'v']]);
  });

  it('reports the failing line and rolls the whole import back', () => {
    const d = db();
    d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v INT NOT NULL)');
    expect(() => importCSV(d, 't', 'id,v\n1,10\n2,\n3,30\n')).toThrow(/CSV line 3: NOT NULL constraint failed: t.v/);
    expect(() => importCSV(d, 't', 'id,v\n1,10\n2,abc\n')).toThrow(/CSV line 3: cannot store TEXT value in INTEGER column t.v/);
    expect(() => importCSV(d, 't', 'id,v\n1,10,99\n')).toThrow(/CSV line 2: expected 2 fields but found 3/);
    expect(() => importCSV(d, 't', 'id,v\n1,"10\n')).toThrow(/CSV line 2: unterminated quoted field/);
    expect(() => importCSV(d, 't', 'id,nope\n1,2\n')).toThrow(/table t has no column named nope/);
    expect(() => importCSV(d, 'missing', 'a\n1\n')).toThrow(/no such table: missing/);
    expect(d.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
    // Inside an explicit transaction the caller decides.
    d.exec('BEGIN');
    importCSV(d, 't', 'id,v\n1,10\n');
    d.exec('ROLLBACK');
    expect(d.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });
});

describe('JSON import', () => {
  it('arrays of objects (missing keys take defaults), arrays of arrays, NDJSON, nested values', () => {
    const d = db();
    d.exec("CREATE TABLE e(id INTEGER PRIMARY KEY, kind TEXT DEFAULT 'misc', ok INT, meta ANY)");
    expect(importJSON(d, 'e', '[{"id":1,"kind":"a","ok":true,"meta":{"x":[1,2]}},{"ID":2,"ok":false},{"id":3,"meta":null}]')).toEqual({ rows: 3 });
    expect(importJSON(d, 'e', '[[4,"b",1,5],[5,"c",0,"s"]]')).toEqual({ rows: 2 });
    expect(importJSON(d, 'e', '{"id":6,"kind":"n"}\n\n{"id":7}\r\n')).toEqual({ rows: 2 });
    expect(d.query('SELECT * FROM e ORDER BY id').rows).toEqual([
      [1, 'a', 1, '{"x":[1,2]}'],
      [2, 'misc', 0, null],
      [3, 'misc', null, null],
      [4, 'b', 1, 5],
      [5, 'c', 0, 's'],
      [6, 'n', null, null],
      [7, 'misc', null, null],
    ]);
    expect(() => importJSON(d, 'e', '{"id":8}\n{bad}\n')).toThrow(/NDJSON line 2/);
    expect(() => importJSON(d, 'e', '[{"id":1}]')).toThrow(/JSON item 1: UNIQUE constraint failed: e.id/);
    importJSON(d, 'auto', '[{"n":1,"s":"x","r":1.5},{"n":2,"s":"y","r":2}]', { create: true });
    expect(d.query("SELECT sql FROM sqlite_schema WHERE name = 'auto'").rows).toEqual([['CREATE TABLE "auto"("n" INTEGER, "s" TEXT, "r" REAL)']]);
  });
});

describe('export', () => {
  it('CSV and JSON, round-tripping through import', () => {
    const d = db();
    d.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT, r REAL, b BLOB, big INT); INSERT INTO t VALUES (1, 'a,b', 0.1, x'0aff', 9007199254740993), (2, 'q\"uote', NULL, NULL, -5), (3, ' pad ', 2.0, NULL, NULL), (4, 'multi\nline', 1e300, NULL, 0)");
    const csv = exportCSV(d, 'SELECT id, s, r, b, big FROM t ORDER BY id');
    expect(csv).toBe('id,s,r,b,big\n1,"a,b",0.1,0AFF,9007199254740993\n2,"q""uote",,,-5\n3," pad ",2.0,,\n4,"multi\nline",1.0e+300,,0\n');
    expect(exportCSV(d, 'SELECT id, r FROM t WHERE id < ?', [3], { header: false, delimiter: '\t', nullString: 'NULL', crlf: true })).toBe('1\t0.1\r\n2\tNULL\r\n');
    const json = exportJSON(d, 'SELECT id, s, r, big FROM t ORDER BY id');
    expect(json).toBe('[{"id":1,"s":"a,b","r":0.1,"big":9007199254740993},{"id":2,"s":"q\\"uote","r":null,"big":-5},{"id":3,"s":" pad ","r":2.0,"big":null},{"id":4,"s":"multi\\nline","r":1.0e+300,"big":0}]');
    expect(exportJSON(d, 'SELECT id FROM t WHERE id > :min', { min: 2 }, { format: 'ndjson' })).toBe('{"id":3}\n{"id":4}\n');
    expect(exportJSON(d, 'SELECT id FROM t WHERE 0')).toBe('[]');
    // Round trip.
    const d2 = db();
    d2.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT, r REAL, big INT)');
    importCSV(d2, 't', exportCSV(d, 'SELECT id, s, r, big FROM t'));
    expect(d2.query('SELECT * FROM t ORDER BY id').rows).toEqual(d.query('SELECT id, s, r, big FROM t ORDER BY id').rows);
    const d3 = db();
    importJSON(d3, 'copy', exportJSON(d, 'SELECT id, s FROM t'), { create: true });
    expect(d3.query('SELECT * FROM copy ORDER BY id').rows).toEqual(d.query('SELECT id, s FROM t ORDER BY id').rows);
  });
});
