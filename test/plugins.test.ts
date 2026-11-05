/**
 * The plugin interface (ADR 0012), tested with a plugin defined here: core ships no plugins and
 * depends on none. Formats, sources, patterns and partitions, connection types, methods, questions
 * to client sessions, and an engine without a plugin a database or statement needs (it opens, and
 * reports SMALT_PLUGIN_MISSING where the plugin is needed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as client from '../src/client/index.js';
import { Database } from '../src/engine/database.js';
import type { SmaltPlugin } from '../src/engine/plugin.js';
import { EngineServer } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { pause, until } from './helpers/wait.js';

const code = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code ?? String(e),
  );

/**
 * A test plugin: `mem:` files (a Map, listed for patterns), a `lines` format (one value per line,
 * column `line`), `read_lines()`, a `mem` connection type, and methods to put files and to ask the
 * calling session a question.
 */
function testPlugin(log: string[] = []): SmaltPlugin {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    apiVersion: 1,
    setup(host) {
      const files = new Map<string, string>();
      const sessions = new Set<string>();
      host.addFormat({
        name: 'lines',
        aliases: ['ln'],
        extensions: ['lines'],
        options: ['upper'],
        access: 'bytes',
        async read(bytes, req) {
          const text = new TextDecoder().decode(bytes);
          if (text.startsWith('!')) throw new Error('bad file');
          const values = text.split('\n').filter((l) => l !== '');
          return { columns: [{ name: 'line', declType: 'TEXT' }], rows: req.schemaOnly ? [] : values.map((v) => [req.options.upper ? v.toUpperCase() : v]) };
        },
      });
      host.addTableFunction('read_lines', { format: 'lines' });
      host.addSource({
        name: 'memory',
        prefixes: ['mem:'],
        connectionTypes: ['mem'],
        async open(target) {
          const name = target.location.replace(/^mem:/, '');
          const text = files.get(name);
          if (text === undefined) throw new Error(`no file ${name}`);
          log.push(`open ${name}`);
          return { bytes: async () => ({ bytes: new TextEncoder().encode(text), validator: `v${text.length}` }) };
        },
        async validator(target) {
          const text = files.get(target.location.replace(/^mem:/, ''));
          return text === undefined ? null : `v${text.length}`;
        },
        async list(target) {
          const pattern = target.location.replace(/^mem:/, '');
          const re = host.glob.regExp(pattern);
          return [...files.keys()]
            .filter((n) => re.test(n))
            .sort()
            .map((n) => ({ location: `mem:${n}`, path: n }));
        },
      });
      host.addConnectionType('mem', {
        options: ['root'],
        aliases: ['memory'],
        validate(o) {
          if (o.root !== undefined && !String(o.root).endsWith('/')) throw new Error('root must end with /');
        },
      });
      host.addMethod('put', (_ctx, [name, text]) => void files.set(String(name), String(text)));
      host.addMethod('remember', (ctx) => void sessions.add(ctx.session));
      host.addMethod('ask', (ctx, [question, timeoutMs]) => host.ask(ctx.session, question, Number(timeoutMs ?? 5000)));
      host.addMethod('sessions', () => [...sessions]);
      host.addMethod('real', (_ctx, [x]) => host.formatReal(Number(x)));
      host.addMethod('sum', async (ctx, [sql]) => (await ctx.query(String(sql))).rows);
      // A plan as plain data, as a plugin gets it (JSON): no builders, nothing imported from smaltdb.
      host.addMethod('planSum', async (ctx, [table]) => {
        const r = await ctx.queryPlan!({ kind: 'query', plan: { op: 'aggregate', input: { op: 'scan', table: String(table), columns: [0] }, keys: [], aggs: [{ fn: 'sum', args: [{ k: 'col', input: 0, index: 0, depth: 0, type: 'any', collation: 'binary' }], star: false, distinct: false, collation: 'binary', type: 'any' }], carry: [] }, columns: [{ name: 'total', type: 'real' }] });
        return { columns: r.columns, rows: r.rows, types: r.columnTypes };
      });
      host.onSessionClosed((s) => void sessions.delete(s));
    },
  };
}

