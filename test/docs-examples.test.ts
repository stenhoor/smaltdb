/**
 * Every SQL example in the user documentation (docs/guide, docs/reference) runs here, and every
 * result table printed under one must match what the engine returns. TypeScript examples are
 * type-checked against the public API (and the plugins in plugins/). See docs/TESTING.md ("Documentation examples").
 *
 * A page runs top to bottom on one fresh in-memory database, so an earlier block's tables are
 * visible to later ones. Files in docs/examples/ are registered as `file:<name>`.
 *
 * Markers: an HTML comment on the line(s) before a fence.
 *   <!-- docs:skip -->            not run (a TS block is not type-checked)
 *   <!-- docs:error CODE -->      the block's last statement must fail with this error code
 *   <!-- docs:unordered -->       compare the result rows in any order
 *   <!-- docs:setup ... -->       hidden SQL run before the next block (e.g. data the reader need not see)
 * A Markdown table directly after a sql fence is the expected result of the block's last statement:
 * the header row is the column names, `NULL` is NULL, blobs are x'hex', and a cell in backticks
 * is taken literally (so `' a '` keeps its spaces and quotes are dropped: write `'…'` for text with
 * surrounding spaces).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import parquet from '@smaltdb/parquet';
import { Database } from '../src/engine/database.js';
import { parse } from '../src/engine/sql/parser.js';
import type { SqlValue } from '../src/engine/values.js';

const DOCS = 'docs';
const PAGE_DIRS = ['guide', 'reference'];
const EXAMPLES = join(DOCS, 'examples');

function pages(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir).sort()) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith('.md')) out.push(p);
    }
  };
  for (const d of PAGE_DIRS) {
    try {
      walk(join(DOCS, d));
    } catch {
      /* directory not there yet */
    }
  }
  return out;
}

interface Block {
  lang: string;
  code: string;
  line: number;
  markers: string[];
  table: { header: string[]; rows: string[][] } | null;
}

function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur);
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur);
  return cells.map((c) => {
    const t = c.trim();
    const m = /^`(.*)`$/.exec(t);
    if (!m) return t;
    const inner = m[1];
    return /^'.*'$/.test(inner) ? inner.slice(1, -1) : inner;
  });
}

