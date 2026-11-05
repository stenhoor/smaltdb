/**
 * SQL abstract syntax tree (SQLite dialect + smaltdb extensions).
 *
 * The parser covers more syntax than the engine executes; unsupported constructs are rejected
 * by the binder with a clear "not supported yet" error, so the grammar is written once.
 *
 * Conventions:
 * - Identifiers are stored as written but unquoted (`"My Col"` -> `My Col`). Name resolution is
 *   case-insensitive (ASCII), as in SQLite.
 * - Keywords/type names/function names are normalized: function names lower-case, type names
 *   upper-case with whitespace collapsed (e.g. `VARCHAR(20)`).
 * - `pos` is the 0-based offset of the node's first character in the source text; `end` is the
 *   offset just past its last character.
 */
import type { SqlValue } from '../language-support.js';

export interface Node {
  pos: number;
  /**
   * Exclusive end offset: just past the node's last token, so `sql.slice(pos, end)` is its source
   * text. A parenthesized expression's span includes the parentheses (`(a+1)` covers `(a+1)`).
   */
  end: number;
}

// ------------------------------------------------------------------ expressions

export type BinaryOp =
  | '||'
  | '->'
  | '->>'
  | '*'
  | '/'
  | '%'
  | '+'
  | '-'
  | '&'
  | '|'
  | '<<'
  | '>>'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=' // also `==`
  | '!=' // also `<>`
  | 'IS'
  | 'IS NOT' // also `IS DISTINCT FROM` (as IS NOT) and `IS NOT DISTINCT FROM` (as IS)
  | 'AND'
  | 'OR';

export type UnaryOp = '-' | '+' | '~' | 'NOT';

export type Expr =
  | LiteralExpr
  | ColumnExpr
  | ParamExpr
  | UnaryExpr
  | BinaryExpr
  | BetweenExpr
  | InListExpr
  | InSelectExpr
  | LikeExpr
  | IsNullExpr
  | CaseExpr
  | CastExpr
  | CallExpr
  | SubqueryExpr
  | ExistsExpr
  | CollateExpr;

export interface LiteralExpr extends Node {
  kind: 'literal';
  /** Integer literals beyond ±(2^53-1) are bigint. TRUE/FALSE parse as 1/0. */
  value: SqlValue;
  /** True for literals written as real numbers (`1.0`, `1e3`), so `1.0` stays REAL. */
  isReal?: boolean;
}

export interface ColumnExpr extends Node {
  kind: 'column';
  /** Optional qualifier (`t.col`); `schema.t.col` stores schema too. */
  schema?: string;
  table?: string;
  name: string;
}

export interface ParamExpr extends Node {
  kind: 'param';
  /**
   * 1-based parameter slot, assigned by the parser following SQLite rules:
   * `?` takes the next slot, `?NNN` uses slot NNN, a named parameter (`:a`, `@a`, `$a`) gets a slot
   * on first appearance and reuses it afterwards.
   */
  index: number;
  /** Name including its prefix character (`:a`), absent for `?`/`?NNN`. */
  name?: string;
}

export interface UnaryExpr extends Node {
  kind: 'unary';
  op: UnaryOp;
  operand: Expr;
}

export interface BinaryExpr extends Node {
  kind: 'binary';
  op: BinaryOp;
  left: Expr;
  right: Expr;
}

export interface BetweenExpr extends Node {
  kind: 'between';
  not: boolean;
  expr: Expr;
  low: Expr;
  high: Expr;
}

export interface InListExpr extends Node {
  kind: 'inList';
  not: boolean;
  expr: Expr;
  list: Expr[];
}

export interface InSelectExpr extends Node {
  kind: 'inSelect';
  not: boolean;
  expr: Expr;
  select: SelectStmt;
}

export interface LikeExpr extends Node {
  kind: 'like';
  op: 'LIKE' | 'GLOB' | 'REGEXP' | 'MATCH';
  not: boolean;
  expr: Expr;
  pattern: Expr;
  escape?: Expr;
}

/** `x ISNULL`, `x NOTNULL`, `x NOT NULL`, `x IS NULL`, `x IS NOT NULL`. */
export interface IsNullExpr extends Node {
  kind: 'isNull';
  not: boolean;
  expr: Expr;
}

export interface CaseExpr extends Node {
  kind: 'case';
  base?: Expr;
  whens: { when: Expr; then: Expr }[];
  else?: Expr;
}

