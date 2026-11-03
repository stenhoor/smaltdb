/**
 * Plugin API version 1 is stable (ADR 0013): within version 1, changes are additive only. This file is a version 1
 * plugin written against the public types (the module behind `smaltdb/engine`), and it is type-checked in CI
 * (`npm run typecheck`). It fails to compile when a change would break a version 1 plugin:
 * - the interfaces a plugin implements are given only their required members, so a newly required member fails;
 * - every PluginHost member, and every field the engine passes in, is used or listed, so a removed or renamed one fails.
 * Adding optional members or new PluginHost members keeps it compiling: that is allowed within version 1.
 * The run-time behaviour behind these types is tested in plugins.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  type AskError,
  type ConnectionTypeSpec,
  Database,
  type FormatColumn,
  type FormatReader,
  type FormatRequest,
  type FormatResult,
  type ListedFile,
  type MethodContext,
  type OpenedFile,
  PLUGIN_API_VERSION,
  type PluginHost,
  type PluginMethod,
  type RandomAccessFile,
  type RandomFile,
  type SmaltPlugin,
  type SourceContext,
  type SourceHandler,
  type SourceTarget,
  type SqlValue,
  type StaticType,
  type Zone,
} from '../src/engine/index.js';

// ------------------------------------------------- compile-time: what version 1 promises

/** Fails to compile unless every name in `K` is a key of `T` (a version 1 member was removed or renamed). */
type Has<T, K extends string> = [Exclude<K, keyof T>] extends [never] ? true : { missing: Exclude<K, keyof T> };
const keep = <T extends true>(_: T): void => undefined;

// What the engine gives a plugin: every version 1 member stays.
keep<Has<PluginHost, 'apiVersion' | 'addFormat' | 'addTableFunction' | 'addSource' | 'addConnectionType' | 'addMethod' | 'onSessionClosed' | 'ask' | 'glob' | 'formatReal'>>(true);
keep<Has<PluginHost['glob'], 'isGlob' | 'regExp' | 'prefix'>>(true);
keep<Has<FormatRequest, 'label' | 'options' | 'columns' | 'projection' | 'blockFilters' | 'schemaOnly'>>(true);
keep<Has<SourceTarget, 'location' | 'connection'>>(true);
keep<Has<SourceContext, 'label' | 'signal'>>(true);
keep<Has<MethodContext, 'db' | 'session' | 'signal' | 'query'>>(true);
keep<Has<AskError, 'code' | 'reason' | 'detail' | 'message'>>(true);
keep<Has<Zone, 'nulls' | 'numMin' | 'numMax' | 'textMin' | 'textMax'>>(true);
keep<Has<FormatColumn, 'name' | 'declType'>>(true);
keep<Has<FormatResult, 'columns' | 'rows'>>(true);
keep<Has<RandomAccessFile, 'byteLength' | 'slice'>>(true);
keep<Has<ListedFile, 'location' | 'path' | 'validator'>>(true);

// Values a plugin reads: every version 1 value is still one (new ones may be added).
const reasons: AskError['reason'][] = ['timeout', 'closed', 'failed', 'no-session'];
const staticTypes: StaticType[] = ['int', 'real', 'num', 'text', 'blob', 'null', 'any'];

// What a plugin implements, with only the required members: a newly required member fails here.
const minimalBytesFormat: FormatReader = { name: 'v1bytes', extensions: ['v1b'], access: 'bytes', read: async () => ({ columns: [], rows: [] }) };
const minimalRandomFormat: FormatReader = { name: 'v1random', extensions: ['v1r'], access: 'random', read: async (file) => ({ columns: [{ name: 'size', declType: 'INTEGER' }], rows: [[file.byteLength]] }) };
const minimalOpened: OpenedFile = { bytes: async () => ({ bytes: new Uint8Array(), validator: null }) };
const minimalRandom: RandomFile = { file: { byteLength: 0, slice: () => new ArrayBuffer(0) }, validator: null };
const minimalSource: SourceHandler = { name: 'v1src', prefixes: ['v1src:'], open: async () => minimalOpened, validator: async () => null };
const minimalConnection: ConnectionTypeSpec = { options: [] };
const minimalMethod: PluginMethod = () => undefined;
const minimalPlugin: SmaltPlugin = { name: 'v1-minimal', version: '1.0.0', apiVersion: 1, setup: () => undefined };
const minimalListed: ListedFile = { location: 'v1src:a', path: 'a' };

// ------------------------------------------------- a version 1 plugin that uses every PluginHost member

