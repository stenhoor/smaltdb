/**
 * The function reference of the plan language (docs/reference/plan/functions) covers the engine's functions: every
 * function the catalog lists (and the operations a plan may call that it doesn't) has a page, in the group of its
 * kind, and the page's syntax diagram takes the arguments the engine accepts. Every page has a summary, a tested
 * example with its result, and a demo; each group page lists its members. The examples themselves run in
 * test/docs-examples.test.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { type Node, parseEbnf } from '../docs/.vitepress/theme/railroad.js';
import { loadGrammar } from './helpers/plan-grammar.js';

const DIR = 'docs/reference/plan/functions';
/** Operations a `call` may name that the catalog doesn't list. */
const UNLISTED = [
  { name: 'current_date', kind: 'scalar', minArgs: 0, maxArgs: 0 },
  { name: 'current_time', kind: 'scalar', minArgs: 0, maxArgs: 0 },
  { name: 'current_timestamp', kind: 'scalar', minArgs: 0, maxArgs: 0 },
];
const kindOf = (group: string): string => (group === 'aggregate' ? 'aggregate' : group === 'window' ? 'window' : 'scalar');

interface Page {
  path: string;
  group: string;
  file: string;
  text: string;
  /** The functions its diagram defines, and the arguments each takes. */
  rules: Map<string, [number, number]>;
}

/** The least and most arguments a function's rule takes: its argument placeholders are upper-case names. */
function arity(n: Node): [number, number] {
  switch (n.t) {
    case 'ref':
      return /^[A-Z][A-Z0-9_]*$/.test(n.name) ? [1, 1] : [0, 0];
    case 'seq':
      return n.items.map(arity).reduce((a, b) => [a[0] + b[0], a[1] + b[1]], [0, 0]);
    case 'choice': {
      const all = n.items.map(arity);
      return [Math.min(...all.map((a) => a[0])), Math.max(...all.map((a) => a[1]))];
    }
    case 'opt':
      return [0, arity(n.item)[1]];
    case 'rep': {
      const [min] = arity(n.item);
      return [min, Infinity];
    }
    default:
      return [0, 0];
  }
}

function pages(): Page[] {
  const out: Page[] = [];
  for (const group of readdirSync(DIR).sort()) {
    const dir = join(DIR, group);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith('.md') || file === 'index.md') continue;
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      const fence = /```ebnf\n([\s\S]*?)```/.exec(text);
      const rules = new Map<string, [number, number]>();
      if (fence) for (const [name, node] of parseEbnf(fence[1]).rules) rules.set(name, arity(node));
      out.push({ path, group, file: file.replace(/\.md$/, ''), text, rules });
    }
  }
  return out;
}

const all = pages();

describe('the plan function reference', () => {
  it('has a page for every function, in its kind\'s group, taking the arguments the engine accepts', () => {
    const db = Database.openMemory();
    const fns = [...db.catalog.functions(), ...UNLISTED].map((f) => ({ name: f.name, kind: f.kind, min: f.minArgs, max: f.maxArgs ?? Infinity }));
    db.close();
    const documented = new Map<string, { page: Page; arity: [number, number] }>();
    for (const p of all) for (const [name, a] of p.rules) documented.set(`${kindOf(p.group)} ${name}`, { page: p, arity: a });
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const f of fns) {
      const d = documented.get(`${f.kind} ${f.name}`);
      if (!d) {
        missing.push(`${f.kind} ${f.name}`);
        continue;
      }
      // count(*): a star with no arguments counts as the arguments it takes.
      if (d.arity[0] !== f.min || d.arity[1] !== f.max) wrong.push(`${d.page.path}: ${f.name} takes ${f.min} to ${f.max} arguments, the diagram ${d.arity[0]} to ${d.arity[1]}`);
      documented.delete(`${f.kind} ${f.name}`);
    }
    expect(missing, 'functions without a page').toEqual([]);
    expect(wrong).toEqual([]);
    expect([...documented.keys()], 'pages for functions the engine has not').toEqual([]);
  });

  it('gives every page the reference entry\'s shape', () => {
    const site = loadGrammar();
    const problems: string[] = [];
    for (const p of all) {
      const want = (ok: boolean, what: string): void => void (ok || problems.push(`${p.path}: ${what}`));
      want(p.rules.size > 0, 'a syntax diagram (an ebnf fence) of the call');
      want(p.rules.has(p.file), `a diagram of ${p.file}, the page's name`);
      for (const name of p.rules.keys()) want(!site.rules.has(name), `${name} is a rule of the plan grammar too: the page would redraw it`);
      want(/^---\ndescription: .+\n---\n/.test(p.text), 'a description in its front matter');
      want(/^# .+$/m.test(p.text), 'a title');
      for (const h of ['Parameters', 'Returns', 'Examples', 'Demo', 'See also']) want(new RegExp(`^## ${h}$`, 'm').test(p.text), `a section ## ${h}`);
      const examples = /^## Examples$([\s\S]*?)^## /m.exec(p.text)?.[1] ?? '';
      want(/```json\n[\s\S]*?```\s*\n\|/.test(examples), 'an example (a json fence) with its result table');
      const demo = /^## Demo$([\s\S]*?)(^## |$(?![\s\S]))/m.exec(p.text)?.[1] ?? '';
      want(/```json\n[\s\S]*?```\s*\n\|/.test(demo), 'a demo (a json fence) with its result table');
    }
    expect(problems).toEqual([]);
  });

  it('lists every page on its group\'s page', () => {
    const problems: string[] = [];
    for (const group of new Set(all.map((p) => p.group))) {
      const index = readFileSync(join(DIR, group, 'index.md'), 'utf8');
      const listed = [...index.matchAll(/^- \[`(.+?)`\]\(\.\/([\w-]+)\): \S/gm)].map((m) => m[2]);
      const files = all.filter((p) => p.group === group).map((p) => p.file);
      if (JSON.stringify([...listed].sort()) !== JSON.stringify([...files].sort())) problems.push(`${group}: lists ${listed.join(', ')}; pages ${files.join(', ')}`);
    }
    const overview = readFileSync(join(DIR, 'index.md'), 'utf8');
    for (const group of new Set(all.map((p) => p.group))) if (!overview.includes(`(./${group}/)`)) problems.push(`the overview doesn't link ${group}`);
    expect(problems).toEqual([]);
  });
});