const put = (db: Database, name: string, text: string): Promise<unknown> => db.callPlugin('test-plugin', 'put', [name, text]);

describe('plugins', () => {
  it('a format, a source and a table function, with options and errors', async () => {
    const log: string[] = [];
    const db = Database.openMemory({ plugins: [testPlugin(log)] });
    await put(db, 'a.lines', 'x\ny\n');
    expect((await db.queryAsync("SELECT line FROM read_lines('mem:a.lines')")).rows).toEqual([['x'], ['y']]);
    expect((await db.queryAsync("SELECT line FROM read_lines('mem:a.lines', upper => 1)")).rows).toEqual([['X'], ['Y']]);
    await db.execAsync("CREATE EXTERNAL TABLE t WITH (location = 'mem:a.lines')");
    expect(db.query("SELECT data_type FROM information_schema.columns WHERE table_name = 't'").rows).toEqual([['TEXT']]);
    expect((await db.queryAsync('SELECT count(*) FROM t')).rows).toEqual([[2]]);
    expect(db.query("SELECT format FROM information_schema.external_tables WHERE table_name = 't'").rows).toEqual([['lines']]);
    // A format alias, and an option the format does not accept.
    await db.execAsync("CREATE EXTERNAL TABLE t2 WITH (location = 'mem:a.lines', format = 'ln')");
    expect((await db.queryAsync('SELECT count(*) FROM t2')).rows).toEqual([[2]]);
    await expect(db.execAsync("CREATE EXTERNAL TABLE t3 WITH (location = 'mem:a.lines', delimiter = ';')")).rejects.toMatchObject({ code: 'SMALT_EXTERNAL', message: "t3: unknown option 'delimiter'" });
    // Errors from the plugin carry the source's label.
    await put(db, 'bad.lines', '!x');
    await expect(db.queryAsync("SELECT * FROM read_lines('mem:bad.lines')")).rejects.toMatchObject({ code: 'SMALT_EXTERNAL', message: "read_lines('mem:bad.lines'): bad file" });
    await expect(db.queryAsync("SELECT * FROM read_lines('mem:none.lines')")).rejects.toMatchObject({ code: 'SMALT_EXTERNAL', message: "read_lines('mem:none.lines'): no file none.lines" });
    // REFRESH … IF CHANGED asks the source for its validator.
    await db.execAsync("CREATE MATERIALIZED VIEW m AS SELECT count(*) AS n FROM read_lines('mem:a.lines')");
    log.length = 0;
    await db.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED');
    expect(log).toEqual([]);
    await put(db, 'a.lines', 'x\ny\nz\n');
    await db.execAsync('REFRESH MATERIALIZED VIEW m IF CHANGED');
    expect(db.query('SELECT n FROM m').rows).toEqual([[3]]);
  });

  it('patterns, Hive partitions and partition pruning through a source that lists files', async () => {
    const log: string[] = [];
    const db = Database.openMemory({ plugins: [testPlugin(log)] });
    await put(db, 'ev/year=2023/a.lines', 'a\nb\n');
    await put(db, 'ev/year=2024/b.lines', 'c\n');
    await put(db, 'ev/year=2024/c.lines', 'd\ne\nf\n');
    expect((await db.queryAsync("SELECT year, count(*) FROM read_lines('mem:ev/**/*.lines') GROUP BY 1 ORDER BY 1")).rows).toEqual([
      [2023, 2],
      [2024, 4],
    ]);
    await db.execAsync("CREATE EXTERNAL TABLE ev WITH (location = 'mem:ev/**/*.lines')");
    log.length = 0;
    expect((await db.queryAsync('SELECT count(*) FROM ev WHERE year = 2024')).rows).toEqual([[4]]);
    expect(log.sort()).toEqual(['open ev/year=2024/b.lines', 'open ev/year=2024/c.lines']);
  });

  it('connection types: options, aliases, checks, and sources found by connection type', async () => {
    const db = Database.openMemory({ plugins: [testPlugin()] });
    await put(db, 'x.lines', 'q\n');
    await db.execAsync("CREATE CONNECTION c WITH (type = 'memory', root = 'data/')");
    expect(db.query("SELECT connection_type FROM information_schema.connections WHERE connection_name = 'c'").rows).toEqual([['mem']]);
    await db.execAsync("CREATE EXTERNAL TABLE x WITH (connection = 'c', location = 'x.lines')");
    expect((await db.queryAsync('SELECT line FROM x')).rows).toEqual([['q']]);
    await expect(db.execAsync("CREATE CONNECTION d WITH (type = 'mem', url = 'x')")).rejects.toMatchObject({ message: "connection d: unknown option 'url' for type mem (type, root, credentials)" });
    await expect(db.execAsync("CREATE CONNECTION d WITH (type = 'mem', root = 'x')")).rejects.toMatchObject({ code: 'SMALT_ERROR', message: 'connection d: root must end with /' });
    await expect(db.execAsync("CREATE CONNECTION d WITH (type = 'ftp')")).rejects.toMatchObject({ code: 'SMALT_ERROR', message: "connection d: type 'ftp' is not supported (mem)" });
    // A type smaltdb's own plugins provide names the plugin to install.
    await expect(db.execAsync("CREATE CONNECTION d WITH (type = 's3', bucket = 'b')")).rejects.toMatchObject({ code: 'SMALT_PLUGIN_MISSING', message: expect.stringContaining('@smaltdb/external') });
  });

  it('methods: results, the query helper, formatReal; unknown plugins and methods', async () => {
    const db = Database.openMemory({ plugins: [testPlugin()] });
    db.exec('CREATE TABLE n(x REAL); INSERT INTO n VALUES (1), (2.5)');
    expect(await db.callPlugin('test-plugin', 'sum', ['SELECT sum(x) FROM n'])).toEqual([[3.5]]);
    expect(await db.callPlugin('test-plugin', 'planSum', ['n'])).toEqual({ columns: ['total'], rows: [[3.5]], types: ['real'] });
    expect(await code(db.callPlugin('test-plugin', 'planSum', ['nope']))).toBe('SMALT_PLAN');
    expect(await db.callPlugin('test-plugin', 'real', [2])).toBe('2.0');
    expect(await code(db.callPlugin('test-plugin', 'nope', []))).toBe('SMALT_MISUSE');
    await expect(db.callPlugin('@smaltdb/io', 'importCSV', [])).rejects.toMatchObject({ code: 'SMALT_PLUGIN_MISSING', message: 'importCSV(): import and export needs the @smaltdb/io plugin (install it and add it to the engine\'s plugins)' });
    // In-process there is no client session to ask.
    expect(await code(db.callPlugin('test-plugin', 'ask', ['hi']))).toBe('SMALT_MISUSE');
    expect(db.plugins).toEqual([{ name: 'test-plugin', version: '1.0.0' }]);
  });

  it('refuses plugins for another API version, duplicates and clashing names', () => {
    const p = testPlugin();
    expect(() => Database.openMemory({ plugins: [{ ...p, apiVersion: 2 }] })).toThrow(/plugin API version 2/);
    expect(() => Database.openMemory({ plugins: [p, p] })).toThrow(/installed twice/);
    expect(() => Database.openMemory({ plugins: [p, { ...p, name: 'other' }] })).toThrow(/format 'lines' is already defined/);
  });

  it('without the plugins: SMALT_PLUGIN_MISSING naming the package to install', async () => {
    const db = Database.openMemory();
    const missing = async (sql: string): Promise<string> =>
      db.queryAsync(sql).then(
        () => 'ok',
        (e: { code: string; message: string }) => `${e.code} ${e.message}`,
      );
    expect(await missing("SELECT * FROM read_parquet('x.parquet')")).toBe(
      "SMALT_PLUGIN_MISSING read_parquet('x.parquet'): the parquet format needs the @smaltdb/parquet plugin (install it and add it to the engine's plugins)",
    );
    expect(await missing("SELECT * FROM read_csv('x.csv')")).toMatch(/^SMALT_PLUGIN_MISSING .*the csv format needs the @smaltdb\/io plugin/);
    expect(await missing("SELECT * FROM read_json('x.json')")).toMatch(/the json format needs the @smaltdb\/io plugin/);
    expect(await missing("SELECT * FROM read_lines('x.lines')")).toMatch(/^SMALT_ERROR/); // not a table function of any plugin smaltdb knows
    expect(await code(db.execAsync("CREATE EXTERNAL TABLE p WITH (location = 'x.parquet')"))).toBe('SMALT_PLUGIN_MISSING');
    expect(await code(db.execAsync("CREATE EXTERNAL TABLE p WITH (location = 'x.bin', format = 'xlsx')"))).toBe('SMALT_PLUGIN_MISSING');
    // With the format installed, a location no source handles names @smaltdb/external.
    const withFormat = Database.openMemory({ plugins: [testPlugin()] });
    await expect(withFormat.queryAsync("SELECT * FROM read_lines('https://example.com/a.lines')")).rejects.toMatchObject({ code: 'SMALT_PLUGIN_MISSING', message: expect.stringContaining('@smaltdb/external') });
    await expect(withFormat.queryAsync("SELECT * FROM read_lines('data/a.lines')")).rejects.toMatchObject({ code: 'SMALT_PLUGIN_MISSING', message: expect.stringContaining('@smaltdb/external') });
  });

  it('a database whose external tables need a plugin opens without it; only those tables need it', async () => {
    const vfs = new MemoryVfs();
    const a = await Database.open(vfs, 'db', { plugins: [testPlugin()] });
    await put(a, 'a.lines', 'x\ny\n');
    await a.execAsync("CREATE EXTERNAL TABLE ext WITH (location = 'mem:a.lines', format = 'lines')");
    a.exec('CREATE TABLE local(x INT); INSERT INTO local VALUES (1)');
    a.close();

    const b = await Database.open(vfs, 'db');
    expect(b.query('SELECT x FROM local').rows).toEqual([[1]]);
    expect(b.query("SELECT table_type FROM information_schema.tables WHERE table_name = 'ext'").rows).toEqual([['EXTERNAL']]);
    expect(b.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'ext'").rows).toEqual([['line']]);
    await expect(b.queryAsync('SELECT count(*) FROM ext')).rejects.toMatchObject({ code: 'SMALT_PLUGIN_MISSING', message: "ext: no installed plugin provides the 'lines' format" });
    b.exec('DROP EXTERNAL TABLE ext');
    expect(b.query("SELECT count(*) FROM information_schema.tables WHERE table_name = 'ext'").rows).toEqual([[0]]);
    b.close();
  });

  it('across the worker protocol: pluginCall, pluginAsk / pluginReply, and closed sessions', async () => {
    const log: { session: string; msg: Response }[] = [];
    const server = new EngineServer((session, msg) => log.push({ session, msg }), { open: () => Database.openMemory({ plugins: [testPlugin()] }) });
    let id = 1;
    const send = (session: string, body: Record<string, unknown>): number => {
      const rid = id++;
      server.receive(session, { ...body, id: rid } as Request);
      return rid;
    };
    const reply = (session: string, rid: number): Response | undefined => log.find((m) => m.session === session && m.msg.id === rid && (m.msg.kind === 'ok' || m.msg.kind === 'error'))?.msg;
    send(EngineServer.LOCAL, { op: 'open', name: ':memory:', storage: 'memory' });
    await until('open', () => server.db !== null);

    const r1 = send('tab-b', { op: 'pluginCall', plugin: 'test-plugin', method: 'remember', args: [] });
    await until('remember', () => !!reply('tab-b', r1));
    const r2 = send('local', { op: 'pluginCall', plugin: 'test-plugin', method: 'sessions', args: [] });
    await until('sessions', () => !!reply('local', r2));
    expect(reply('local', r2)).toMatchObject({ kind: 'ok', value: ['tab-b'] });

    // The plugin asks tab-b a question; tab-b answers; the call returns the answer.
    const r3 = send('tab-b', { op: 'pluginCall', plugin: 'test-plugin', method: 'ask', args: ['ping?'] });
    const asked = (): Extract<Response, { kind: 'pluginAsk' }> | undefined => log.find((m) => m.session === 'tab-b' && m.msg.kind === 'pluginAsk')?.msg as Extract<Response, { kind: 'pluginAsk' }> | undefined;
    await until('pluginAsk', () => !!asked());
    const ask = asked()!;
    expect(ask).toMatchObject({ plugin: 'test-plugin', message: 'ping?' });
    server.receive('tab-b', { id: 0, op: 'pluginReply', target: ask.request, value: 'pong' });
    await until('ask reply', () => !!reply('tab-b', r3));
    expect(reply('tab-b', r3)).toMatchObject({ kind: 'ok', value: 'pong' });

    // A question still open when its tab closes fails, and the plugin hears that the session closed.
    const r4 = send('tab-b', { op: 'pluginCall', plugin: 'test-plugin', method: 'ask', args: ['again?'] });
    await until('second ask', () => log.filter((m) => m.session === 'tab-b' && m.msg.kind === 'pluginAsk').length === 2);
    server.sessionGone('tab-b');
    const r5 = send('local', { op: 'pluginCall', plugin: 'test-plugin', method: 'sessions', args: [] });
    await until('sessions after close', () => !!reply('local', r5));
    expect(reply('local', r5)).toMatchObject({ kind: 'ok', value: [] });
    // Its pending call fails (the reply goes nowhere: the tab is gone).
    expect(reply('tab-b', r4)).toMatchObject({ kind: 'error', code: 'SMALT_EXTERNAL', message: 'test-plugin: the tab that would answer closed' });
  });

  it('a random-access read whose error says wholeFileMayHelp is retried once with bytes(), unless the file was complete', async () => {
    // `tail:<complete>/<error>`: random() gives the file without its last byte (a size the source
    // got wrong), bytes() the whole file. The `tail` format needs a file that ends in '#'.
    const log: string[] = [];
    const plugin: SmaltPlugin = {
      name: 'retry-plugin',
      version: '1.0.0',
      apiVersion: 1,
      setup(host) {
        const whole = new TextEncoder().encode('abc#');
        host.addSource({
          name: 'tail',
          prefixes: ['tail:'],
          async open(target) {
            const [complete] = target.location.slice(5).split('/');
            return {
              bytes: async () => (log.push('bytes'), { bytes: whole, validator: 'w' }),
              random: async () => ({
                file: { byteLength: 3, slice: (s, e) => whole.slice(s, Math.min(e ?? 3, 3)).buffer as ArrayBuffer },
                validator: 'r',
                ...(complete === 'absent' ? {} : { complete: () => complete === 'yes' }),
              }),
            };
          },
          async validator() {
            return null;
          },
        });
        host.addFormat({
          name: 'tail',
          extensions: ['tail'],
          access: 'random',
          async read(file, req) {
            log.push('read');
            const last = new Uint8Array(await file.slice(file.byteLength - 1, file.byteLength))[0];
            if (last !== 0x23) {
              const kind = req.label.match(/\/(\w+)/)?.[1];
              const e = new Error('no # at the end');
              if (kind === 'may') throw Object.assign(e, { wholeFileMayHelp: true });
              if (kind === 'code') throw Object.assign(e, { wholeFileMayHelp: true, code: 'SMALT_EXTERNAL' });
              throw e;
            }
            return { columns: [{ name: 'n', declType: 'INTEGER' }], rows: req.schemaOnly ? [] : [[file.byteLength]] };
          },
        });
        host.addTableFunction('read_tail', { format: 'tail' });
      },
    };
    const db = Database.openMemory({ plugins: [plugin] });
    const run = async (loc: string): Promise<{ result: unknown; log: string[] }> => {
      log.length = 0;
      const result = await db.queryAsync(`SELECT n FROM read_tail('${loc}')`).then(
        (r) => r.rows,
        (e: { code: string; message: string }) => `${e.code}: ${e.message}`,
      );
      return { result, log: [...log] };
    };
    // Not complete (false or absent): one whole-file read, then the reader again on it.
    for (const c of ['no', 'absent']) {
      expect(await run(`tail:${c}/may`), c).toEqual({ result: [[4]], log: ['read', 'bytes', 'read'] });
    }
    // Complete (an exact size, or the whole file in hand): reported at once.
    expect(await run('tail:yes/may')).toEqual({ result: "SMALT_EXTERNAL: read_tail('tail:yes/may'): no # at the end", log: ['read'] });
    // Errors without the flag, and errors with a SMALT_ code, are final.
    expect(await run('tail:no/plain')).toEqual({ result: "SMALT_EXTERNAL: read_tail('tail:no/plain'): no # at the end", log: ['read'] });
    expect(await run('tail:no/code')).toEqual({ result: 'SMALT_EXTERNAL: no # at the end', log: ['read'] });
  });
});

/** A server over an in-memory database with `plugins`, a recording transport and a `watchSession` stub. */
async function pluginServer(plugins: SmaltPlugin[]) {
  const log: { session: string; msg: Response }[] = [];
  const watched: string[] = [];
  const server = new EngineServer((session, msg) => log.push({ session, msg }), {
    open: () => Database.openMemory({ plugins }),
    watchSession: (s) => watched.push(s),
    refreshTimer: false,
  });
  let id = 1;
  const send = (session: string, body: Record<string, unknown>): number => {
    const rid = id++;
    server.receive(session, { ...body, id: rid } as Request);
    return rid;
  };
  const reply = (session: string, rid: number): Response | undefined => log.find((m) => m.session === session && m.msg.id === rid && (m.msg.kind === 'ok' || m.msg.kind === 'error' || m.msg.kind === 'done'))?.msg;
  /** Send a request and wait for its final reply. */
  const call = async (session: string, body: Record<string, unknown>): Promise<Response> => {
    const rid = send(session, body);
    await until(`${String(body.op)} from ${session}`, () => !!reply(session, rid));
    return reply(session, rid)!;
  };
  await call(EngineServer.LOCAL, { op: 'open', name: ':memory:', storage: 'memory' });
  return { server, log, watched, send, reply, call };
}

/** A Worker stand-in: the engine server runs in this thread, messages are cloned (as postMessage does) and delivered on later ticks. */
class FakeWorker {
  onmessage: ((e: { data: Response }) => void) | null = null;
  onerror: unknown = null;
  private readonly server: EngineServer;
  constructor(plugins: SmaltPlugin[]) {
    this.server = new EngineServer((_session, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), {
      open: () => Database.openMemory({ plugins }),
      refreshTimer: false,
    });
  }
  postMessage(req: Request): void {
    const r = structuredClone(req);
    setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
  }
  terminate(): void {}
}

// The client checks that workers exist before it uses the one it is given.
(globalThis as { Worker?: unknown }).Worker ??= FakeWorker;

const clients: client.Database[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  vi.restoreAllMocks();
});

