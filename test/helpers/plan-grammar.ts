/**
 * The plan language's grammar (docs/grammar.ebnf) as a checker of JSON: whether a statement, a plan or an expression
 * written as JSON matches a rule. The grammar is written for people (and syntax diagrams), so this reads its
 * conventions rather than tokens: a terminal that starts with `{` opens an object and names its first field
 * (`'{"op": "scan"'`), a terminal `', "table":'` names the next field, whose value is the next item, and `'}'` closes
 * the object. Fields match in any order. `'[' … ']'` is an array; other terminals are JSON values (`'"inner"'`,
 * `'null'`). The tokens `string`, `integer`, `number`, `boolean`, `json` and `object` are JSON's own values, and `type`
 * is a plan type name.
 */
import { readFileSync } from 'node:fs';
import { type Grammar, type Node, parseEbnf } from '../../docs/.vitepress/theme/railroad.js';
import { isPlanTypeName } from '../../src/shared/nested-types.js';

export const GRAMMAR_FILE = 'docs/grammar.ebnf';

export function loadGrammar(): Grammar {
  return parseEbnf(readFileSync(GRAMMAR_FILE, 'utf8'));
}

/** A field of an object rule: its name and the node its value matches. */
interface Field {
  readonly key: string;
  readonly value: Node;
}

const KEY = /^[{,]\s*"([^"]+)":\s*(.*)$/s;
const isOpen = (n: Node): boolean => n.t === 'term' && n.text.startsWith('{');
const isClose = (n: Node): boolean => n.t === 'term' && n.text === '}';
const term = (text: string): Node => ({ t: 'term', text });

/** Builtin tokens, and what they match. */
const TOKENS: Readonly<Record<string, (v: unknown) => boolean>> = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number',
  boolean: (v) => typeof v === 'boolean',
  json: () => true,
  object: (v) => !!v && typeof v === 'object' && !Array.isArray(v),
  type: (v) => typeof v === 'string' && isPlanTypeName(v),
};

export class GrammarMatcher {
  private readonly objects = new Map<Node, Map<string, Field[][]>>();

  constructor(readonly grammar: Grammar) {}

  /** Whether `value` matches rule `name`. */
  matches(name: string, value: unknown): boolean {
    return this.value({ t: 'ref', name }, value);
  }

