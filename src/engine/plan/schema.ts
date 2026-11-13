/**
 * Schema definitions and operations, language-neutral (ADR 0015 section 5): what a language hands the engine for DDL.
 * Expressions are plan expressions (CHECK and index expressions over the table's row: column `i` is `#0.i`, the rowid
 * `#0.n`; DEFAULT over no columns), with their source text kept for display (PRAGMA table_info, information_schema,
 * error messages). `source` is the statement in its language: the catalog stores it beside the definition, for
 * display (catalog/stored.ts).
 */
import type { SqlValue } from '../values.js';
import type { PlanExpr } from './expr.js';
import type { ConflictAction, PlanOp } from './ops.js';
import type { CollationName } from './types.js';

/** An expression of a definition: its plan expression and its text. */
export interface ExprDef {
  /** The source text, as written. */
  readonly text: string;
  /**
   * The bound expression. Absent when it could not be bound when the definition was made (a DEFAULT naming a
   * function that does not exist yet, as SQLite allows): the engine binds the source when the expression is used.
   */
  readonly expr?: PlanExpr;
}

/** A column's DEFAULT: an expression over no columns, and its value when constant (for rows older than the column). */
export interface DefaultDef extends ExprDef {
  readonly value: SqlValue;
}

/** How values are stored: SQLite's type affinities, strictly (smaltdb tables are STRICT). */
/** `BOOLEAN` (ADR 0018) holds 0 and 1; its plan type is `bool`. `DATE`, `TIME`, `DATETIME`, `DURATION` (ADR 0019) hold days and µs. */
export type StorageType = 'INTEGER' | 'BOOLEAN' | 'DATE' | 'TIME' | 'DATETIME' | 'DURATION' | 'LIST' | 'STRUCT' | 'REAL' | 'TEXT' | 'BLOB' | 'ANY' | 'NUMERIC';

export interface ColumnDef {
  readonly name: string;
  /** The declared type as written (normalized), '' when none. */
  readonly declaredType: string;
  readonly type: StorageType;
  readonly notNull: boolean;
  /** The resolution of a NOT NULL violation when the statement gives none. */
  readonly notNullConflict?: ConflictAction;
  readonly collation: CollationName;
  readonly default?: DefaultDef;
}

/** A key column: a table column, its order and collation. */
export interface KeyColumnDef {
  readonly column: number;
  readonly desc: boolean;
  readonly collation: CollationName;
}

/** A PRIMARY KEY or UNIQUE constraint, in declaration order (automatic indexes are numbered in this order). */
export interface KeyDef {
  readonly kind: 'primaryKey' | 'unique';
  readonly columns: readonly KeyColumnDef[];
  readonly name?: string;
  readonly onConflict?: ConflictAction;
  /** PRIMARY KEY … AUTOINCREMENT. */
  readonly autoincrement?: boolean;
  /** Declared as a constraint of this column (dropped with it); absent for a table constraint. */
  readonly ofColumn?: number;
}

export type FkAction = 'SET NULL' | 'SET DEFAULT' | 'CASCADE' | 'RESTRICT' | 'NO ACTION';

export interface ForeignKeyDef {
  readonly name?: string;
  /** Child column indexes. */
  readonly columns: readonly number[];
  /** Parent table name as written. */
  readonly table: string;
  /** Parent column names; absent: the parent's primary key. */
  readonly refColumns?: readonly string[];
  readonly onDelete: FkAction;
  readonly onUpdate: FkAction;
  /** Checked at COMMIT (DEFERRABLE INITIALLY DEFERRED). */
  readonly deferrable: boolean;
  /** Declared DEFERRABLE, with either INITIALLY clause. */
  readonly isDeferrable: boolean;
  /** Declared as a constraint of this column (dropped with it); absent for a table constraint. */
  readonly ofColumn?: number;
}

export interface CheckDef extends ExprDef {
  readonly name?: string;
  /** Declared as a constraint of this column (dropped with it); absent for a table constraint. */
  readonly ofColumn?: number;
}

export interface TableDef {
  readonly name: string;
  readonly columns: readonly ColumnDef[];
  readonly keys: readonly KeyDef[];
  readonly checks: readonly CheckDef[];
  readonly foreignKeys: readonly ForeignKeyDef[];
  readonly storage: 'row' | 'columnar';
  /**
   * For a table defined without source text: the registered language its expression texts (CHECKs, defaults, and its
   * indexes' expressions) are written in. A column rename edits them with that language's `sourceEditor`
   * (`renameColumnInExpr`); without one they stay as given (the expressions, bound by column position, still hold).
   */
  readonly exprLanguage?: string;
}

/** An index column: a table column (`column` ≥ 0) or an expression over the row (`column` -1). */
export interface IndexColumnDef {
  readonly column: number;
  readonly expr?: ExprDef;
  readonly desc: boolean;
  readonly collation: CollationName;
}

export interface IndexDef {
  readonly name: string;
  readonly table: string;
  readonly columns: readonly IndexColumnDef[];
  readonly unique: boolean;
  /** A partial index's WHERE, over the table's row. */
  readonly where?: ExprDef;
}

/** A statement in a language, as written. */
export interface Source {
  readonly language: string;
  readonly text: string;
}

