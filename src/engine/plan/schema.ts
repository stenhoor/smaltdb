/**
 * Schema definitions and operations, language-neutral (ADR 0015 section 5): what a language hands the engine for DDL.
 * Expressions are plan expressions (CHECK and index expressions over the table's row: column `i` is `#0.i`, the rowid
 * `#0.n`; DEFAULT over no columns), with their source text kept for display (PRAGMA table_info, information_schema,
 * error messages). `source` is the statement in its language, which the catalog stores until it stores these
 * definitions themselves (ADR 0015 step 7).
 */
import type { SqlValue } from '../values.js';
import type { PlanExpr } from './expr.js';
import type { ConflictAction } from './ops.js';
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
export type StorageType = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'ANY' | 'NUMERIC';

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
}

export interface CheckDef extends ExprDef {
  readonly name?: string;
}

export interface TableDef {
  readonly name: string;
  readonly columns: readonly ColumnDef[];
  readonly keys: readonly KeyDef[];
  readonly checks: readonly CheckDef[];
  readonly foreignKeys: readonly ForeignKeyDef[];
  readonly storage: 'row' | 'columnar';
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