  /**
   * Why `value` doesn't match rule `name`, as the path of the deepest part that matched no rule (or null when it
   * matches). A best effort, for test messages.
   */
  explain(name: string, value: unknown): string | null {
    if (this.matches(name, value)) return null;
    let worst = '';
    const walk = (v: unknown, path: string): void => {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>;
        const kind = typeof o.op === 'string' ? o.op : typeof o.k === 'string' ? o.k : undefined;
        if (kind !== undefined) {
          const rule = kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
          if (this.grammar.rules.has(rule) && !this.matches(rule, v)) worst = `${path} (${rule}: fields ${Object.keys(o).join(', ')})`;
        }
        for (const k of Object.keys(o)) walk(o[k], `${path}.${k}`);
      }
    };
    walk(value, '$');
    return worst || '$';
  }

  private rule(name: string): Node | undefined {
    return this.grammar.rules.get(name);
  }

  /** Whether `v` matches value node `n`. */
  private value(n: Node, v: unknown): boolean {
    switch (n.t) {
      case 'ref': {
        const token = TOKENS[n.name];
        if (token) return token(v);
        const r = this.rule(n.name);
        if (!r) throw new Error(`grammar: no rule ${n.name}`);
        return this.value(r, v);
      }
      case 'term':
        if (n.text === '"' || isOpen(n)) throw new Error(`grammar: ${n.text} is not a value`);
        return JSON.stringify(v) === JSON.stringify(JSON.parse(n.text));
      case 'choice':
        return n.items.some((i) => this.value(i, v));
      case 'seq': {
        const first = n.items[0];
        if (first.t === 'term' && first.text === '[') return Array.isArray(v) && this.array(n.items.slice(1, -1), v);
        if (isOpen(first)) return this.object(n, v);
        throw new Error(`grammar: a sequence that is not an array or an object: ${JSON.stringify(n)}`);
      }
      default:
        throw new Error(`grammar: ${n.t} is not a value`);
    }
  }

  /** Whether the elements of `v` match the items between an array's brackets. */
  private array(items: Node[], v: readonly unknown[]): boolean {
    const parts: { node: Node; min: number; max: number }[] = [];
    for (const i of items) {
      if (i.t === 'term' && i.text === ',') continue;
      if (i.t === 'rep') parts.push({ node: i.item, min: 1, max: Infinity });
      else if (i.t === 'opt' && i.item.t === 'rep') parts.push({ node: i.item.item, min: 0, max: Infinity });
      else if (i.t === 'opt') parts.push({ node: i.item, min: 0, max: 1 });
      else parts.push({ node: i, min: 1, max: 1 });
    }
    const go = (p: number, at: number): boolean => {
      if (p === parts.length) return at === v.length;
      const { node, min, max } = parts[p];
      let n = 0;
      while (n < min) {
        if (at + n >= v.length || !this.value(node, v[at + n])) return false;
        n++;
      }
      for (;;) {
        if (go(p + 1, at + n)) return true;
        if (n >= max || at + n >= v.length || !this.value(node, v[at + n])) return false;
        n++;
      }
    };
    return go(0, 0);
  }

  /** Whether `v` is an object that matches the object rule `n` (a sequence from `{` to `}`). */
  private object(n: Node, v: unknown): boolean {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    let shapes = this.objects.get(n);
    if (!shapes) {
      shapes = new Map();
      for (const fields of this.fields(n)) {
        const sig = fields.map((f) => f.key).sort().join(',');
        const list = shapes.get(sig);
        if (list) list.push(fields);
        else shapes.set(sig, [fields]);
      }
      this.objects.set(n, shapes);
    }
    const o = v as Record<string, unknown>;
    const candidates = shapes.get(Object.keys(o).sort().join(',')) ?? [];
    return candidates.some((fields) => fields.every((f) => this.value(f.value, o[f.key])));
  }

  /** The field lists an object rule allows: one per way through its options and choices. */
  private fields(n: Node): Field[][] {
    const out = this.expand(n, null).filter((a) => a.pending === null && a.closed);
    if (out.length === 0) throw new Error(`grammar: an object rule that never closes: ${JSON.stringify(n).slice(0, 200)}`);
    return out.map((a) => a.fields);
  }

  /**
   * The ways through `n` in field position: the fields each gives, and the field name still waiting for its value
   * (`pending`) after it. A reference in field position is a group of fields (as `op-meaning`): its rule is read in
   * place.
   */
  private expand(n: Node, pending: string | null): { fields: Field[]; pending: string | null; closed: boolean }[] {
    switch (n.t) {
      case 'skip':
        return [{ fields: [], pending, closed: false }];
      case 'term': {
        if (pending !== null) return [{ fields: [{ key: pending, value: n }], pending: null, closed: false }];
        if (isClose(n)) return [{ fields: [], pending: null, closed: true }];
        const m = KEY.exec(n.text);
        if (!m) throw new Error(`grammar: ${n.text} where a field was expected`);
        const [, key, fixed] = m;
        if (fixed.trim() === '') return [{ fields: [], pending: key, closed: false }];
        return [{ fields: [{ key, value: term(fixed.trim()) }], pending: null, closed: false }];
      }
      case 'ref': {
        if (pending !== null) return [{ fields: [{ key: pending, value: n }], pending: null, closed: false }];
        const r = this.rule(n.name);
        if (!r) throw new Error(`grammar: no rule ${n.name}`);
        return this.expand(r, null);
      }
      case 'choice':
        return n.items.flatMap((i) => this.expand(i, pending));
      case 'opt':
        return [{ fields: [], pending, closed: false }, ...this.expand(n.item, pending)];
      case 'rep':
        throw new Error('grammar: a repeat in field position');
      case 'seq': {
        // An array or an object as a value: its items from the opening bracket to the closing one.
        let ways: { fields: Field[]; pending: string | null; closed: boolean }[] = [{ fields: [], pending, closed: false }];
        const items = n.items;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const next: typeof ways = [];
          let consumed = i;
          for (const w of ways) {
            if (w.pending !== null && item.t === 'term' && (item.text === '[' || isOpen(item))) {
              const opens = item.text === '[' ? (x: Node) => x.t === 'term' && x.text === '[' : isOpen;
              const closes = item.text === '[' ? (x: Node) => x.t === 'term' && x.text === ']' : (x: Node) => x.t === 'term' && x.text.endsWith('}');
              let depth = 0;
              let j = i;
              for (; j < items.length; j++) {
                if (opens(items[j])) depth++;
                if (closes(items[j])) depth--;
                if (depth === 0) break;
              }
              if (j === items.length) throw new Error(`grammar: ${item.text} without its close`);
              next.push({ fields: [...w.fields, { key: w.pending, value: { t: 'seq', items: items.slice(i, j + 1) } }], pending: null, closed: false });
              consumed = j;
            } else {
              for (const x of this.expand(item, w.pending)) next.push({ fields: [...w.fields, ...x.fields], pending: x.pending, closed: w.closed || x.closed });
            }
          }
          i = consumed;
          ways = next;
        }
        return ways;
      }
    }
  }
}

/** The kinds of operation and expression the plan types define (plan/ops.ts, plan/expr.ts). */
export function planKinds(): { ops: string[]; exprs: string[] } {
  const ops = [...readFileSync('src/engine/plan/ops.ts', 'utf8').matchAll(/readonly op: '(\w+)'/g)].map((m) => m[1]);
  const expr = readFileSync('src/engine/plan/expr.ts', 'utf8');
  const union = /export type PlanExpr =([\s\S]*?);/.exec(expr)![1];
  const names = [...new Set([...union.matchAll(/(\w+)Expr\b/g)].map((m) => m[1]))].filter((n) => n !== 'Plan');
  const exprs: string[] = [];
  for (const n of names) {
    const def = new RegExp(`interface ${n}Expr\\b[^{]*\\{[^]*?readonly k: ([^;]+);`).exec(expr);
    if (!def) throw new Error(`no interface ${n}Expr`);
    for (const m of def[1].matchAll(/'(\w+)'/g)) exprs.push(m[1]);
  }
  return { ops: [...new Set(ops)], exprs: [...new Set(exprs)] };
}

/** A plan kind's rule name: `graphCreate` is `graph-create`. */
export const ruleName = (kind: string): string => kind.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