function blocks(md: string): Block[] {
  const lines = md.split('\n');
  const out: Block[] = [];
  let markers: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const marker = /^\s*<!--\s*(docs:[\s\S]*?)\s*-->\s*$/.exec(line);
    if (marker) {
      markers.push(marker[1]);
      continue;
    }
    const fence = /^(\s*)(```+)\s*([\w-]*)/.exec(line);
    if (!fence) {
      if (line.trim() !== '') markers = [];
      continue;
    }
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && !lines[i].trim().startsWith(fence[2]); i++) body.push(lines[i]);
    // A result table may follow after blank lines.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    let table: Block['table'] = null;
    if (fence[3] === 'sql' && lines[j]?.trim().startsWith('|') && /^\s*\|?\s*:?-+/.test(lines[j + 1] ?? '')) {
      const header = splitRow(lines[j]);
      const rows: string[][] = [];
      let k = j + 2;
      for (; k < lines.length && lines[k].trim().startsWith('|'); k++) rows.push(splitRow(lines[k]));
      table = { header, rows };
      i = k - 1;
    }
    out.push({ lang: fence[3], code: body.join('\n'), line: start + 1, markers, table });
    markers = [];
  }
  return out;
}

function show(v: SqlValue): string {
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array) return `x'${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}'`;
  return String(v);
}

function registerExamples(db: Database): void {
  let names: string[] = [];
  try {
    names = readdirSync(EXAMPLES);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(EXAMPLES, n);
    if (statSync(p).isFile()) db.registerFile(n, new Uint8Array(readFileSync(p)));
  }
}

async function runSql(db: Database, sql: string): Promise<{ columns: string[]; rows: SqlValue[][] }> {
  const stmts = parse(sql);
  for (let i = 0; i < stmts.length - 1; i++) await db.execAsync(stmts[i].text);
  return db.queryAsync(stmts[stmts.length - 1].text);
}

const all = pages();

describe('documentation SQL examples', () => {
  it('finds the documentation pages', () => {
    expect(all.length).toBeGreaterThan(0);
  });
  for (const page of all) {
    it(page, async () => {
      // Every plugin is installed (ADR 0012), as an application that uses them would.
      const db = Database.openMemory({ plugins: [parquet] });
      registerExamples(db);
      try {
        for (const b of blocks(readFileSync(page, 'utf8'))) {
          const where = `${page}:${b.line}`;
          for (const m of b.markers) {
            const setup = /^docs:setup\s+([\s\S]*)$/.exec(m);
            if (setup) await db.execAsync(setup[1]);
          }
          if (b.lang !== 'sql' || b.markers.includes('docs:skip')) continue;
          const err = b.markers.map((m) => /^docs:error\s+(\S+)/.exec(m)?.[1]).find(Boolean);
          if (err) {
            // A syntax error anywhere in the block fails parse(): run the block as one script then.
            let stmts: { text: string }[];
            try {
              stmts = parse(b.code);
            } catch {
              stmts = [{ text: b.code }];
            }
            for (let i = 0; i < stmts.length - 1; i++) await db.execAsync(stmts[i].text);
            const got = await db.execAsync(stmts[stmts.length - 1].text).then(
              () => 'no error',
              (e: { code?: string; message: string }) => e.code ?? e.message,
            );
            expect(got, `${where}: expected error ${err}`).toBe(err);
            continue;
          }
          let result: { columns: string[]; rows: SqlValue[][] };
          try {
            result = await runSql(db, b.code);
          } catch (e) {
            throw new Error(`${where}: ${(e as Error).message}\n${b.code}`);
          }
          if (!b.table) continue;
          expect(result.columns, `${where}: columns`).toEqual(b.table.header);
          const got = result.rows.map((r) => r.map(show));
          const want = b.table.rows;
          if (b.markers.includes('docs:unordered')) {
            const key = (r: string[]): string => JSON.stringify(r);
            expect(got.map(key).sort(), `${where}: rows`).toEqual(want.map(key).sort());
          } else expect(got, `${where}: rows`).toEqual(want);
        }
      } finally {
        db.close();
      }
    });
  }
});

describe('documentation TypeScript examples', () => {
  it('type-check against the public API', () => {
    const dir = join('.cache', 'docs-ts');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    const origin = new Map<string, string>();
    for (const page of all) {
      blocks(readFileSync(page, 'utf8')).forEach((b, n) => {
        if (!['ts', 'typescript'].includes(b.lang) || b.markers.includes('docs:skip')) return;
        // `db` (an open client database) is predeclared unless the block makes its own.
        const declaresDb = /\b(const|let|var)\s+db\b|\(\s*db\s*(:[^)]*)?\)\s*=>|\bfunction\s*\w*\s*\(\s*db\b/.test(b.code);
        const prelude = declaresDb ? '' : "declare const db: import('smaltdb').Database;\n";
        const name = `${page.replace(/[\\/]/g, '_').replace(/\.md$/, '')}_${n}.ts`;
        writeFileSync(join(dir, name), `${prelude}${b.code}\nexport {};\n`);
        files.push(name);
        origin.set(name, `${page}:${b.line}`);
      });
    }
    if (files.length === 0) return;
    const root = relative(dir, '.');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022', 'DOM', 'WebWorker'],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ['node'],
          typeRoots: [join(root, 'node_modules/@types')],
          baseUrl: '.',
          paths: {
            smaltdb: [join(root, 'src/client/index.ts')],
            'smaltdb/engine': [join(root, 'src/engine/index.ts')],
            'smaltdb/worker-runtime': [join(root, 'src/engine/worker-runtime.ts')],
            '@smaltdb/parquet': [join(root, 'plugins/parquet/src/index.ts')],
          },
        },
        files,
      }),
    );
    let output = '';
    try {
      execFileSync(process.execPath, [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
    } catch (e) {
      output = String((e as { stdout?: string }).stdout ?? e);
    }
    // Name the documentation page and line of each failing block.
    const report = output.replace(/^\.cache[\\/]docs-ts[\\/](\S+?\.ts)/gm, (_m, f: string) => `${origin.get(f) ?? f} (${f})`);
    expect(report, report).toBe('');
  }, 120_000);
});
