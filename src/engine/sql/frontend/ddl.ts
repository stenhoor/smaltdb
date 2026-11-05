/**
 * SQL's DDL as schema definitions (ADR 0015 step 6c, plan/schema.ts): CREATE TABLE as a `TableDef`, CREATE INDEX as
 * an `IndexDef`, with SQLite's rules for what they may contain. Expressions are bound to plan expressions over the
 * table's row; their text is kept beside them.
 */
import { type IndexSchema, type TableSchema, storageTypeFor, tableSchemaFromDef } from '../../catalog/schema.js';
import { SmaltError } from '../../errors.js';
import { scalarFunctions } from '../../exec/functions.js';
import type { BindContext } from '../../plan/bind-context.js';
import type { PlanExpr } from '../../plan/expr.js';
import type { ConflictAction } from '../../plan/ops.js';
import type { AlterAction, CheckDef, ColumnDef, DefaultDef, DeferredError, ExprDef, ForeignKeyDef, IndexColumnDef, IndexDef, KeyColumnDef, KeyDef, TableDef } from '../../plan/schema.js';
import type { CollationName } from '../../plan/types.js';
import { type SqlValue, normalizeInt } from '../../values.js';
import type { AlterTableStmt, ColumnConstraint, ColumnDef as SqlColumnDef, ConflictAction as SqlConflict, CreateIndexStmt, CreateTableStmt, Expr, ForeignKeyClause, IndexedColumn } from '../ast.js';
import { anyNode } from '../ast-util.js';
import { parseOne } from '../parser.js';
import { toRowExpr, toValueExpr } from './select.js';

const lower = (a: SqlConflict | undefined): ConflictAction | undefined => (a === undefined ? undefined : (a.toLowerCase() as ConflictAction));

function collationName(name: string | undefined, fallback: CollationName): CollationName {
  if (name === undefined) return fallback;
  const n = name.toLowerCase();
  if (n === 'binary' || n === 'nocase' || n === 'rtrim') return n;
  throw new SmaltError('SMALT_ERROR', `no such collation sequence: ${name}`);
}

function constraintsOf(c: ColumnConstraint[], kind: ColumnConstraint['kind']): ColumnConstraint[] {
  return c.filter((x) => x.kind === kind);
}

function indexedColumnName(ic: IndexedColumn): string {
  if (ic.expr.kind === 'column' && ic.expr.table === undefined) return ic.expr.name;
  if (ic.expr.kind === 'collate' && ic.expr.expr.kind === 'column') return ic.expr.expr.name;
  throw new SmaltError('SMALT_UNSUPPORTED', 'expressions in index definitions are not supported yet');
}

function indexedColumnCollation(ic: IndexedColumn): string | undefined {
  if (ic.collation) return ic.collation;
  if (ic.expr.kind === 'collate') return ic.expr.collation;
  return undefined;
}

/** Value of a constant default (literal, or signed numeric literal); null otherwise. */
export function literalValue(e: Expr | undefined): SqlValue {
  if (!e) return null;
  if (e.kind === 'literal') return e.value;
  if (e.kind === 'unary' && (e.op === '-' || e.op === '+') && e.operand.kind === 'literal') {
    const v = e.operand.value;
    if (typeof v === 'number') return e.op === '-' ? -v : v;
    if (typeof v === 'bigint') return e.op === '-' ? normalizeInt(-v) : v;
  }
  return null;
}

/** Whether a default is constant in SQLite's ALTER TABLE ADD COLUMN sense. */
export function isConstantDefault(e: Expr): boolean {
  if (e.kind === 'literal') return true;
  return e.kind === 'unary' && (e.op === '-' || e.op === '+') && e.operand.kind === 'literal' && (typeof e.operand.value === 'number' || typeof e.operand.value === 'bigint');
}

const isSubquery = (n: Record<string, unknown>): boolean => n.kind === 'subquery' || n.kind === 'exists' || n.kind === 'inSelect';

/** SQLite's parse-time rules for a CHECK expression (`prefix` names the ALTER TABLE context). */
export function checkCheckExpr(e: Expr, prefix = ''): void {
  if (anyNode(e, isSubquery)) throw new SmaltError('SMALT_ERROR', `${prefix}subqueries prohibited in CHECK constraints`);
  if (anyNode(e, (n) => n.kind === 'param')) throw new SmaltError('SMALT_ERROR', `${prefix}parameters prohibited in CHECK constraints`);
}

