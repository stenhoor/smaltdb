/**
 * sqllogictest runner (https://sqlite.org/sqllogictest): runs a fixed subset of the corpus against
 * the smaltdb engine and reports the pass rate per file. The corpus is public domain; files are
 * downloaded from a GitHub mirror into .cache/slt on first use (not committed).
 *
 *   npm run slt                    # the default subset
 *   npm run slt -- --save          # also write bench/results/slt-<date>.json
 *   npm run slt -- --file select1  # files whose path contains "select1"
 *   npm run slt -- --verbose       # print failing records
 *
 * Records are run as SQLite would: `skipif sqlite` / `onlyif <other>` records are skipped. smaltdb
 * tables are STRICT by default while the corpus assumes SQLite's loose typing; such failures are
 * counted separately ("strict typing") so they are not mistaken for engine bugs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database } from '../../src/engine/database.js';
import '../../src/engine/sql/register.js';
import type { SqlValue } from '../../src/engine/values.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

const MIRROR = 'https://raw.githubusercontent.com/gregrahn/sqllogictest/master/test/';
export const FILES = [
  'select1.test',
  'select2.test',
  'select3.test',
  'select4.test',
  'select5.test',
  'evidence/in1.test',
  'evidence/in2.test',
  'evidence/slt_lang_aggfunc.test',
  'evidence/slt_lang_createview.test',
  'evidence/slt_lang_dropindex.test',
  'evidence/slt_lang_droptable.test',
  'evidence/slt_lang_dropview.test',
  'evidence/slt_lang_replace.test',
  'evidence/slt_lang_update.test',
  'random/aggregates/slt_good_0.test',
  'random/expr/slt_good_0.test',
  'random/groupby/slt_good_0.test',
  'random/select/slt_good_0.test',
  'index/between/1/slt_good_0.test',
  'index/commute/10/slt_good_0.test',
  'index/delete/1/slt_good_0.test',
  'index/in/10/slt_good_0.test',
  'index/orderby/10/slt_good_0.test',
  'index/orderby_nosort/10/slt_good_0.test',
  'index/random/10/slt_good_0.test',
];

const CACHE = '.cache/slt';

async function fetchFile(path: string): Promise<string> {
  const local = join(CACHE, path);
  if (existsSync(local)) return readFileSync(local, 'utf8');
  const res = await fetch(MIRROR + path);
  if (!res.ok) throw new Error(`download ${path}: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, text);
  return text;
}

interface Rec {
  kind: 'statement' | 'query';
  ok?: boolean;
  types?: string;
  sort?: string;
  label?: string;
  sql: string;
  expected: string[];
  line: number;
}

/** Parse records; skipif/onlyif are applied for the "sqlite" engine name. */
function* records(text: string): Generator<Rec | { kind: 'halt' } | { kind: 'hash-threshold'; n: number }> {
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    let line = lines[i];
    if (line.trim() === '' || line.startsWith('#')) {
      i++;
      continue;
    }
    let skip = false;
    while (line.startsWith('skipif ') || line.startsWith('onlyif ')) {
      const db = line.split(/\s+/)[1];
      if (line.startsWith('skipif ') && db === 'sqlite') skip = true;
      if (line.startsWith('onlyif ') && db !== 'sqlite') skip = true;
      line = lines[++i];
    }
    const start = i + 1;
    const head = line.trim().split(/\s+/);
    i++;
    if (head[0] === 'halt') {
      if (!skip) yield { kind: 'halt' };
      continue;
    }
    if (head[0] === 'hash-threshold') {
      yield { kind: 'hash-threshold', n: Number(head[1]) };
      continue;
    }
    const sql: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && lines[i] !== '----') sql.push(lines[i++]);
    const expected: string[] = [];
    if (lines[i] === '----') {
      i++;
      while (i < lines.length && lines[i].trim() !== '') expected.push(lines[i++].trim());
    }
    if (skip) continue;
    if (head[0] === 'statement') yield { kind: 'statement', ok: head[1] === 'ok', sql: sql.join('\n'), expected, line: start };
    else if (head[0] === 'query') yield { kind: 'query', types: head[1], sort: head[2] ?? 'nosort', label: head[3], sql: sql.join('\n'), expected, line: start };
  }
}

/** Format one value as the reference SQLite driver does for column type I / R / T. */
function fmt(v: SqlValue, t: string): string {
  if (v === null) return 'NULL';
  if (t === 'I') {
    if (typeof v === 'number') return String(Math.trunc(v));
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') {
      const m = /^\s*[+-]?\d+/.exec(v);
      return m ? String(Number(m[0])) : '0';
    }
    return '0';
  }
  if (t === 'R') {
    const n = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : Number.parseFloat(String(v)) || 0;
    // The reference driver's printf("%.3f") keeps 16 significant digits for huge magnitudes.
    if (Math.abs(n) >= 1e16 && Number.isFinite(n)) return expandDigits(n.toPrecision(16)) + '.000';
    return n.toFixed(3);
  }
  let s: string;
  if (typeof v === 'number') s = Number.isInteger(v) ? String(v) : formatRealText(v);
  else if (typeof v === 'bigint') s = v.toString();
  else if (v instanceof Uint8Array) s = new TextDecoder().decode(v);
  else s = v;
  if (s === '') return '(empty)';
  return s.replace(/[\x00-\x1f\x7f]/g, '@');
}

/** "-9.223372036854776e+18" -> "-9223372036854776000". */
function expandDigits(p: string): string {
  const m = /^(-?)(\d)(?:\.(\d+))?e\+(\d+)$/.exec(p);
  if (!m) return p.replace(/\.\d*$/, '');
  const digits = m[2] + (m[3] ?? '');
  const exp = Number(m[4]);
  return m[1] + (digits.length <= exp + 1 ? digits.padEnd(exp + 1, '0') : digits.slice(0, exp + 1));
}

