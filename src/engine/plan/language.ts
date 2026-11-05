/**
 * The language interface (ADR 0015 section 3): what a language gives the engine so that the engine never reads its
 * syntax. A language binds its statements to plans (plan/bound.ts) against the logical catalog (plan/bind-context.ts);
 * the engine keeps views and materialized views as their language's source and asks the language for what it needs
 * of them.
 *
 * SQL is the only language so far (sql/language.ts); languages register with the engine in ADR 0015 step 9.
 */
import type { BindContext } from './bind-context.js';
import type { BoundQuery } from './bound.js';
import type { Source, SourceEditor } from './schema.js';

/** A table or view a query names. */
export interface ObjectReference {
  readonly name: string;
  readonly schema?: string;
}

export interface SmaltLanguage {
  /** The language's name, as sources record it (`sql`). */
  readonly name: string;
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