/** SQLite's parse-time rule for DEFAULT: no subqueries, column references or parameters (functions are allowed). */
export function checkDefaultExpr(column: string, e: Expr): void {
  if (anyNode(e, (n) => isSubquery(n) || n.kind === 'column' || n.kind === 'param')) throw new SmaltError('SMALT_ERROR', `default value of column [${column}] is not constant`);
}

/**
 * CREATE TABLE / ADD COLUMN only (stored definitions are not re-checked, so existing databases
 * still open): DEFAULT and CHECK expressions, in the order they appear, as SQLite checks them.
 */
export function checkConstraintExprs(columns: SqlColumnDef[], tableChecks: Expr[], checkPrefix = ''): void {
  for (const def of columns) {
    for (const c of def.constraints) {
      if (c.kind === 'default') checkDefaultExpr(def.name, c.expr);
      else if (c.kind === 'check') checkCheckExpr(c.expr, checkPrefix);
    }
  }
  for (const e of tableChecks) checkCheckExpr(e, checkPrefix);
}

/** The text of `e` in `text`. */
const textOf = (e: Expr, text: string): string => text.slice(e.pos, e.end);

/** A DEFAULT: its value when constant, bound when it can be (SQLite resolves its functions only when it is used). */
export function defaultDef(e: Expr, text: string, catalog: BindContext | undefined): DefaultDef {
  let expr: PlanExpr | undefined;
  if (catalog) {
    try {
      expr = toValueExpr(e, text, catalog);
    } catch {
      expr = undefined;
    }
  }
  return { text: textOf(e, text), ...(expr ? { expr } : {}), value: literalValue(e) };
}

function fkDef(name: string | undefined, columns: number[], c: ForeignKeyClause): ForeignKeyDef {
  if (c.columns && c.columns.length !== columns.length) {
    throw new SmaltError('SMALT_ERROR', `number of columns in foreign key does not match the number of columns in the referenced table`);
  }
  return { ...(name !== undefined ? { name } : {}), columns, table: c.table, ...(c.columns ? { refColumns: c.columns } : {}), onDelete: c.onDelete ?? 'NO ACTION', onUpdate: c.onUpdate ?? 'NO ACTION', deferrable: !!c.deferrable, isDeferrable: !!c.isDeferrable };
}

/**
 * CREATE TABLE as a table definition. `text`: the statement's source (expression texts are slices of it). DEFAULTs are
 * bound when they can be (SQLite resolves their functions when they are used); CHECK constraints are left unbound
 * ({@link withBoundChecks} binds them). `catalog` absent: nothing is bound (system tables).
 */