function formatRealText(v: number): string {
  // SQLite's %!.15g
  let s = v.toPrecision(15);
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    s = `${m.includes('.') ? m.replace(/0+$/, '').replace(/\.$/, '.0') : m + '.0'}e${e[0] === '-' ? '-' : '+'}${e.replace(/^[+-]/, '').padStart(2, '0')}`;
    return s;
  }
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0');
  else s += '.0';
  return s;
}

interface FileResult {
  file: string;
  records: number;
  passed: number;
  failed: number;
  strictTyping: number;
  unsupported: number;
  ms: number;
  failures: string[];
}

async function runFile(path: string, verbose: boolean): Promise<FileResult> {
  const text = await fetchFile(path);
  const db = Database.openFile(new MemoryVfs().openSync('slt.db'));
  let hashThreshold = 0;
  const res: FileResult = { file: path, records: 0, passed: 0, failed: 0, strictTyping: 0, unsupported: 0, ms: 0, failures: [] };
  const t0 = performance.now();
  const fail = (r: Rec, why: string): void => {
    if (/SMALT_UNSUPPORTED|not supported/i.test(why)) res.unsupported++;
    else if (/cannot store \w+ value in \w+ column|datatype mismatch/.test(why)) res.strictTyping++;
    else res.failed++;
    if (res.failures.length < 20) res.failures.push(`line ${r.line}: ${why}\n    ${r.sql.replace(/\n/g, ' ').slice(0, 200)}`);
  };
  for (const r of records(text)) {
    if (r.kind === 'halt') break;
    if (r.kind === 'hash-threshold') {
      hashThreshold = r.n;
      continue;
    }
    res.records++;
    if (r.kind === 'statement') {
      let ok = true;
      let msg = '';
      try {
        db.exec(r.sql);
      } catch (e) {
        ok = false;
        msg = `${(e as { code?: string }).code ?? ''} ${(e as Error).message}`;
      }
      if (ok === r.ok) res.passed++;
      else fail(r, r.ok ? `statement failed: ${msg}` : 'statement succeeded but an error was expected');
      continue;
    }
    let rows: SqlValue[][];
    try {
      rows = db.query(r.sql).rows;
    } catch (e) {
      fail(r, `query error: ${(e as { code?: string }).code ?? ''} ${(e as Error).message}`);
      continue;
    }
    const types = r.types!;
    let values: string[];
    if (rows.length && rows[0].length !== types.length) {
      fail(r, `expected ${types.length} columns, got ${rows[0].length}`);
      continue;
    }
    const formatted = rows.map((row) => row.map((v, i) => fmt(v, types[i] ?? 'T')));
    if (r.sort === 'rowsort') {
      formatted.sort((a, b) => {
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
        return 0;
      });
    }
    values = formatted.flat();
    if (r.sort === 'valuesort') values = [...values].sort();
    let actual: string[] = values;
    const expectHash = r.expected.length === 1 && / values hashing to /.test(r.expected[0]);
    if (expectHash || (hashThreshold > 0 && values.length > hashThreshold)) {
      const h = createHash('md5');
      for (const v of values) h.update(v + '\n');
      actual = [`${values.length} values hashing to ${h.digest('hex')}`];
    }
    const exp = r.expected;
    if (actual.length === exp.length && actual.every((v, i) => v === exp[i])) res.passed++;
    else fail(r, `wrong result: got ${JSON.stringify(actual.slice(0, 6))} expected ${JSON.stringify(exp.slice(0, 6))}`);
  }
  res.ms = Math.round(performance.now() - t0);
  db.close();
  if (verbose) for (const f of res.failures) console.log('  ' + f);
  return res;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filter = args.includes('--file') ? args[args.indexOf('--file') + 1] : undefined;
  const verbose = args.includes('--verbose');
  const files = FILES.filter((f) => !filter || f.includes(filter));
  const results: FileResult[] = [];
  console.log('file'.padEnd(44), 'records'.padStart(8), 'pass'.padStart(8), 'rate'.padStart(7), 'fail'.padStart(6), 'strict'.padStart(7), 'unsup'.padStart(6), 'ms'.padStart(7));
  for (const f of files) {
    const r = await runFile(f, verbose);
    results.push(r);
    const rate = r.records ? ((100 * r.passed) / r.records).toFixed(1) + '%' : '-';
    console.log(f.padEnd(44), String(r.records).padStart(8), String(r.passed).padStart(8), rate.padStart(7), String(r.failed).padStart(6), String(r.strictTyping).padStart(7), String(r.unsupported).padStart(6), String(r.ms).padStart(7));
  }
  const tot = results.reduce((a, r) => ({ records: a.records + r.records, passed: a.passed + r.passed, failed: a.failed + r.failed, strict: a.strict + r.strictTyping, unsup: a.unsup + r.unsupported }), { records: 0, passed: 0, failed: 0, strict: 0, unsup: 0 });
  console.log(`\nTOTAL ${tot.passed}/${tot.records} = ${((100 * tot.passed) / tot.records).toFixed(2)}%  (other failures ${tot.failed}, strict typing ${tot.strict}, unsupported ${tot.unsup})`);
  if (args.includes('--save')) {
    const out = `bench/results/slt-${new Date().toISOString().slice(0, 10)}.json`;
    writeFileSync(out, JSON.stringify({ total: tot, files: results.map(({ failures, ...r }) => ({ ...r, sampleFailures: failures.slice(0, 5) })) }, null, 2));
    console.log(`saved ${out}`);
  }
}

void main();