export interface CastExpr extends Node {
  kind: 'cast';
  expr: Expr;
  /** Normalized type name, e.g. `INTEGER`, `TEXT`, `VARCHAR(10)`. */
  type: string;
}

export interface CallExpr extends Node {
  kind: 'call';
  /** Lower-case function name. */
  name: string;
  args: Expr[];
  /** `count(*)` */
  star: boolean;
  distinct: boolean;
  /** Aggregate `FILTER (WHERE ...)`. */
  filter?: Expr;
  /** Window function `OVER (...)` or `OVER name`. */
  over?: WindowSpec | string;
  /** Aggregate argument ordering, e.g. `group_concat(x, ',' ORDER BY y)` (SQLite 3.44+). */
  orderBy?: OrderingTerm[];
}

export interface WindowSpec extends Node {
  base?: string;
  partitionBy: Expr[];
  orderBy: OrderingTerm[];
  frame?: {
    unit: 'ROWS' | 'RANGE' | 'GROUPS';
    start: FrameBound;
    end?: FrameBound;
    exclude?: 'NO OTHERS' | 'CURRENT ROW' | 'GROUP' | 'TIES';
  };
}

export type FrameBound =
  | { kind: 'unboundedPreceding' }
  | { kind: 'preceding'; offset: Expr }
  | { kind: 'currentRow' }
  | { kind: 'following'; offset: Expr }
  | { kind: 'unboundedFollowing' };

export interface SubqueryExpr extends Node {
  kind: 'subquery';
  select: SelectStmt;
}

export interface ExistsExpr extends Node {
  kind: 'exists';
  not: boolean;
  select: SelectStmt;
}

export interface CollateExpr extends Node {
  kind: 'collate';
  expr: Expr;
  /** Upper-case collation name. */
  collation: string;
}

// ------------------------------------------------------------------ SELECT