export function toTableDef(stmt: CreateTableStmt, text: string, catalog: BindContext | undefined): TableDef {
  if (stmt.options.withoutRowid) throw new SmaltError('SMALT_UNSUPPORTED', 'WITHOUT ROWID tables are not supported yet');
  if (stmt.options.loose) throw new SmaltError('SMALT_UNSUPPORTED', 'LOOSE tables are not supported yet');
  if (stmt.asSelect) throw new SmaltError('SMALT_UNSUPPORTED', 'CREATE TABLE ... AS SELECT is not supported yet');
  if (stmt.columns.length === 0) throw new SmaltError('SMALT_ERROR', 'a table must have at least one column');
  const seen = new Set<string>();
  const columns: ColumnDef[] = stmt.columns.map((def) => {
    const l = def.name.toLowerCase();
    if (seen.has(l)) throw new SmaltError('SMALT_ERROR', `duplicate column name: ${def.name}`);
    seen.add(l);
    const cs = def.constraints;
    if (constraintsOf(cs, 'generated').length) throw new SmaltError('SMALT_UNSUPPORTED', 'generated columns are not supported yet');
    const coll = constraintsOf(cs, 'collate')[0] as { collation: string } | undefined;
    const dflt = constraintsOf(cs, 'default')[0] as { expr: Expr } | undefined;
    // Like SQLite, the last NOT NULL clause decides the column's ON CONFLICT action.
    const notNulls = constraintsOf(cs, 'notNull') as { onConflict?: SqlConflict }[];
    const nnConflict = notNulls.length ? lower(notNulls[notNulls.length - 1].onConflict) : undefined;
    return {
      name: def.name,
      declaredType: def.type ?? '',
      type: storageTypeFor(def.type),
      notNull: notNulls.length > 0,
      ...(nnConflict ? { notNullConflict: nnConflict } : {}),
      collation: collationName(coll?.collation, 'binary'),
      ...(dflt ? { default: defaultDef(dflt.expr, text, catalog) } : {}),
    };
  });
  const keys: KeyDef[] = [];
  const checkExprs: { name?: string; expr: Expr; ofColumn?: number }[] = [];
  const fks: ForeignKeyDef[] = [];
  let pkSeen = false;
  const key = (kind: KeyDef['kind'], cols: { index: number; desc: boolean; collation?: string }[], name: string | undefined, onConflict: SqlConflict | undefined, autoincrement = false, ofColumn?: number): void => {
    if (kind === 'primaryKey') {
      if (pkSeen) throw new SmaltError('SMALT_ERROR', `table "${stmt.name}" has more than one primary key`);
      pkSeen = true;
    }
    const kc: KeyColumnDef[] = cols.map((c) => ({ column: c.index, desc: c.desc, collation: collationName(c.collation, columns[c.index].collation) }));
    const oc = lower(onConflict);
    keys.push({ kind, columns: kc, ...(name !== undefined ? { name } : {}), ...(oc ? { onConflict: oc } : {}), ...(autoincrement ? { autoincrement } : {}), ...(ofColumn !== undefined ? { ofColumn } : {}) });
  };
  // Column constraints first, then table constraints (SQLite numbers automatic indexes in this order).
  stmt.columns.forEach((def, i) => {
    for (const c of def.constraints) {
      if (c.kind === 'primaryKey') key('primaryKey', [{ index: i, desc: c.desc }], c.name, c.onConflict, c.autoincrement, i);
      else if (c.kind === 'unique') key('unique', [{ index: i, desc: false }], c.name, c.onConflict, false, i);
      else if (c.kind === 'check') checkExprs.push({ name: c.name, expr: c.expr, ofColumn: i });
      else if (c.kind === 'references') fks.push({ ...fkDef(c.name, [i], c), ofColumn: i });
    }
  });
  for (const tc of stmt.constraints) {
    if (tc.kind === 'primaryKey' || tc.kind === 'unique') {
      const cols = tc.columns.map((ic) => {
        const name = indexedColumnName(ic);
        const index = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
        if (index < 0) throw new SmaltError('SMALT_ERROR', `no such column: ${name}`);
        return { index, desc: ic.desc, collation: indexedColumnCollation(ic) };
      });
      key(tc.kind, cols, tc.name, tc.onConflict, tc.kind === 'primaryKey' && tc.autoincrement);
    } else if (tc.kind === 'check') {
      checkExprs.push({ name: tc.name, expr: tc.expr });
    } else if (tc.kind === 'foreignKey') {
      const idx = tc.columns.map((name) => {
        const index = columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase());
        if (index < 0) throw new SmaltError('SMALT_ERROR', `unknown column "${name}" in foreign key definition`);
        return index;
      });
      fks.push(fkDef(tc.name, idx, tc.references));
    }
  }
  const checks: CheckDef[] = checkExprs.map((c) => ({ ...(c.name !== undefined ? { name: c.name } : {}), text: textOf(c.expr, text), ...(c.ofColumn !== undefined ? { ofColumn: c.ofColumn } : {}) }));
  return { name: stmt.name, columns, keys, checks, foreignKeys: fks, storage: tableStorage(stmt) };
}

/**
 * `def` (from `stmt`, source `text`) with its CHECK constraints bound over the table's row: CREATE TABLE, where SQLite
 * reports a CHECK that names no column or function, and a stored table's CHECKs where they are first used.
 */
export function withBoundChecks(def: TableDef, stmt: CreateTableStmt, text: string, catalog: BindContext): TableDef {
  if (def.checks.length === 0) return def;
  const row = tableSchemaFromDef(def, text, 0).table;
  const exprs = [...stmt.columns.flatMap((c) => c.constraints.flatMap((k) => (k.kind === 'check' ? [k.expr] : []))), ...stmt.constraints.flatMap((k) => (k.kind === 'check' ? [k.expr] : []))];
  return { ...def, checks: def.checks.map((c, i) => ({ ...c, expr: toRowExpr(exprs[i], row, text, catalog) })) };
}

/** The parsed CREATE TABLE of each table object (SQL's own cache: the engine keeps no syntax trees). */
const parsedTables = new WeakMap<TableSchema, CreateTableStmt>();

/**
 * A stored table's CHECK and DEFAULT expressions bound over `table` (the table its definition gave): what opening left
 * unbound, bound where first used. A failure is the binder's error.
 */
