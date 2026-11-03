/**
 * CSV / JSON import and export (@smaltdb/io methods), in-process and through the worker protocol.
 */
import { afterEach, describe, expect, it } from 'vitest';
import io from '@smaltdb/io';
import { exportCSV, exportJSON, importCSV, importJSON } from '@smaltdb/io/client';
import * as client from '../../../src/client/index.js';
import { Database } from '../../../src/engine/database.js';
import { EngineServer } from '../../../src/engine/server.js';
import { MemoryVfs } from '../../../src/engine/vfs/memory.js';
import type { Request, Response } from '../../../src/shared/protocol.js';
import { until } from '../../../test/helpers/wait.js';

const db = (): Database => Database.openFile(new MemoryVfs().openSync('io.db'), { plugins: [io] });

describe('CSV import', () => {
  it('parses RFC 4180 (quotes, embedded delimiters/newlines, CRLF, BOM) into a typed table', async () => {
    const d = db();
    d.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, score REAL, note TEXT DEFAULT 'n/a')");
    const csv = '﻿id,name,score\r\n1,"Smith, Ann",9.5\r\n2,"say ""hi""",\r\n3,"multi\nline",7\n\n4,,1e2\n';
    expect(await importCSV(d, 't', csv)).toEqual({ rows: 4 });
    expect(d.query('SELECT * FROM t ORDER BY id').rows).toEqual([
      [1, 'Smith, Ann', 9.5, 'n/a'],
      [2, 'say "hi"', null, 'n/a'],
      [3, 'multi\nline', 7, 'n/a'],
      [4, null, 100, 'n/a'],
    ]);
    // Quoted "" is an empty string, unquoted empty is NULL (unless emptyAsNull: false).
    await importCSV(d, 't', 'id,name\n5,""\n6,\n');
    await importCSV(d, 't', 'id,name\n7,\n', { emptyAsNull: false });
    expect(d.query('SELECT id, name FROM t WHERE id >= 5 ORDER BY id').rows).toEqual([
      [5, ''],
      [6, null],
      [7, ''],
    ]);
  });

  it('creates tables with inferred types, supports delimiters and headerless input', async () => {
    const d = db();
    await importCSV(d, 'm', 'a;b;c;d\n1;2.5;x;\n-3;4;y;\n9007199254740993;1e3;z;\n', { delimiter: ';', create: true });
    expect(d.query("SELECT sql FROM sqlite_schema WHERE name = 'm'").rows).toEqual([['CREATE TABLE "m"("a" INTEGER, "b" REAL, "c" TEXT, "d" TEXT)']]);
    expect(d.query('SELECT a, typeof(a), b, c, d FROM m ORDER BY rowid').rows).toEqual([
      [1, 'integer', 2.5, 'x', null],
      [-3, 'integer', 4, 'y', null],
      [9007199254740993n, 'integer', 1000, 'z', null],
    ]);
    await importCSV(d, 'm', '5,6,w,v\n', { header: false });
    expect(d.query('SELECT * FROM m WHERE a = 5').rows).toEqual([[5, 6, 'w', 'v']]);
  });

  it('reports the failing line and rolls the whole import back', async () => {
    const d = db();
    d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v INT NOT NULL)');
    await expect(importCSV(d, 't', 'id,v\n1,10\n2,\n3,30\n')).rejects.toThrow(/CSV line 3: NOT NULL constraint failed: t.v/);
    await expect(importCSV(d, 't', 'id,v\n1,10\n2,abc\n')).rejects.toThrow(/CSV line 3: cannot store TEXT value in INTEGER column t.v/);
    await expect(importCSV(d, 't', 'id,v\n1,10,99\n')).rejects.toThrow(/CSV line 2: expected 2 fields but found 3/);
    await expect(importCSV(d, 't', 'id,v\n1,"10\n')).rejects.toThrow(/CSV line 2: unterminated quoted field/);
    await expect(importCSV(d, 't', 'id,nope\n1,2\n')).rejects.toThrow(/table t has no column named nope/);
    await expect(importCSV(d, 'missing', 'a\n1\n')).rejects.toThrow(/no such table: missing/);
    await expect(importCSV(d, 't', 'a\n1\n', { delimiter: '||' })).rejects.toMatchObject({ code: 'SMALT_RANGE', message: 'CSV delimiter and quote must be single characters' });
    expect(d.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
    // Inside an explicit transaction the caller decides.
    d.exec('BEGIN');
    await importCSV(d, 't', 'id,v\n1,10\n');
    d.exec('ROLLBACK');
    expect(d.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });

  it('accepts bytes, ArrayBuffers and Blobs (UTF-8)', async () => {
    const d = db();
    const bytes = new TextEncoder().encode('﻿k,v\nä,1\n');
    expect(await importCSV(d, 'a', bytes, { create: true })).toEqual({ rows: 1 });
    expect(await importCSV(d, 'a', bytes.slice().buffer)).toEqual({ rows: 1 });
    expect(await importCSV(d, 'a', new Blob(['k,v\nö,2\n']))).toEqual({ rows: 1 });
    expect(d.query('SELECT k, v FROM a ORDER BY rowid').rows).toEqual([
      ['ä', 1],
      ['ä', 1],
      ['ö', 2],
    ]);
  });
});

