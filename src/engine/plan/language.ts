/**
 * The language interface (ADR 0015 section 3): what a language gives the engine so that the engine never reads its
 * syntax. A language binds its statements to plans (plan/bound.ts) against the logical catalog (plan/bind-context.ts);
 * the engine keeps views and materialized views as their language's source and asks the language for what it needs
 * of them.
 *
 * Languages register with the engine (`registerLanguage`); engine code never imports one. smaltdb's entry points
 * The engine carries none: SQL is smaltql's, which registers itself (`import 'smaltql/register'`) or through a worker
 * entry (`defineWorker({ languages })`), ADR 0015.
 */
import type { CatalogTable } from './catalog.js';
import type { SqlValue } from '../values.js';
import type { BindContext } from './bind-context.js';
import type { BoundQuery, BoundStatement } from './bound.js';
import type { PlanExpr } from './expr.js';
import type { Source, SourceEditor } from './schema.js';

/** A table or view a query names. */
export interface ObjectReference {
  readonly name: string;
  readonly schema?: string;
}

/**
 * A statement of a language, parsed and not yet bound: the engine binds it (again after schema changes) and runs what
 * it binds to.
 */
export interface LanguageStatement {
  /** The statement's source text. */
  readonly text: string;
  /** Its parameters: positions 1 … `paramCount`. */
  readonly paramCount: number;
  /** Parameters with names, by the name as written (SQL: `:min`, `$min`, `@min`), at their 1-based position. */
  readonly paramNames: ReadonlyMap<string, number>;
  /** The statement bound against the catalog. */
  bind(ctx: BindContext): BoundStatement;
  /**
   * Table functions the statement calls with constant arguments (`read_csv('…')`): the engine fetches their data
   * before binding, all together. Optional: other calls are found while binding.
   */
  externalCalls?(): readonly { readonly name: string; readonly args: readonly SqlValue[]; readonly named: Readonly<Record<string, SqlValue>> }[];
}

export interface SmaltLanguage {
  /** The language's name, as sources record it (`sql`). */
  readonly name: string;
  /** Source text as its statements (a script), parsed. Throws the language's syntax error. */
  parse(source: string): LanguageStatement[];
  /** Source text that must hold exactly one statement. */
  parseOne(source: string): LanguageStatement;
  /**
   * The CHECK and DEFAULT expressions of a stored table that its definition holds unbound (a DEFAULT naming a function
   * that did not exist when the table was made), bound from the table's source (`table.source`) where first used.
   */
  bindTableExprs(table: CatalogTable, ctx: BindContext): { checks: PlanExpr[]; defaults: (PlanExpr | null)[] };
  /** A stored view's or materialized view's query (its CREATE statement's source), bound where it is read. */
  bindView(source: Source, ctx: BindContext): BoundQuery;
  /**
   * The tables and views a view's query names, directly (not through other views), read from its source without
   * binding: a view may name tables that do not exist yet.
   */
  viewReferences(source: Source): readonly ObjectReference[];
  /** The text of a view's query alone, for display (`information_schema.views.view_definition`). */
  viewDefinition(source: Source): string;
  /** Edits the source texts kept beside definitions when ALTER TABLE changes them. */
  readonly sourceEditor: SourceEditor;
}

const registered = new Map<string, SmaltLanguage>();

/** Makes `language` available to every database, by its name: statements, views and stored objects written in it. */
export function registerLanguage(language: SmaltLanguage): void {
  registered.set(language.name, language);
}

/** The language registered as `name`, if any. */
export function registeredLanguage(name: string): SmaltLanguage | undefined {
  return registered.get(name);
}