export function bindStoredTableExprs(table: TableSchema, catalog: BindContext): { checks: PlanExpr[]; defaults: (PlanExpr | null)[] } {
  let stmt = parsedTables.get(table);
  if (!stmt) parsedTables.set(table, (stmt = parseOne(table.sql).stmt as CreateTableStmt));
  const checks = [...stmt.columns.flatMap((c) => c.constraints.flatMap((k) => (k.kind === 'check' ? [k.expr] : []))), ...stmt.constraints.flatMap((k) => (k.kind === 'check' ? [k.expr] : []))];
  return {
    checks: checks.map((e) => toRowExpr(e, table, table.sql, catalog)),
    defaults: stmt.columns.map((c) => {
      const d = c.constraints.find((k) => k.kind === 'default') as { expr: Expr } | undefined;
      return d ? toValueExpr(d.expr, table.sql, catalog) : null;
    }),
  };
}

/**
 * CREATE TABLE only (stored definitions are not re-checked, so existing databases still open): SQLite's rules for
 * DEFAULT and CHECK expressions.
 */
export function checkNewTable(stmt: CreateTableStmt): void {
  checkConstraintExprs(
    stmt.columns,
    stmt.constraints.flatMap((c) => (c.kind === 'check' ? [c.expr] : [])),
  );
}

/** `CREATE TABLE … WITH (storage = 'row' | 'columnar')` (validates the options). */
export function tableStorage(stmt: CreateTableStmt): 'row' | 'columnar' {
  const opts = stmt.with ?? {};
  for (const k of Object.keys(opts)) if (k !== 'storage') throw new SmaltError('SMALT_ERROR', `unknown table option: ${k}`);
  const storage = String(opts.storage ?? 'row').toLowerCase();
  if (storage !== 'row' && storage !== 'columnar') throw new SmaltError('SMALT_ERROR', `storage must be 'row' or 'columnar'`);
  return storage;
}

/**
 * CREATE INDEX as an index definition on `table`, with SQLite's rules: expressions and the partial WHERE may hold no
 * subqueries, parameters or non-deterministic functions. Expressions are bound over the table's row.
 */
export function toIndexDef(stmt: CreateIndexStmt, text: string, table: TableSchema, catalog: BindContext): IndexDef {
  if (stmt.include?.length) throw new SmaltError('SMALT_UNSUPPORTED', 'INCLUDE columns are not supported yet');
  const rowExpr = (e: Expr, what: string): ExprDef => {
    checkIndexExpr(e, what);
    return { text: textOf(e, text), expr: toRowExpr(e, table, text, catalog) };
  };
  const columns: IndexColumnDef[] = stmt.columns.map((ic) => {
    const plain = ic.expr.kind === 'column' || (ic.expr.kind === 'collate' && ic.expr.expr.kind === 'column');
    if (!plain) {
      const e = ic.expr.kind === 'collate' ? ic.expr.expr : ic.expr;
      return { column: -1, expr: rowExpr(e, 'index expressions'), desc: ic.desc, collation: collationName(indexedColumnCollation(ic), 'binary') };
    }
    const col = (ic.expr.kind === 'collate' ? ic.expr.expr : ic.expr) as { table?: string; name: string };
    if (col.table && col.table.toLowerCase() !== table.name.toLowerCase()) throw new SmaltError('SMALT_ERROR', `no such column: ${col.table}.${col.name}`);
    const index = table.columns.findIndex((c) => c.name.toLowerCase() === col.name.toLowerCase());
    if (index < 0) throw new SmaltError('SMALT_ERROR', `no such column: ${col.name}`);
    return { column: index, desc: ic.desc, collation: collationName(indexedColumnCollation(ic), COLLATION_NAMES[table.columns[index].collation]) };
  });
  return { name: stmt.name, table: table.name, columns, unique: stmt.unique, ...(stmt.where ? { where: rowExpr(stmt.where, 'partial index WHERE clauses') } : {}) };
}

const COLLATION_NAMES: readonly CollationName[] = ['binary', 'nocase', 'rtrim'];

/** SQLite's rules for index expressions and partial-index WHERE clauses. */
function checkIndexExpr(e: Expr, what: string): void {
  const go = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(go);
    if (typeof x !== 'object' || x === null || Object.getPrototypeOf(x) !== Object.prototype) return;
    const o = x as Record<string, unknown>;
    if ((o.kind === 'subquery' || o.kind === 'exists' || o.kind === 'inSelect') && 'select' in o) throw new SmaltError('SMALT_ERROR', `subqueries prohibited in ${what}`);
    if (o.kind === 'param') throw new SmaltError('SMALT_ERROR', `parameters prohibited in ${what}`);
    if (o.kind === 'call') {
      const name = String(o.name);
      const def = scalarFunctions.get(name);
      if ((def && !def.deterministic && !def.pureDate) || name === 'current_time' || name === 'current_date' || name === 'current_timestamp') {
        throw new SmaltError('SMALT_ERROR', `non-deterministic functions prohibited in ${what}`);
      }
    }
    for (const k of Object.keys(o)) go(o[k]);
  };
  go(e);
}