describe('JSON import', () => {
  it('arrays of objects (missing keys take defaults), arrays of arrays, NDJSON, nested values', async () => {
    const d = db();
    d.exec("CREATE TABLE e(id INTEGER PRIMARY KEY, kind TEXT DEFAULT 'misc', ok INT, meta ANY)");
    expect(await importJSON(d, 'e', '[{"id":1,"kind":"a","ok":true,"meta":{"x":[1,2]}},{"ID":2,"ok":false},{"id":3,"meta":null}]')).toEqual({ rows: 3 });
    expect(await importJSON(d, 'e', '[[4,"b",1,5],[5,"c",0,"s"]]')).toEqual({ rows: 2 });
    expect(await importJSON(d, 'e', '{"id":6,"kind":"n"}\n\n{"id":7}\r\n')).toEqual({ rows: 2 });
    expect(d.query('SELECT * FROM e ORDER BY id').rows).toEqual([
      [1, 'a', 1, '{"x":[1,2]}'],
      [2, 'misc', 0, null],
      [3, 'misc', null, null],
      [4, 'b', 1, 5],
      [5, 'c', 0, 's'],
      [6, 'n', null, null],
      [7, 'misc', null, null],
    ]);
    await expect(importJSON(d, 'e', '{"id":8}\n{bad}\n')).rejects.toThrow(/NDJSON line 2/);
    await expect(importJSON(d, 'e', '[{"id":1}]')).rejects.toThrow(/JSON item 1: UNIQUE constraint failed: e.id/);
    await importJSON(d, 'auto', '[{"n":1,"s":"x","r":1.5},{"n":2,"s":"y","r":2}]', { create: true });
    expect(d.query("SELECT sql FROM sqlite_schema WHERE name = 'auto'").rows).toEqual([['CREATE TABLE "auto"("n" INTEGER, "s" TEXT, "r" REAL)']]);
  });

  it('says which item is wrong', async () => {
    const d = (): Database => Database.openMemory({ plugins: [io] });
    await expect(importJSON(d(), 'v', '[1, 2]', { create: true })).rejects.toThrow('JSON item 1: expected an object or an array, found a number (JSON import expects an array of objects or of arrays, or NDJSON lines of either)');
    await expect(importJSON(d(), 'v', '[{"a": 1}, "x"]', { create: true })).rejects.toThrow('JSON item 2: expected an object or an array, found a string');
    await expect(importJSON(d(), 'v', '[{"a": 1}, {"a": 2}, [3]]', { create: true })).rejects.toThrow('JSON item 3: expected an object like JSON item 1, found an array (all items must be objects or all arrays)');
    await expect(importJSON(d(), 'v', '{"a": 1}\n[1]\n')).rejects.toThrow('NDJSON line 2: expected an object like NDJSON line 1, found an array');
  });
});