describe('plugins: review of #38', () => {
  it('1. a tab that has only called plugin methods is watched, and onSessionClosed runs when it goes', async () => {
    const t = await pluginServer([testPlugin()]);
    expect(await t.call('tab-b', { op: 'pluginCall', plugin: 'test-plugin', method: 'remember', args: [] })).toMatchObject({ kind: 'ok' });
    // The server asked to be told when tab-b goes away (it holds no stream or transaction).
    expect(t.watched).toEqual(['tab-b']);
    // What the watch reports when the tab's lock is released.
    t.server.sessionGone(t.watched[0]);
    expect(await t.call('local', { op: 'pluginCall', plugin: 'test-plugin', method: 'sessions', args: [] })).toMatchObject({ kind: 'ok', value: [] });
  });

  it('2. a throwing onSessionClosed listener is reported; the closed tab\'s transaction still rolls back', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const thrower: SmaltPlugin = {
      name: 'thrower',
      version: '1.0.0',
      apiVersion: 1,
      setup(host) {
        host.onSessionClosed(() => {
          throw new Error('listener failed');
        });
      },
    };
    const t = await pluginServer([thrower, testPlugin()]);
    await t.call('local', { op: 'exec', sql: 'CREATE TABLE t(a INT)' });
    await t.call('tab-b', { op: 'pluginCall', plugin: 'test-plugin', method: 'remember', args: [] });
    expect(await t.call('tab-b', { op: 'exec', sql: 'BEGIN; INSERT INTO t VALUES (1)' })).toMatchObject({ kind: 'ok' });
    try {
      t.server.sessionGone('tab-b');
    } catch {
      // before the fix: the listener's error escaped here, skipping the rollback
    }
    // Another session's write gets through: tab-b's transaction was rolled back.
    expect(await t.call('local', { op: 'exec', sql: 'INSERT INTO t VALUES (2)' })).toMatchObject({ kind: 'ok' });
    expect(t.server.db!.query('SELECT a FROM t').rows).toEqual([[2]]);
    // The listeners after the failing one still ran, and the failure was reported with the plugin's name.
    expect(await t.call('local', { op: 'pluginCall', plugin: 'test-plugin', method: 'sessions', args: [] })).toMatchObject({ kind: 'ok', value: [] });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('thrower'), expect.objectContaining({ message: 'listener failed' }));
  });

  it('3. cancelling a plugin call: a method that stops on the signal gives SMALT_INTERRUPT; one that ignores it finishes', async () => {
    let release!: () => void;
    const started: string[] = [];
    const waiter: SmaltPlugin = {
      name: 'waiter',
      version: '1.0.0',
      apiVersion: 1,
      setup(host) {
        host.addMethod('stop', (ctx) => {
          started.push('stop');
          return new Promise((_resolve, reject) => ctx.signal!.addEventListener('abort', () => reject(ctx.signal!.reason)));
        });
        host.addMethod('ignore', async () => {
          started.push('ignore');
          await new Promise<void>((r) => (release = r));
          return 'done';
        });
      },
    };
    const t = await pluginServer([waiter]);
    const stop = t.send('tab-b', { op: 'pluginCall', plugin: 'waiter', method: 'stop', args: [] });
    await until('stop to start', () => started.includes('stop'));
    t.server.receive('tab-b', { id: 0, op: 'cancel', target: stop });
    await until('stop', () => !!t.reply('tab-b', stop));
    expect(t.reply('tab-b', stop)).toMatchObject({ kind: 'error', code: 'SMALT_INTERRUPT' });

    const ignore = t.send('tab-b', { op: 'pluginCall', plugin: 'waiter', method: 'ignore', args: [] });
    await until('ignore to start', () => started.includes('ignore'));
    t.server.receive('tab-b', { id: 0, op: 'cancel', target: ignore });
    await pause();
    expect(t.reply('tab-b', ignore)).toBeUndefined();
    release();
    await until('ignore', () => !!t.reply('tab-b', ignore));
    expect(t.reply('tab-b', ignore)).toMatchObject({ kind: 'ok', value: 'done' });
  });

  it('4. CREATE EXTERNAL TABLE without the format\'s plugin: SMALT_PLUGIN_MISSING before reader options are checked', async () => {
    const db = Database.openMemory();
    await expect(db.execAsync("CREATE EXTERNAL TABLE t(a INT) WITH (location = 'x.csv', delimiter = ';')")).rejects.toMatchObject({
      code: 'SMALT_PLUGIN_MISSING',
      message: expect.stringContaining('@smaltdb/io'),
    });
    await expect(db.execAsync("CREATE EXTERNAL TABLE t(a INT) WITH (location = 'x.bin', format = 'kv', separator = ':')")).rejects.toMatchObject({ code: 'SMALT_PLUGIN_MISSING' });
  });

  it('5. a handler answer that cannot be cloned fails the question at once (no timeout)', async () => {
    const db = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker([testPlugin()]) as unknown as Worker });
    clients.push(db);
    db.onPluginMessage('test-plugin', () => () => 'a function');
    const started = Date.now();
    // A 3-second timeout: the error must come well before it.
    await expect(db.callPlugin('test-plugin', 'ask', ['q', 3000])).rejects.toMatchObject({ code: 'SMALT_EXTERNAL', message: expect.stringMatching(/^test-plugin: .*clon/) });
    expect(Date.now() - started).toBeLessThan(2000);
    // A cloneable answer still works.
    db.onPluginMessage('test-plugin', (m) => `re: ${String(m)}`);
    expect(await db.callPlugin('test-plugin', 'ask', ['q'])).toBe('re: q');
  });

  it("a statement whose tab closes while its external data is fetched does not run after the tab's rollback", async () => {
    let release!: () => void;
    let opened = false;
    const gate: SmaltPlugin = {
      name: 'gate',
      version: '1.0.0',
      apiVersion: 1,
      setup(host) {
        host.addFormat({ name: 'gated', extensions: ['gated'], access: 'bytes', read: async () => ({ columns: [{ name: 'a', declType: 'INTEGER' }], rows: [[1], [2]] }) });
        host.addTableFunction('read_gated', { format: 'gated' });
        // A source that ignores the signal: it answers when the test lets it.
        host.addSource({
          name: 'gate',
          prefixes: ['gate:'],
          async open() {
            opened = true;
            await new Promise<void>((r) => (release = r));
            return { bytes: async () => ({ bytes: new Uint8Array(0), validator: null }) };
          },
          validator: async () => null,
        });
      },
    };
    const t = await pluginServer([gate]);
    await t.call('local', { op: 'exec', sql: 'CREATE TABLE t(a INT)' });
    await t.call('tab-b', { op: 'exec', sql: 'BEGIN; INSERT INTO t VALUES (0)' });
    const ins = t.send('tab-b', { op: 'exec', sql: "INSERT INTO t SELECT a FROM read_gated('gate:x')" });
    await until('the fetch', () => opened);
    t.server.sessionGone('tab-b');
    release();
    await until('the insert', () => !!t.reply('tab-b', ins));
    expect(t.reply('tab-b', ins)).toMatchObject({ kind: 'error', code: 'SMALT_INTERRUPT' });
    expect(t.server.db!.inTransaction).toBe(false);
    expect(t.server.db!.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });

  it('a method that hits SMALT_BUSY (another tab\'s open stream) runs again from the start once the stream ends', async () => {
    const runs: string[] = [];
    const writer: SmaltPlugin = {
      name: 'writer',
      version: '1.0.0',
      apiVersion: 1,
      setup(host) {
        host.addMethod('add', (ctx, [x]) => {
          runs.push(`run ${String(x)}`);
          ctx.db.exec(`INSERT INTO t VALUES (${Number(x)})`);
          return 'added';
        });
      },
    };
    const t = await pluginServer([writer]);
    await t.call('local', { op: 'exec', sql: 'CREATE TABLE t(a INT); INSERT INTO t VALUES (1), (2), (3)' });
    const q = t.send('tab-a', { op: 'query', sql: 'SELECT a FROM t', batchSize: 1, credit: 1 });
    await until('the first batch', () => t.log.some((m) => m.session === 'tab-a' && m.msg.id === q && m.msg.kind === 'batch'));
    const add = t.send('tab-b', { op: 'pluginCall', plugin: 'writer', method: 'add', args: [9] });
    await until('the first run', () => runs.length === 1);
    await pause();
    expect(t.reply('tab-b', add)).toBeUndefined(); // waits for the stream
    t.server.receive('tab-a', { id: 0, op: 'cancel', target: q });
    await until('add', () => !!t.reply('tab-b', add));
    expect(t.reply('tab-b', add)).toMatchObject({ kind: 'ok', value: 'added' });
    expect(runs).toEqual(['run 9', 'run 9']);
  });
});