/** An index of a stored table as the planner and writers use it. */
export type { IndexSchema };

/**
 * ALTER TABLE as the change it makes (plan/schema.ts `AlterAction`). ADD COLUMN's column is bound here: its DEFAULT,
 * and its CHECKs over the table's row with the new column. What SQL forbids in an added column is reported by the
 * engine after its own checks on the target (`invalid`), in SQLite's order.
 */
export function toAlterAction(stmt: AlterTableStmt, text: string, catalog: BindContext): AlterAction {
  const a = stmt.action;
  if (a.kind !== 'addColumn') return a.kind === 'renameTable' ? { kind: a.kind, newName: a.newName } : a.kind === 'renameColumn' ? { kind: a.kind, column: a.column, newName: a.newName } : { kind: a.kind, column: a.column };
  const def = a.column;
  const columnText = text.slice(def.pos, def.end);
  const placeholder: ColumnDef = { name: def.name, declaredType: def.type ?? '', type: storageTypeFor(def.type), notNull: false, collation: 'binary' };
  const unbound = (invalid?: DeferredError): AlterAction => ({ kind: 'addColumn', column: placeholder, checks: [], foreignKeys: [], text: columnText, ...(invalid ? { invalid } : {}) });
  const table = catalog.getTable(stmt.table, stmt.schema);
  const fail = (e: unknown, prefix = ''): AlterAction => {
    if (!(e instanceof SmaltError)) throw e;
    return unbound({ code: e.code, message: prefix + e.message });
  };
  try {
    const cons = def.constraints;
    if (cons.some((c) => c.kind === 'primaryKey')) throw new SmaltError('SMALT_ERROR', 'Cannot add a PRIMARY KEY column');
    if (cons.some((c) => c.kind === 'unique')) throw new SmaltError('SMALT_ERROR', 'Cannot add a UNIQUE column');
    if (cons.some((c) => c.kind === 'generated')) throw new SmaltError('SMALT_UNSUPPORTED', 'generated columns are not supported yet');
    checkConstraintExprs([def], [], `error in table ${table?.name ?? stmt.table} after add column: `);
    const dflt = cons.find((c) => c.kind === 'default') as { expr: Expr } | undefined;
    if (dflt && !isConstantDefault(dflt.expr)) throw new SmaltError('SMALT_ERROR', 'Cannot add a column with non-constant default');
    if (cons.some((c) => c.kind === 'notNull') && literalValue(dflt?.expr) === null) throw new SmaltError('SMALT_ERROR', 'Cannot add a NOT NULL column with default value NULL');
  } catch (e) {
    return fail(e);
  }
  // Not a table (a view, nothing): the engine reports it before using the column.
  if (!table) return unbound();
  const one: CreateTableStmt = { kind: 'createTable', name: table.name, temp: false, ifNotExists: false, columns: [def], constraints: [], options: {}, pos: stmt.pos, end: stmt.end } as unknown as CreateTableStmt;
  let added: TableDef;
  try {
    added = toTableDef(one, text, catalog);
  } catch (e) {
    return fail(e);
  }
  const n = table.columns.length;
  const column = added.columns[0];
  // The new row: the table's columns, then the new one (its rowid after them).
  const row: TableSchema = { ...table, columns: [...table.columns, tableSchemaFromDef({ ...added, keys: [], checks: [], foreignKeys: [] }, '', 0).table.columns[0]] };
  const checkAsts = cons(def, 'check') as { expr: Expr }[];
  let checks: CheckDef[];
  try {
    checks = added.checks.map((c, i) => ({ ...c, expr: toRowExpr(checkAsts[i].expr, row, text, catalog), ofColumn: n }));
  } catch (e) {
    return fail(e, `error in table ${table.name}: `);
  }
  const foreignKeys = added.foreignKeys.map((f) => ({ ...f, columns: [n], ofColumn: n }));
  return { kind: 'addColumn', column, checks, foreignKeys, text: columnText };
}

const cons = (def: SqlColumnDef, kind: ColumnConstraint['kind']): ColumnConstraint[] => constraintsOf(def.constraints, kind);
