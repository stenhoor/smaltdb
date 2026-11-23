/**
 * Every SQL example in the user documentation (docs/guide, docs/reference) runs here, and every
 * result table printed under one must match what the engine returns. TypeScript examples are
 * type-checked against the public API and the plugins this repository installs (@smaltdb/io and @smaltdb/external,
 * pinned in packed.json). See docs/TESTING.md ("Documentation examples").
 *
 * A page runs top to bottom on one fresh in-memory database, so an earlier block's tables are
 * visible to later ones. Files in docs/examples/ are registered as `file:<name>`.
 *
 * Markers: an HTML comment on the line(s) before a fence.
 *   <!-- docs:skip -->            not run (a TS block is not type-checked)
 *   <!-- docs:error CODE -->      the block's last statement must fail with this error code
 *   <!-- docs:unordered -->       compare the result rows in any order
 *   <!-- docs:setup ... -->       hidden SQL run before the next block (e.g. data the reader need not see)
 *   <!-- docs:plugin NAME -->     the block needs a plugin this repository doesn't install (@smaltdb/parquet): it is
 *                                 not run or type-checked here, but in that plugin's repository, which runs the whole
 *                                 page with every plugin installed
 * A Markdown table directly after a sql fence is the expected result of the block's last statement:
 * the header row is the column names, `NULL` is NULL, blobs are x'hex', and a cell in backticks
 * is taken literally (so `' a '` keeps its spaces and quotes are dropped: write `'…'` for text with
 * surrounding spaces).
 *
 * The plan language and its functions (docs/reference/plan, its functions in docs/reference/plan/functions): each page starts from the
 * sample data (docs/reference/plan/sample.json), and a json fence is a plan statement as JSON, which must match the
 * grammar (docs/grammar.ebnf) and runs with queryPlan; a table after it is its result, as for SQL (truth values are
 * true / false, lists, structs and maps their JSON). More markers there:
 *   <!-- docs:params [..] -->    the statement's parameters, as JSON
 *   <!-- docs:plan-setup {..} --> a hidden plan statement run before the next block
 * A statement marked docs:error SMALT_PLAN shows an invalid plan, so it need not match the grammar.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import external from '@smaltdb/external';
import { registerFile } from '@smaltdb/external/client';
import io from '@smaltdb/io';
import { Database } from '../src/engine/database.js';
import { parse } from '@smaltworks/smaltql';
import type { SqlValue } from '../src/engine/values.js';
import { decodeDataJSON } from '../src/engine/plan/codec.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { GrammarMatcher, loadGrammar } from './helpers/plan-grammar.js';

const DOCS = 'docs';
const PAGE_DIRS = ['guide', 'reference'];
const EXAMPLES = join(DOCS, 'examples');
/** The plugins installed here; blocks marked `docs:plugin` with another are tested in that plugin's repository. */
const INSTALLED = ['@smaltdb/io', '@smaltdb/external'];
const needsOther = (b: Block): boolean =>
  b.markers.some((m) => {
    const name = /^docs:plugin\s+(\S+)/.exec(m)?.[1];
    return name !== undefined && !INSTALLED.includes(name);
  });

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
    if ((fence[3] === 'sql' || fence[3] === 'json') && lines[j]?.trim().startsWith('|') && /^\s*\|?\s*:?-+/.test(lines[j + 1] ?? '')) {
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

function show(v: unknown): string {
  if (v === null) return 'NULL';
  if (v instanceof Uint8Array) return `x'${Array.from(v, (b) => b.toString(16).padStart(2, '0')).join('')}'`;
  // A list, struct or map (plan results): its JSON, integers beyond 2^53 with every digit.
  if (typeof v === 'object') return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `${x}n` : x)).replace(/"(-?\d+)n"/g, '$1');
  return String(v);
}

/** Pages of the plan language: they start from the sample data, and their json fences are plan statements. */
const PLAN_PAGES = /^docs[\\/]reference[\\/]plan[\\/]/;
const SAMPLE = join(DOCS, 'reference', 'plan', 'sample.json');
const matcher = new GrammarMatcher(loadGrammar());

/** A plan statement written as JSON: it must match the grammar, unless it shows an invalid plan (SMALT_PLAN). */
function planStatement(text: string, where: string, invalid = false): PlanStatementInput {
  const raw = JSON.parse(text) as unknown;
  const why = invalid ? null : matcher.explain('statement', raw);
  if (why !== null) throw new Error(`${where}: the statement doesn't match the plan grammar at ${why}`);
  return decodeDataJSON(text) as PlanStatementInput;
}