/** `v1:` files from a Map, a `kv` format (`key=value` lines), `read_kv()`, a `v1` connection type and a `put` method. */
function v1Plugin(): SmaltPlugin {
  return {
    name: 'v1-plugin',
    version: '1.0.0',
    apiVersion: 1,
    setup(host: PluginHost) {
      const files = new Map<string, string>();
      const seen: string[] = [];
      const read = async (bytes: Uint8Array, req: FormatRequest): Promise<FormatResult> => {
        const rows: SqlValue[][] = new TextDecoder()
          .decode(bytes)
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => l.split('=', 2));
        return { columns: [{ name: 'key', declType: 'TEXT' }, { name: 'value', declType: 'TEXT' }], rows: req.schemaOnly ? [] : rows };
      };
      host.addFormat({ name: 'kv', extensions: ['kv'], access: 'bytes', read });
      host.addFormat(minimalRandomFormat);
      host.addTableFunction('read_kv', { format: 'kv' });
      host.addTableFunction('read_size', { format: () => 'v1random' });
      host.addSource({
        name: 'v1files',
        prefixes: ['v1:'],
        connectionTypes: ['v1'],
        async open(target: SourceTarget, ctx: SourceContext) {
          seen.push(ctx.label);
          const text = files.get(target.location.replace(/^v1:/, ''));
          if (text === undefined) throw new Error(`no file ${target.location}`);
          const bytes = new TextEncoder().encode(text);
          return {
            bytes: async () => ({ bytes, validator: host.formatReal(text.length) }),
            random: async () => ({ file: { byteLength: bytes.length, slice: (s, e) => bytes.slice(s, e).buffer }, validator: null, complete: () => true }),
          };
        },
        validator: async () => null,
        list: async (target) => {
          const pattern = target.location.replace(/^v1:/, '');
          const re = host.glob.regExp(pattern);
          return [...files.keys()].filter((n) => n.startsWith(host.glob.prefix(pattern)) && re.test(n)).map((n) => ({ location: `v1:${n}`, path: n }));
        },
        isPattern: (target) => host.glob.isGlob(target.location),
      });
      host.addConnectionType('v1', { options: [] });
      host.addMethod('put', (ctx: MethodContext, [name, text]) => {
        expect(ctx.session).toBe('local');
        files.set(String(name), String(text));
      });
      host.addMethod('ask', (ctx) => host.ask(ctx.session, 'hello', 1000).catch((e: AskError) => e.reason));
      host.addMethod('rows', async (ctx) => (await ctx.query("SELECT count(*) AS n FROM read_kv('v1:a.kv') WHERE key <> ?", ['none'])).columnTypes);
      host.onSessionClosed(() => undefined);
      expect(host.apiVersion).toBe(1);
    },
  };
}

describe('plugin API version 1 (ADR 0013)', () => {
  it('the engine implements version 1', () => {
    expect(PLUGIN_API_VERSION).toBe(1);
    // The compile-time lists above are used, so the checks they make are not optimised away by a reader.
    expect([reasons.length, staticTypes.length]).toEqual([4, 7]);
    expect([minimalBytesFormat, minimalSource, minimalConnection, minimalMethod, minimalListed, minimalRandom].length).toBe(6);
  });

  it('a version 1 plugin installs and works through every PluginHost member', async () => {
    const db = Database.openMemory({ plugins: [v1Plugin(), minimalPlugin] });
    try {
      expect(db.plugins.map((p) => p.name)).toEqual(['v1-plugin', 'v1-minimal']);
      await db.callPlugin('v1-plugin', 'put', ['a.kv', 'x=1\ny=2\n']);
      await db.callPlugin('v1-plugin', 'put', ['b.kv', 'z=3\n']);
      expect((await db.queryAsync("SELECT key, value FROM read_kv('v1:a.kv') ORDER BY key")).rows).toEqual([
        ['x', '1'],
        ['y', '2'],
      ]);
      expect((await db.queryAsync("SELECT count(*) FROM read_kv('v1:*.kv')")).rows).toEqual([[3]]);
      expect((await db.queryAsync("SELECT size FROM read_size('v1:b.kv')")).rows).toEqual([[4]]);
      await db.execAsync("CREATE CONNECTION c WITH (type = 'v1'); CREATE EXTERNAL TABLE t WITH (connection = 'c', location = 'v1:a.kv', format = 'kv')");
      expect((await db.queryAsync('SELECT count(*) FROM t')).rows).toEqual([[2]]);
      // In-process there is no client session to ask.
      expect(await db.callPlugin('v1-plugin', 'ask', [])).toBe('no-session');
      expect(await db.callPlugin('v1-plugin', 'rows', [])).toEqual(['int']);
    } finally {
      db.close();
    }
  });

  it('an engine refuses a plugin written for another API version, naming both', () => {
    const v2: SmaltPlugin = { ...minimalPlugin, name: 'v2-plugin', apiVersion: 2 };
    let err: { code?: string; message: string } | undefined;
    try {
      Database.openMemory({ plugins: [v2] });
    } catch (e) {
      err = e as { code?: string; message: string };
    }
    expect(err?.code).toBe('SMALT_MISUSE');
    expect(err?.message).toContain('needs plugin API version 2; this engine implements version 1');
  });
});
