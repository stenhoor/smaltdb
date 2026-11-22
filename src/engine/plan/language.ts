/**
 * The language interface (ADR 0015 section 3): what a language gives the engine so that the engine never reads its
 * syntax. A language binds its statements to plans (plan/bound.ts) against the logical catalog (plan/bind-context.ts);
 * the engine keeps views and materialized views as their language's source and asks the language for what it needs
 * of them.
 *
 * Languages register with the engine (`registerLanguage`); engine code never imports one. smaltdb's entry points
 * The engine carries none: SQL is smaltql's, which registers itself (`import '@smaltworks/smaltql/register'`) or through a worker
 * entry (`defineWorker({ languages })`), ADR 0015.
 */
import { type ErrorToWord, SmaltError } from '../errors.js';
import type { CatalogTable } from './catalog.js';
import type { SqlValue } from '../values.js';
import type { BindContext } from './bind-context.js';
import type { BoundQuery, BoundStatement } from './bound.js';
import type { PlanStatementInput } from './statement.js';
import type { PlanExpr } from './expr.js';
import type { Source, SourceEditor } from './schema.js';

/** A table or view a query names. */
export interface ObjectReference {
  readonly name: string;
  readonly schema?: string;
}

/**
 * A value a statement is run with, as it is given: a scalar, or, for a parameter the statement reads as a list, struct
 * or map, a JS array, object or `Map`.
 */
export type StatementValue = SqlValue | boolean | undefined | readonly unknown[] | { readonly [field: string]: unknown } | ReadonlyMap<string, unknown>;
/** The values a statement is run with: by position, or by name. */
export type StatementParams = readonly StatementValue[] | Readonly<Record<string, StatementValue>>;

/**
 * A statement's shape (ADR 0042, section 4): what is left of it with the values written in it taken out. Statements
 * of one shape bind to the same statement, which reads the values taken out as the parameters after the statement's
 * own. So the engine keeps what the first statement of a shape bound to, and runs it for the next one with that one's
 * values, without binding it. What a statement's shape is, is its language's to say.
 */
export interface StatementShape {
  /** A number statements of one shape share: a hash of the shape. */
  readonly hash: number;
  /** The values taken out, in the order of the parameters that read them: positions `paramCount + 1` on. */
  readonly values: readonly SqlValue[];
  /** Whether `other`, a statement of the same language whose shape has this hash, has this shape. */
  same(other: LanguageStatement): boolean;
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
  /**
   * The statement bound against the catalog: a bound statement in the engine's terms, or, from a language whose
   * statements are plan data (`SmaltLanguage.plans`), a plan statement as `Database.preparePlan` takes one. `params`:
   * the values it is to run with, given where the statement has a {@link variant}; without them it binds for values it
   * knows nothing of.
   */
  bind(ctx: BindContext, params?: StatementParams): BoundStatement | PlanStatementInput;
  /**
   * For a statement that binds differently for different values (a language that compares a parameter as a value of
   * its kind binds a comparison with a text and one with a number differently): a key that is the same for values it
   * binds the same for. The engine keeps what it bound for each key, and gives `bind` the values.
   */
  variant?(params: StatementParams | undefined): string | number;
  /** Its shape, where the language takes the values written in a statement out of it. */
  readonly shape?: StatementShape;
  /**
   * Table functions the statement calls with constant arguments (`read_csv('…')`): the engine fetches their data
   * before binding, all together. Optional: other calls are found while binding.
   */
  externalCalls?(): readonly { readonly name: string; readonly args: readonly SqlValue[]; readonly named: Readonly<Record<string, SqlValue>> }[];
}

/**
 * A language, by what it provides (ADR 0016 section 6): text it binds (`parse`, `parseOne`), the objects it stores
 * (`bindTableExprs`, `bindView`, `viewReferences`, `viewDefinition`, `sourceEditor`), and its words for errors. Each part
 * is optional: a language provides what it uses. One that writes no text has no parser; one whose views are its own
 * serialized source (not text it parses) provides the stored-object part alone. Using a part a language lacks is a
 * `SMALT_MISUSE` error that names the language and the part.
 */
export interface SmaltLanguage {
  /** The language's name, as sources record it (`sql`). */
  readonly name: string;
  /**
   * `'data'`: its statements bind to plan data, built with the plan builders as a plan given to `Database.preparePlan`
   * is (a query's columns may be left to the engine). The engine validates and normalizes what they bind to, as it
   * does there. Left out by a language whose binder gives the engine's own terms, as SQL's does.
   */
  readonly plans?: 'data';
  /** Source text as its statements (a script), parsed. Throws the language's syntax error. */
  parse?(source: string): LanguageStatement[];
  /** Source text that must hold exactly one statement. */
  parseOne?(source: string): LanguageStatement;
  /**
   * The CHECK and DEFAULT expressions of a stored table that its definition holds unbound (a DEFAULT naming a function
   * that did not exist when the table was made), bound from the table's source (`table.source`) where first used.
   */
  bindTableExprs?(table: CatalogTable, ctx: BindContext): { checks: PlanExpr[]; defaults: (PlanExpr | null)[] };
  /**
   * The message for an error a statement written in this language raised, from its code, the engine's message and its
   * fields (`constraint`, `table`, `columns`, `name`, `origin`); undefined keeps the engine's message (ADR 0016
   * section 10).
   */
  errorMessage?(error: ErrorToWord): string | undefined;
  /** A stored view's or materialized view's query (its CREATE statement's source), bound where it is read. */
  bindView?(source: Source, ctx: BindContext): BoundQuery;
  /**
   * The tables and views a view's query names, directly (not through other views), read from its source without
   * binding: a view may name tables that do not exist yet.
   */
  viewReferences?(source: Source): readonly ObjectReference[];
  /** The text of a view's query alone, for display (`information_schema.views.view_definition`). */
  viewDefinition?(source: Source): string;
  /** Edits the source texts kept beside definitions when ALTER TABLE changes them. */
  readonly sourceEditor?: SourceEditor;
  /**
   * A parameter of one of its statements as the language means it, after the engine's own conversions (booleans to
   * 1 / 0, bigints checked). SQL gives NaN as NULL, as SQLite binds it (ADR 0018); plans' parameters keep NaN.
   */
  parameter?(value: SqlValue): SqlValue;
}

/** The parts of a language, as {@link languagePart} names them in its error. */
const PARTS = {
  parse: 'parse text',
  parseOne: 'parse text',
  bindTableExprs: "bind its tables' expressions",
  bindView: 'bind views',
  viewReferences: "read views' references",
  viewDefinition: 'describe views',
  sourceEditor: "edit its objects' source text",
} as const;

/** A part of `language` it must provide here: a method bound to it, or its source editor. */
export function languagePart<K extends keyof typeof PARTS>(language: SmaltLanguage, part: K): NonNullable<SmaltLanguage[K]> {
  const member = language[part];
  if (member === undefined) throw new SmaltError('SMALT_MISUSE', `the ${language.name} language does not ${PARTS[part]}`);
  return (typeof member === 'function' ? (member as (...a: never[]) => unknown).bind(language) : member) as NonNullable<SmaltLanguage[K]>;
}

/** `source`, which must hold exactly one statement, parsed by `language`. */
export function parseOneWith(language: SmaltLanguage, source: string): LanguageStatement {
  // Called for every statement prepared: the language's own method, with no function made to hold it.
  return language.parseOne !== undefined ? language.parseOne(source) : languagePart(language, 'parseOne')(source);
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
