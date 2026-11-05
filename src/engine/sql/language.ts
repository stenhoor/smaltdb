/**
 * SQL as a language of the engine (ADR 0015 section 3, plan/language.ts): views written in SQL bound to plans, the
 * names they read, their query text, and the source editor ALTER TABLE uses.
 */
import type { LanguageStatement, ObjectReference, SmaltLanguage } from '../language-support.js';
import type { BindContext } from '../language-support.js';
import type { BoundStatement } from '../language-support.js';
import type { SqlValue } from '../language-support.js';
import type { ParsedStatement, SelectStmt } from './ast.js';
import { bindStatement } from './frontend/bind.js';
import { bindStoredTableExprs } from './frontend/ddl.js';
import { toPlan } from './frontend/select.js';
import { parse, parseOne } from './parser.js';
import { sqlSourceEditor } from './frontend/source-edit.js';
import { viewSelect } from './frontend/views.js';

/** A SQL statement as the engine holds it: the parse tree stays SQL's. */
export class SqlStatement implements LanguageStatement {
  constructor(readonly parsed: ParsedStatement) {}

  get text(): string {
    return this.parsed.text;
  }

  get paramCount(): number {
    return this.parsed.paramCount;
  }

  get paramNames(): ReadonlyMap<string, number> {
    return this.parsed.paramNames;
  }

  bind(ctx: BindContext): BoundStatement {
    return bindStatement(this.parsed, ctx);
  }

  /** `read_csv('…')`-style calls whose arguments are all literals (`isExternal` says which functions read data). */
  externalCalls(): { name: string; args: SqlValue[]; named: Record<string, SqlValue> }[] {
    const out: { name: string; args: SqlValue[]; named: Record<string, SqlValue> }[] = [];
    const lit = (e: { kind: string; value?: SqlValue }): boolean => e.kind === 'literal';
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (typeof x !== 'object' || x === null || Object.getPrototypeOf(x) !== Object.prototype) return;
      const o = x as Record<string, unknown>;
      if (o.kind === 'function' && typeof o.name === 'string') {
        const f = o as unknown as { name: string; args: { kind: string; value?: SqlValue }[]; named?: Record<string, { kind: string; value?: SqlValue }> };
        const named = Object.entries(f.named ?? {});
        if (f.args.every(lit) && named.every(([, e]) => lit(e))) out.push({ name: f.name, args: f.args.map((a) => a.value!), named: Object.fromEntries(named.map(([k, e]) => [k, e.value!])) });
      }
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(this.parsed.stmt);
    return out;
  }
}

export const sqlLanguage: SmaltLanguage = {
  name: 'sql',
  parse: (source) => parse(source).map((ps) => new SqlStatement(ps)),
  parseOne: (source) => new SqlStatement(parseOne(source)),
  bindStoredExprs: (table, ctx) => bindStoredTableExprs(table, ctx),
  bindView(source, ctx) {
    const r = toPlan(viewSelect(source), source.text, ctx);
    return { kind: 'query', plan: r.plan, columns: r.columns };
  },
  viewReferences: (source) => selectReferences(viewSelect(source)),
  viewDefinition: (source) => {
    const s = viewSelect(source);
    return source.text.slice(s.pos, s.end);
  },
  sourceEditor: sqlSourceEditor,
};

/**
 * The tables and views a SELECT names (not through views). CTE references are left out where the CTE is in scope: a
 * CTE's name is visible to the CTEs after it and to the statement body, and inside its own body only when it is
 * RECURSIVE (otherwise `WITH t AS (SELECT * FROM t)` reads the table t).
 */
export function selectReferences(select: SelectStmt): ObjectReference[] {
  const out: ObjectReference[] = [];
  const visit = (x: unknown, ctes: ReadonlySet<string>): void => {
    if (Array.isArray(x)) {
      for (const y of x) visit(y, ctes);
      return;
    }
    if (typeof x !== 'object' || x === null || x instanceof Uint8Array) return;
    const o = x as Record<string, unknown>;
    if (o.kind === 'select' && 'core' in o && o.with) {
      const w = o.with as { recursive: boolean; ctes: { name: string; select: SelectStmt }[] };
      const inner = new Set(ctes);
      if (w.recursive) for (const c of w.ctes) inner.add(c.name.toLowerCase());
      for (const c of w.ctes) {
        visit(c.select, inner);
        inner.add(c.name.toLowerCase());
      }
      for (const [k, v] of Object.entries(o)) if (k !== 'with') visit(v, inner);
      return;
    }
    if (o.kind === 'table' && typeof o.name === 'string' && (o.schema || !ctes.has(o.name.toLowerCase()))) {
      out.push(typeof o.schema === 'string' ? { name: o.name, schema: o.schema } : { name: o.name });
    }
    for (const v of Object.values(o)) visit(v, ctes);
  };
  visit(select, new Set());
  return out;
}