export interface SelectStmt extends Node {
  kind: 'select';
  with?: WithClause;
  /** First core, followed by compound operators. */
  core: SelectCore;
  compound: { op: 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT'; core: SelectCore }[];
  orderBy: OrderingTerm[];
  limit?: Expr;
  offset?: Expr;
}

export interface WithClause extends Node {
  recursive: boolean;
  ctes: { name: string; columns?: string[]; materialized?: boolean; select: SelectStmt }[];
}

export type SelectCore = SelectCoreSelect | SelectCoreValues;

export interface SelectCoreSelect extends Node {
  kind: 'select';
  distinct: boolean;
  columns: ResultColumn[];
  from?: FromItem;
  where?: Expr;
  groupBy: Expr[];
  having?: Expr;
  windows: { name: string; spec: WindowSpec }[];
}

export interface SelectCoreValues extends Node {
  kind: 'values';
  rows: Expr[][];
}

export type ResultColumn =
  | ({ kind: 'star' } & Node)
  | ({ kind: 'tableStar'; table: string } & Node)
  | ({ kind: 'expr'; expr: Expr; alias?: string } & Node);

export type FromItem = TableRef | SubqueryRef | JoinRef | FunctionRef;

export interface TableRef extends Node {
  kind: 'table';
  schema?: string;
  name: string;
  alias?: string;
  /** `INDEXED BY name` / `NOT INDEXED` hints. */
  indexedBy?: string | null;
}

export interface SubqueryRef extends Node {
  kind: 'subquery';
  select: SelectStmt;
  alias?: string;
}

/** Table-valued function in FROM, e.g. `pragma_table_info('t')` or `read_csv('x.csv', header => false)`. */
export interface FunctionRef extends Node {
  kind: 'function';
  name: string;
  args: Expr[];
  /** Named arguments (`name => value`, lower-cased names), after the positional ones. */
  named?: Record<string, Expr>;
  alias?: string;
}

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';

export interface JoinRef extends Node {
  kind: 'join';
  /** Comma joins are CROSS joins. */
  joinType: JoinType;
  natural: boolean;
  left: FromItem;
  right: FromItem;
  on?: Expr;
  using?: string[];
}

export interface OrderingTerm extends Node {
  expr: Expr;
  desc: boolean;
  nulls?: 'FIRST' | 'LAST';
}

// ------------------------------------------------------------------ DML

export type ConflictAction = 'ROLLBACK' | 'ABORT' | 'FAIL' | 'IGNORE' | 'REPLACE';

export interface UpsertClause extends Node {
  target?: { columns: IndexedColumn[]; where?: Expr };
  action: { kind: 'nothing' } | { kind: 'update'; set: SetClause[]; where?: Expr };
}

export interface InsertStmt extends Node {
  kind: 'insert';
  with?: WithClause;
  /** `INSERT OR <action>`; `REPLACE INTO` sets `REPLACE`. */
  or?: ConflictAction;
  schema?: string;
  table: string;
  alias?: string;
  columns?: string[];
  source: { kind: 'values'; rows: Expr[][] } | { kind: 'select'; select: SelectStmt } | { kind: 'default' };
  upsert: UpsertClause[];
  returning?: ResultColumn[];
}

export interface SetClause extends Node {
  /** One column, or several for `(a, b) = (...)`. */
  columns: string[];
  value: Expr;
}

export interface UpdateStmt extends Node {
  kind: 'update';
  with?: WithClause;
  or?: ConflictAction;
  schema?: string;
  table: string;
  alias?: string;
  set: SetClause[];
  from?: FromItem;
  where?: Expr;
  returning?: ResultColumn[];
  orderBy: OrderingTerm[];
  limit?: Expr;
  offset?: Expr;
  /** `INDEXED BY name` / `NOT INDEXED` hints. */
  indexedBy?: string | null;
}

export interface DeleteStmt extends Node {
  kind: 'delete';
  with?: WithClause;
  schema?: string;
  table: string;
  alias?: string;
  where?: Expr;
  returning?: ResultColumn[];
  orderBy: OrderingTerm[];
  limit?: Expr;
  offset?: Expr;
  /** `INDEXED BY name` / `NOT INDEXED` hints. */
  indexedBy?: string | null;
}

// ------------------------------------------------------------------ DDL

export interface IndexedColumn extends Node {
  /** A plain column reference is parsed as a ColumnExpr; other expressions make an expression index. */
  expr: Expr;
  collation?: string;
  desc: boolean;
}

export type ColumnConstraint = Node & { name?: string } & (
    | { kind: 'primaryKey'; desc: boolean; autoincrement: boolean; onConflict?: ConflictAction }
    | { kind: 'notNull'; onConflict?: ConflictAction }
    | { kind: 'null' }
    | { kind: 'unique'; onConflict?: ConflictAction }
    | { kind: 'check'; expr: Expr }
    | { kind: 'default'; expr: Expr }
    | { kind: 'collate'; collation: string }
    | ({ kind: 'references' } & ForeignKeyClause)
    | { kind: 'generated'; expr: Expr; stored: boolean }
  );

export interface ForeignKeyClause {
  table: string;
  columns?: string[];
  onDelete?: FkAction;
  onUpdate?: FkAction;
  /** Checked at COMMIT: DEFERRABLE INITIALLY DEFERRED (SQLite's only deferred form). */
  deferrable?: boolean;
  /** Declared DEFERRABLE (any INITIALLY), as information_schema reports it. */
  isDeferrable?: boolean;
}

export type FkAction = 'SET NULL' | 'SET DEFAULT' | 'CASCADE' | 'RESTRICT' | 'NO ACTION';

export type TableConstraint = Node & { name?: string } & (
    | { kind: 'primaryKey'; columns: IndexedColumn[]; autoincrement?: boolean; onConflict?: ConflictAction }
    | { kind: 'unique'; columns: IndexedColumn[]; onConflict?: ConflictAction }
    | { kind: 'check'; expr: Expr }
    | { kind: 'foreignKey'; /** Child columns. */ columns: string[]; references: ForeignKeyClause }
  );

export interface ColumnDef extends Node {
  name: string;
  /** Normalized type name, absent when no type was written. */
  type?: string;
  constraints: ColumnConstraint[];
}

export interface CreateTableStmt extends Node {
  kind: 'createTable';
  temp: boolean;
  ifNotExists: boolean;
  schema?: string;
  name: string;
  columns: ColumnDef[];
  constraints: TableConstraint[];
  /** Table options after the closing parenthesis: STRICT, LOOSE (smaltdb), WITHOUT ROWID. */
  options: { strict: boolean; loose: boolean; withoutRowid: boolean };
  /** smaltdb `WITH (key = value, ...)` storage options. */
  with?: Record<string, SqlValue>;
  asSelect?: SelectStmt;
}

export interface CreateIndexStmt extends Node {
  kind: 'createIndex';
  unique: boolean;
  ifNotExists: boolean;
  schema?: string;
  name: string;
  table: string;
  columns: IndexedColumn[];
  /** smaltdb extension: `INCLUDE (cols)` covering columns. */
  include?: string[];
  where?: Expr;
}

export interface CreateViewStmt extends Node {
  kind: 'createView';
  temp: boolean;
  /** smaltdb: CREATE MATERIALIZED VIEW */
  materialized: boolean;
  ifNotExists: boolean;
  schema?: string;
  name: string;
  columns?: string[];
  with?: Record<string, SqlValue>;
  /** Materialized views: `WITH NO DATA` creates the view unpopulated (PostgreSQL). */
  withData?: boolean;
  select: SelectStmt;
}

/** M8: `CREATE CONNECTION name WITH (type = …, url = …, credentials = …)`: an endpoint for external tables. */
export interface CreateConnectionStmt extends Node {
  kind: 'createConnection';
  ifNotExists: boolean;
  name: string;
  with: Record<string, SqlValue>;
}

/** M8: `CREATE EXTERNAL TABLE name [(columns)] WITH (location = …, format = …, …)`: rows that live elsewhere. */
export interface CreateExternalTableStmt extends Node {
  kind: 'createExternalTable';
  ifNotExists: boolean;
  name: string;
  /** Declared columns (empty: inferred from the source when the table is created). */
  columns: ColumnDef[];
  with: Record<string, SqlValue>;
}

export interface DropStmt extends Node {
  kind: 'drop';
  objectType: 'table' | 'index' | 'view' | 'materialized view' | 'trigger' | 'external table' | 'connection';
  ifExists: boolean;
  schema?: string;
  name: string;
}

export interface AlterTableStmt extends Node {
  kind: 'alterTable';
  schema?: string;
  table: string;
  action:
    | { kind: 'renameTable'; newName: string }
    | { kind: 'renameColumn'; column: string; newName: string }
    | { kind: 'addColumn'; column: ColumnDef }
    | { kind: 'dropColumn'; column: string };
}

export interface RefreshStmt extends Node {
  kind: 'refresh';
  concurrently: boolean;
  /** `WITH NO DATA` empties the view and marks it unpopulated (PostgreSQL). */
  withData: boolean;
  /** smaltdb `IF CHANGED`: refresh only when a base table or an external source changed since the last refresh. */
  ifChanged?: boolean;
  schema?: string;
  name: string;
}

// ------------------------------------------------------------------ transactions & utility

export interface BeginStmt extends Node {
  kind: 'begin';
  mode?: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE';
}

export interface CommitStmt extends Node {
  kind: 'commit';
}

export interface RollbackStmt extends Node {
  kind: 'rollback';
  /** `ROLLBACK TO [SAVEPOINT] name` */
  savepoint?: string;
}

export interface SavepointStmt extends Node {
  kind: 'savepoint';
  name: string;
}

export interface ReleaseStmt extends Node {
  kind: 'release';
  name: string;
}

export interface ExplainStmt extends Node {
  kind: 'explain';
  /** `EXPLAIN QUERY PLAN` */
  queryPlan: boolean;
  /** `EXPLAIN ANALYZE` (smaltdb) */
  analyze: boolean;
  stmt: Stmt;
}

export interface PragmaStmt extends Node {
  kind: 'pragma';
  schema?: string;
  /** Lower-case pragma name. */
  name: string;
  /** `PRAGMA x = v` or `PRAGMA x(v)`; identifiers/keywords as values become string literals. */
  value?: Expr;
}

export interface AnalyzeStmt extends Node {
  kind: 'analyze';
  /** A schema (`main`, `temp`) or a table or index name. */
  target?: string;
  schema?: string;
}

export interface VacuumStmt extends Node {
  kind: 'vacuum';
}

export type Stmt =
  | SelectStmt
  | InsertStmt
  | UpdateStmt
  | DeleteStmt
  | CreateTableStmt
  | CreateIndexStmt
  | CreateViewStmt
  | CreateConnectionStmt
  | CreateExternalTableStmt
  | DropStmt
  | AlterTableStmt
  | RefreshStmt
  | BeginStmt
  | CommitStmt
  | RollbackStmt
  | SavepointStmt
  | ReleaseStmt
  | ExplainStmt
  | PragmaStmt
  | AnalyzeStmt
  | VacuumStmt;

/** A parsed statement with its source span (used for `sql` in the catalog and error messages). */
export interface ParsedStatement {
  stmt: Stmt;
  /** Exact source text of the statement, without the trailing `;`. */
  text: string;
  start: number;
  end: number;
  /** Highest parameter slot used (0 when none). */
  paramCount: number;
  /** Named parameters: name (with prefix) -> slot. */
  paramNames: Map<string, number>;
}