/** What DROP removes. */
export type DropObject = 'table' | 'index' | 'view' | 'materialized view' | 'trigger' | 'external table' | 'connection';

/**
 * A schema operation (ADR 0015 section 5): what a language's DDL becomes. Views and materialized views are kept as their
 * language's source, bound where they are read (section 6). ALTER TABLE changes the stored definitions; the source
 * texts shown beside them are edited by their language ({@link SourceEditor}).
 *
 * `source` is optional except on views (ADR 0016 section 6). Without it the engine stores the definition alone, shows
 * a neutral description of it where the source text would be (the definition as JSON), and ALTER TABLE changes the
 * definition without asking any language. Such a definition's expressions must be bound (`expr`): there is no text to
 * bind them from later.
 */
export type SchemaOp =
  | {
      readonly op: 'createTable';
      readonly table: TableDef;
      readonly schema?: string;
      readonly temp: boolean;
      readonly ifNotExists: boolean;
      readonly source?: Source;
      /**
       * Rows to fill the new table with (SQL's CREATE TABLE … AS SELECT): a query plan with one output column per
       * table column, appended in the same statement, so a failure leaves no table. Not with `ifNotExists` when the
       * table exists: then nothing is created or appended.
       */
      readonly rows?: PlanOp;
    }
  | { readonly op: 'createIndex'; readonly index: IndexDef; readonly schema?: string; readonly ifNotExists: boolean; readonly source?: Source }
  | {
      readonly op: 'createView';
      readonly name: string;
      readonly schema?: string;
      readonly temp: boolean;
      readonly ifNotExists: boolean;
      /** Result column names given with the view, if any. */
      readonly columns?: readonly string[];
      readonly materialized: boolean;
      /** Materialized views: their options (storage, location, refresh policy), and whether to fill them now. */
      readonly options?: Readonly<Record<string, SqlValue>>;
      readonly withData?: boolean;
      readonly source: Source;
    }
  | { readonly op: 'createConnection'; readonly name: string; readonly ifNotExists: boolean; readonly options: Readonly<Record<string, SqlValue>>; readonly source?: Source }
  | {
      readonly op: 'createExternalTable';
      readonly name: string;
      readonly ifNotExists: boolean;
      /** Declared columns (empty: inferred from the source when the table is created). */
      readonly columns: readonly { readonly name: string; readonly declaredType: string; readonly constrained: boolean }[];
      readonly options: Readonly<Record<string, SqlValue>>;
      readonly source?: Source;
    }
  /**
   * `cascade` (ADR 0027, decision 4): the views whose interface the operation breaks are dropped with it (and listed in
   * its result as `cascaded`); without it, the operation is refused.
   */
  | { readonly op: 'drop'; readonly objectType: DropObject; readonly name: string; readonly schema?: string; readonly ifExists: boolean; readonly cascade?: boolean }
  | { readonly op: 'alterTable'; readonly table: string; readonly schema?: string; readonly action: AlterAction; readonly source?: Source; readonly cascade?: boolean };

/** A language's statement check that the engine reports after its own (which come first, as SQLite orders them). */
export interface DeferredError {
  readonly code: string;
  readonly message: string;
}

/** What ALTER TABLE changes. */
export type AlterAction =
  | { readonly kind: 'renameTable'; readonly newName: string }
  | { readonly kind: 'renameColumn'; readonly column: string; readonly newName: string }
  | {
      readonly kind: 'addColumn';
      /** The new column, its constraints (CHECKs over the new row, foreign keys on it) and its source text. */
      readonly column: ColumnDef;
      readonly checks: readonly CheckDef[];
      readonly foreignKeys: readonly ForeignKeyDef[];
      readonly text: string;
      /** The column cannot be added (a key, a generated column, a non-constant default, …). */
      readonly invalid?: DeferredError;
    }
  | { readonly kind: 'dropColumn'; readonly column: string };

/**
 * How a language edits its source texts when ALTER TABLE changes a definition, so that what `sqlite_schema` shows stays
 * in step (SQLite edits the stored statements in place, keeping their formatting).
 */
export interface SourceEditor {
  /** `text` (a stored statement) with references to table `oldName` renamed. */
  renameTable(text: string, oldName: string, newName: string, columnsOf: (table: string) => ReadonlySet<string> | undefined): string;
  /** `text` (a stored statement) with references to column `oldName` of `table` renamed. */
  renameColumn(text: string, table: string, oldName: string, newName: string, columnsOf: (table: string) => ReadonlySet<string> | undefined): string;
  /** An expression of `table` (a CHECK, an index key or WHERE) with column `oldName` renamed. */
  renameColumnInExpr(text: string, table: string, oldName: string, newName: string): string;
  /** A table's statement with a column added (`columnText`, as the ALTER statement wrote it). */
  addColumn(tableText: string, columnText: string): string;
  /** A table's statement without column `column` (its position). */
  dropColumn(tableText: string, column: number): string;
  /** The statement of an external table whose columns were read from its source when it was created. */
  externalTable(name: string, columns: readonly { readonly name: string; readonly declaredType: string }[], options: Readonly<Record<string, SqlValue>>): string;
}