describe('a failed import', () => {
  const tables = (db: Database): unknown[][] => db.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").rows;
  // An integer column (inferred from 1) cannot store text beyond 64 bits: the second row fails after
  // the table was created.
  const BAD_JSON = '[{"x": 1}, {"x": "12345678901234567890"}]';
  const BAD_CSV = 'x\n1\n12345678901234567890\n';

  it('with create: true leaves no table behind (engine)', async () => {
    const e = Database.openMemory({ plugins: [io] });
    e.exec('CREATE TABLE keep(a)');
    await expect(importJSON(e, 'j', BAD_JSON, { create: true })).rejects.toThrow('JSON item 2: cannot store TEXT value in INTEGER column j.x');
    await expect(importCSV(e, 'c', BAD_CSV, { create: true })).rejects.toThrow('CSV line 3: cannot store TEXT value in INTEGER column c.x');
    expect(tables(e)).toEqual([['keep']]);
    // Inside an open transaction: the import's table and rows go; the transaction stays open with its work.
    e.exec('BEGIN; INSERT INTO keep VALUES (1)');
    await expect(importJSON(e, 'j', BAD_JSON, { create: true })).rejects.toThrow(/^JSON item 2/);
    await expect(importCSV(e, 'c', BAD_CSV, { create: true })).rejects.toThrow(/^CSV line 3/);
    await expect(importJSON(e, 'keep', '[{"a": 2}, {"a": 3}, {"b": 4}]')).rejects.toThrow(/no column named b/);
    await expect(importCSV(e, 'keep', 'a\n5\n6\n"7\n')).rejects.toThrow(/unterminated/);
    expect(e.inTransaction).toBe(true);
    e.exec('COMMIT');
    expect(tables(e)).toEqual([['keep']]);
    expect(e.query('SELECT a FROM keep').rows).toEqual([[1]]);
  });

  it('inside an open transaction keeps none of its rows', async () => {
    const e = Database.openMemory({ plugins: [io] });
    e.exec('CREATE TABLE t(a INTEGER NOT NULL)');
    e.exec('BEGIN');
    await expect(importJSON(e, 't', '[[1], [2], [null]]')).rejects.toThrow(/^JSON item 3: /);
    e.exec('COMMIT');
    expect(e.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });

  it('with create: true leaves no table behind (client)', async () => {
    const c = await openClient();
    await expect(importJSON(c, 'j', BAD_JSON, { create: true })).rejects.toMatchObject({ code: 'SMALT_CONSTRAINT_DATATYPE' });
    await expect(importCSV(c, 'c', BAD_CSV, { create: true })).rejects.toMatchObject({ code: 'SMALT_CONSTRAINT_DATATYPE' });
    expect(await c.query("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")).toEqual([{ n: 0 }]);
  });
});

describe('JSON integers', () => {
  it('beyond 2^53 keep their exact value; beyond 64 bits they are REAL, as in SQLite', async () => {
    const e = Database.openMemory({ plugins: [io] });
    await importJSON(e, 'w', '[{"x": 1234567890123456789, "y": "12345678901234567890", "z": 9007199254740993}, {"x": -9223372036854775808, "y": "a", "z": 1}]', { create: true });
    expect(e.query('SELECT x, typeof(x), y, z FROM w ORDER BY rowid').rows).toEqual([
      [1234567890123456789n, 'integer', '12345678901234567890', 9007199254740993n],
      [-9223372036854775808n, 'integer', 'a', 1],
    ]);
    await importJSON(e, 'r', '[[12345678901234567890, 1.5e300], [1, 2]]', { create: true, columns: ['a', 'b'] });
    expect(e.query('SELECT typeof(a), a, typeof(b) FROM r ORDER BY rowid').rows).toEqual([
      ['real', 12345678901234567890, 'real'],
      ['real', 1, 'real'],
    ]);
    await importJSON(e, 'n', '{"id": 18014398509481985, "doc": {"big": 18014398509481985, "s": "\\u00e9\\"", "__proto__": 1}}\n{"id": 2, "doc": [true, null]}\n', { create: true });
    expect(e.query('SELECT id, doc FROM n ORDER BY rowid').rows).toEqual([
      [18014398509481985n, '{"big":18014398509481985,"s":"é\\"","__proto__":1}'],
      [2, '[true,null]'],
    ]);
    // Invalid JSON is still reported by JSON.parse.
    await expect(importJSON(e, 'n', '[{"id": 12345678901234567890,}]')).rejects.toThrow(/^invalid JSON: /);
    const c = await openClient();
    await importJSON(c, 'w', '[{"x": 1234567890123456789}]', { create: true });
    expect(await c.query('SELECT x FROM w')).toEqual([{ x: 1234567890123456789n }]);
  });
});

describe('export', () => {
  it('CSV and JSON, round-tripping through import', async () => {
    const d = db();
    d.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT, r REAL, b BLOB, big INT); INSERT INTO t VALUES (1, 'a,b', 0.1, x'0aff', 9007199254740993), (2, 'q\"uote', NULL, NULL, -5), (3, ' pad ', 2.0, NULL, NULL), (4, 'multi\nline', 1e300, NULL, 0)");
    const csv = await exportCSV(d, 'SELECT id, s, r, b, big FROM t ORDER BY id');
    expect(csv).toBe('id,s,r,b,big\n1,"a,b",0.1,0AFF,9007199254740993\n2,"q""uote",,,-5\n3," pad ",2.0,,\n4,"multi\nline",1.0e+300,,0\n');
    expect(await exportCSV(d, 'SELECT id, r FROM t WHERE id < ?', [3], { header: false, delimiter: '\t', nullString: 'NULL', crlf: true })).toBe('1\t0.1\r\n2\tNULL\r\n');
    const json = await exportJSON(d, 'SELECT id, s, r, big FROM t ORDER BY id');
    expect(json).toBe('[{"id":1,"s":"a,b","r":0.1,"big":9007199254740993},{"id":2,"s":"q\\"uote","r":null,"big":-5},{"id":3,"s":" pad ","r":2.0,"big":null},{"id":4,"s":"multi\\nline","r":1.0e+300,"big":0}]');
    expect(await exportJSON(d, 'SELECT id FROM t WHERE id > :min', { min: 2 }, { format: 'ndjson' })).toBe('{"id":3}\n{"id":4}\n');
    expect(await exportJSON(d, 'SELECT id FROM t WHERE 0')).toBe('[]');
    // Round trip.
    const d2 = db();
    d2.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT, r REAL, big INT)');
    await importCSV(d2, 't', await exportCSV(d, 'SELECT id, s, r, big FROM t'));
    expect(d2.query('SELECT * FROM t ORDER BY id').rows).toEqual(d.query('SELECT id, s, r, big FROM t ORDER BY id').rows);
    const d3 = db();
    await importJSON(d3, 'copy', await exportJSON(d, 'SELECT id, s FROM t'), { create: true });
    expect(d3.query('SELECT * FROM copy ORDER BY id').rows).toEqual(d.query('SELECT id, s FROM t ORDER BY id').rows);
  });

  it('through the client, with db.callPlugin', async () => {
    const c = await openClient();
    expect(await importCSV(c, 'people', new Blob(['id,name,age\n1,"Lee, A",31\n2,Kim,\n']), { create: true })).toEqual({ rows: 2 });
    expect(await exportCSV(c, 'SELECT id, name FROM people WHERE id > ?', [1])).toBe('id,name\n2,Kim\n');
    expect(await c.callPlugin('@smaltdb/io', 'exportJSON', ['SELECT age * 1.0 AS a FROM people ORDER BY id', null, { format: 'ndjson' }])).toBe('{"a":31.0}\n{"a":null}\n');
  });

  it('without the plugin: SMALT_PLUGIN_MISSING', async () => {
    const d = Database.openMemory();
    await expect(exportCSV(d, 'SELECT 1')).rejects.toMatchObject({ code: 'SMALT_PLUGIN_MISSING' });
  });
});