async function registerExamples(db: Database): Promise<void> {
  let names: string[] = [];
  try {
    names = readdirSync(EXAMPLES);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(EXAMPLES, n);
    if (statSync(p).isFile()) await registerFile(db, n, new Uint8Array(readFileSync(p)));
  }
}

async function runSql(db: Database, sql: string): Promise<{ columns: string[]; rows: SqlValue[][] }> {
  const stmts = parse(sql);
  for (let i = 0; i < stmts.length - 1; i++) await db.execAsync(stmts[i].text);
  return db.queryAsync(stmts[stmts.length - 1].text);
}

/** A block's result against the table printed under it. */
function compare(result: { columns: string[]; rows: unknown[][] }, b: Block, where: string): void {
  const table = b.table!;
  expect(result.columns, `${where}: columns`).toEqual(table.header);
  const got = result.rows.map((r) => r.map(show));
  const want = table.rows;
  if (b.markers.includes('docs:unordered')) {
    const key = (r: string[]): string => JSON.stringify(r);
    expect(got.map(key).sort(), `${where}: rows`).toEqual(want.map(key).sort());
  } else expect(got, `${where}: rows`).toEqual(want);
}

const all = pages();

describe('documentation SQL examples', () => {
  it('finds the documentation pages', () => {
    expect(all.length).toBeGreaterThan(0);
  });
  for (const page of all) {
    it(page, async () => {
      // The plugins this repository installs (ADR 0012), as an application that uses them would.
      const db = Database.openMemory({ plugins: [external, io] });
      await registerExamples(db);
      const plans = PLAN_PAGES.test(page);
      if (plans) for (const s of JSON.parse(readFileSync(SAMPLE, 'utf8')) as PlanStatementInput[]) db.queryPlan(s);
      try {
        for (const b of blocks(readFileSync(page, 'utf8'))) {
          const where = `${page}:${b.line}`;
          for (const m of b.markers) {
            const setup = /^docs:setup\s+([\s\S]*)$/.exec(m);
            if (setup) await db.execAsync(setup[1]);
            const planSetup = /^docs:plan-setup\s+([\s\S]*)$/.exec(m);
            if (planSetup) db.queryPlan(planStatement(planSetup[1], where));
          }
          if (b.markers.includes('docs:skip') || needsOther(b)) continue;
          const err = b.markers.map((m) => /^docs:error\s+(\S+)/.exec(m)?.[1]).find(Boolean);
          if (b.lang === 'json' && plans) {
            const params = b.markers.map((m) => /^docs:params\s+([\s\S]*)$/.exec(m)?.[1]).find(Boolean);
            const args = params ? (decodeDataJSON(params) as SqlValue[]) : [];
            const stmt = planStatement(b.code, where, err === 'SMALT_PLAN');
            if (err) {
              let got = 'no error';
              try {
                db.queryPlan(stmt, args);
              } catch (e) {
                got = (e as { code?: string }).code ?? (e as Error).message;
              }
              expect(got, `${where}: expected error ${err}`).toBe(err);
              continue;
            }
            let result: { columns: string[]; rows: unknown[][] };
            try {
              result = db.queryPlan(stmt, args);
            } catch (e) {
              throw new Error(`${where}: ${(e as Error).message}\n${b.code}`);
            }
            if (!b.table) continue;
            compare(result, b, where);
            continue;
          }
          if (b.lang !== 'sql') continue;
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
          compare(result, b, where);
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
        if (!['ts', 'typescript'].includes(b.lang) || b.markers.includes('docs:skip') || needsOther(b)) return;
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
          paths: {
            smaltdb: [join(root, 'src/client/index.ts')],
            'smaltdb/engine': [join(root, 'src/engine/index.ts')],
            'smaltdb/plan': [join(root, 'src/engine/plan/portable.ts')],
            'smaltdb/language': [join(root, 'src/engine/language-support.ts')],
            'smaltdb/worker-runtime': [join(root, 'src/engine/worker-runtime.ts')],
          },
        },
        files,
      }),
    );
    let output = '';
    try {
      execFileSync(process.execPath, [join('node_modules', 'typescript7', 'bin', 'tsc'), '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
    } catch (e) {
      output = String((e as { stdout?: string }).stdout ?? e);
    }
    // Name the documentation page and line of each failing block.
    const report = output.replace(/^\.cache[\\/]docs-ts[\\/](\S+?\.ts)/gm, (_m, f: string) => `${origin.get(f) ?? f} (${f})`);
    expect(report, report).toBe('');
  }, 120_000);
});