// ------------------------------------------------------------------ client through a fake worker

/** A Worker stand-in: the engine server (with @smaltdb/io) runs in this thread, messages are cloned and delivered on later ticks. */
class FakeWorker {
  onmessage: ((e: { data: Response }) => void) | null = null;
  onerror: unknown = null;
  private readonly server = new EngineServer((_session, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), {
    open: () => Database.openMemory({ plugins: [io] }),
    refreshTimer: false,
  });
  postMessage(req: Request): void {
    const r = structuredClone(req);
    setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
  }
  terminate(): void {}
}

(globalThis as { Worker?: unknown }).Worker ??= FakeWorker;

const opened: client.Database[] = [];
async function openClient(): Promise<client.Database> {
  const c = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
  opened.push(c);
  return c;
}
afterEach(async () => {
  for (const c of opened.splice(0)) await c.close();
});

describe('review of #38', () => {
  it('7. errors: through the client a SmaltdbError with the code; in-process, check e.code', async () => {
    const c = await openClient();
    await c.exec('CREATE TABLE p(id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    const bad = await importCSV(c, 'p', 'id,v\n1\n').catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(client.SmaltdbError);
    expect(bad).toMatchObject({ code: 'SMALT_ERROR', message: 'CSV line 2: expected 2 fields but found 1' });
    const constraint = await importCSV(c, 'p', 'id,v\n1,\n').catch((e: unknown) => e);
    expect(constraint).toBeInstanceOf(client.SmaltdbError);
    expect(constraint).toMatchObject({ code: 'SMALT_CONSTRAINT_NOTNULL', message: 'CSV line 2: NOT NULL constraint failed: p.v' });
    // In-process the plugin's own errors carry the code (they are not SmaltErrors: plugins cannot make one).
    const d = db();
    d.exec('CREATE TABLE p(id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
    await expect(importCSV(d, 'p', 'id,v\n1\n')).rejects.toMatchObject({ code: 'SMALT_ERROR' });
    await expect(importCSV(d, 'p', 'id,v\n1,\n')).rejects.toMatchObject({ code: 'SMALT_CONSTRAINT_NOTNULL' });
  });

  it("an import whose tab closes while its source is read does not commit on its own after the tab's rollback", async () => {
    const log: { session: string; msg: Response }[] = [];
    const server = new EngineServer((session, msg) => log.push({ session, msg }), { open: () => Database.openMemory({ plugins: [io] }), refreshTimer: false });
    let id = 1;
    const reply = (session: string, rid: number): Response | undefined => log.find((m) => m.session === session && m.msg.id === rid && (m.msg.kind === 'ok' || m.msg.kind === 'error'))?.msg;
    const call = async (session: string, body: Record<string, unknown>): Promise<number> => {
      const rid = id++;
      server.receive(session, { ...body, id: rid } as Request);
      return rid;
    };
    const done = async (session: string, rid: number): Promise<Response> => {
      await until(`request ${rid}`, () => !!reply(session, rid));
      return reply(session, rid)!;
    };
    await done('local', await call('local', { op: 'open', name: ':memory:', storage: 'memory' }));
    await done('local', await call('local', { op: 'exec', sql: 'CREATE TABLE t(a INT)' }));
    expect(await done('tab-b', await call('tab-b', { op: 'exec', sql: 'BEGIN; INSERT INTO t VALUES (0)' }))).toMatchObject({ kind: 'ok' });
    // A Blob whose read the test controls.
    let deliver!: (b: ArrayBuffer) => void;
    let reading = false;
    const blob = {
      arrayBuffer: () => {
        reading = true;
        return new Promise<ArrayBuffer>((r) => (deliver = r));
      },
    };
    const imp = await call('tab-b', { op: 'pluginCall', plugin: '@smaltdb/io', method: 'importCSV', args: ['t', blob, {}] });
    await until('the source read', () => reading);
    server.sessionGone('tab-b'); // rolls back tab-b's transaction
    deliver(new TextEncoder().encode('a\n1\n2\n').buffer as ArrayBuffer);
    expect(await done('tab-b', imp)).toMatchObject({ kind: 'error', code: 'SMALT_INTERRUPT' });
    expect(server.db!.inTransaction).toBe(false);
    expect(server.db!.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });

  it('in-process: an import into a transaction that ends while its source is read fails instead of committing on its own', async () => {
    const d = db();
    d.exec('CREATE TABLE t(a INT); BEGIN; INSERT INTO t VALUES (0)');
    let deliver!: (b: ArrayBuffer) => void;
    const blob = { arrayBuffer: () => new Promise<ArrayBuffer>((r) => (deliver = r)) };
    const imp = d.callPlugin('@smaltdb/io', 'importCSV', ['t', blob, {}]);
    await until('the source read', () => deliver !== undefined);
    d.exec('ROLLBACK');
    deliver(new TextEncoder().encode('a\n1\n2\n').buffer as ArrayBuffer);
    await expect(imp).rejects.toMatchObject({ code: 'SMALT_INTERRUPT' });
    expect(d.inTransaction).toBe(false);
    expect(d.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });
});
