/**
 * The logical catalog (ADR 0016 section 7, plan/catalog.ts) over the engine's schema: tables described in plan terms,
 * function metadata from the registries, and the engine's help for building plans (result types, expression types,
 * constant evaluation).
 */
import { CollSrc, boundMetadata, compilePlanExpr } from '../exec/expr.js';
import { type CompiledArg, type FunctionContext, aggregateFunctions, scalarFunctions } from '../exec/functions.js';
import { SQL_ALIASES, SQL_FUNCTIONS, canonicalName } from '../exec/sql-functions.js';
import { NAVIGATION, RANKING, WINDOW_ARITY } from '../exec/window.js';
import type { Catalog, CatalogData, CatalogFunction, CatalogKey, CatalogSettings, CatalogTable, CatalogView, FunctionCatalog } from '../plan/catalog.js';
import { declaredType, planTypeOfStorage } from '../plan/catalog.js';
import { type BoundExpr, typeOf } from '../plan/expr.js';
import type { Source, TableDef } from '../plan/schema.js';
import type { CollationName, PlanType } from '../plan/types.js';
import { Collation, type SqlValue } from '../values.js';
import { type TableSchema, isColumnar, tableSchemaFromDef } from './schema.js';

/** What the catalog reads of the database. */
export interface CatalogHost {
  /** Tables and materialized views, main and temp, without the system tables. */
  tables(): readonly TableSchema[];
  externals(): readonly { name: string; sql: string; columns: readonly { name: string; declType: string }[] }[];
  views(): readonly { name: string; source: Source; columns?: readonly string[]; temp: boolean }[];
  settings(): CatalogSettings;
  /** Changes whenever the schema does: descriptions are kept until then. */
  schemaVersion(): number;
  funcCtx: FunctionContext;
}

const COLLATION_NAMES: readonly CollationName[] = ['binary', 'nocase', 'rtrim'];
const COLLATION_IDS: Readonly<Record<string, Collation>> = { binary: Collation.Binary, nocase: Collation.NoCase, rtrim: Collation.RTrim };

/** A table as the catalog describes it. */
export function describeTable(t: TableSchema): CatalogTable {
  const keys: CatalogKey[] = [];
  const pk = t.indexes.find((ix) => ix.origin === 'pk');
  if (pk) keys.push({ kind: 'primaryKey', columns: pk.columns.map((c) => c.column) });
  else if (t.rowidAlias >= 0) keys.push({ kind: 'primaryKey', columns: [t.rowidAlias] });
  for (const ix of t.indexes) if (ix.origin === 'u') keys.push({ kind: 'unique', columns: ix.columns.map((c) => c.column) });
  return {
    kind: t.system ? 'system' : t.matview ? 'materializedView' : 'table',
    name: t.name,
    schema: t.temp ? 'temp' : 'main',
    columns: t.columns.map((c) => ({
      name: c.name,
      type: planTypeOfStorage(c.type),
      storageType: c.type,
      declaredType: c.declaredType,
      collation: COLLATION_NAMES[c.collation],
      notNull: c.notNull,
      rowid: c.rowidAlias,
      hasDefault: c.default !== undefined,
    })),
    keys,
    indexes: t.indexes.map((ix) => ({
      name: ix.name,
      columns: ix.columns.map((c) => ({ column: c.column, desc: c.desc, collation: COLLATION_NAMES[c.collation] })),
      unique: ix.unique,
      partial: ix.where !== undefined,
    })),
    storage: isColumnar(t) ? 'columnar' : 'row',
    strict: t.strict,
    ...(t.described && !t.matview ? {} : { source: { language: t.matview?.language ?? t.language ?? 'sql', text: t.matview?.sql ?? t.sql } }),
  };
}

/**
 * `def`, a table definition, described as the catalog will describe the table `CREATE TABLE` makes of it: the same
 * columns, rowid, keys and storage (the engine's own reading of the definition).
 */
export function describeTableDef(def: TableDef, source?: Source, schema: 'main' | 'temp' = 'main'): CatalogTable {
  const { table } = tableSchemaFromDef(def, source?.text ?? '', 0);
  const d = describeTable({ ...table, ...(source ? (source.language !== 'sql' ? { language: source.language } : {}) : { described: true }) });
  // The key indexes are made with the table: its keys come from the definition.
  const pk = def.keys.find((k) => k.kind === 'primaryKey');
  const keys: CatalogKey[] = [
    ...(pk ? [{ kind: 'primaryKey' as const, columns: pk.columns.map((c) => c.column) }] : []),
    ...def.keys.filter((k) => k.kind === 'unique').map((k) => ({ kind: 'unique' as const, columns: k.columns.map((c) => c.column) })),
  ];
  return { ...d, keys, schema, storage: def.storage };
}

function describeExternal(x: { name: string; sql: string; columns: readonly { name: string; declType: string }[] }): CatalogTable {
  return {
    kind: 'external',
    name: x.name,
    schema: 'main',
    columns: x.columns.map((c) => {
      const d = declaredType(c.declType);
      return { name: c.name, type: d.type, storageType: d.storageType, declaredType: c.declType, collation: 'binary', notNull: false, rowid: false, hasDefault: false };
    }),
    keys: [],
    indexes: [],
    storage: 'row',
    strict: false,
    // External tables are stored as SQL text (written by the creating language's source editor).
    source: { language: 'sql', text: x.sql },
  };
}

// ------------------------------------------------------------------ functions

/** Arguments of these types, for compiling a function only to learn its result type. */
const probeArgs = (types: readonly { type: PlanType; collation: Collation }[]): CompiledArg[] => types.map((a) => ({ fn: () => null, type: a.type, collation: a.collation }));

const RANKING_TYPES: Readonly<Record<string, PlanType>> = { row_number: 'int', rank: 'int', dense_rank: 'int', ntile: 'int', percent_rank: 'real', cume_dist: 'real' };

/** Function `name`'s result type for arguments `args`, or undefined for an unknown name. */
function resultTypeOf(name: string, args: readonly { type: PlanType; collation: Collation }[], ctx: FunctionContext): PlanType | undefined {
  const op = SQL_FUNCTIONS.get(name);
  if (op) return op.compile(probeArgs(args), {}).type;
  const scalar = scalarFunctions.get(name);
  if (scalar) return scalar.resultType ? scalar.resultType(args) : scalar.compile(probeArgs(args), ctx).type;
  const agg = aggregateFunctions.get(name);
  if (agg) return agg.resultType(args.map((a) => a.type));
  if (RANKING.has(name)) return RANKING_TYPES[name];
  if (NAVIGATION.has(name)) return args[0]?.type ?? 'any';
  return undefined;
}

/** The result type with nothing known of the arguments (the fewest it takes, of type `any`). */
function resultOf(name: string, minArgs: number, ctx: FunctionContext): PlanType {
  try {
    return resultTypeOf(name, Array.from({ length: minArgs }, () => ({ type: 'any' as PlanType, collation: Collation.Binary })), ctx) ?? 'any';
  } catch {
    return 'any';
  }
}

/** Traits as plain data. */
const traitData = (t: object | undefined): Readonly<Record<string, string | number | boolean>> => ({ ...(t as Record<string, string | number | boolean>) });

function describeFunctions(ctx: FunctionContext): CatalogFunction[] {
  const out: CatalogFunction[] = [];
  const aliases = new Map<string, string[]>();
  for (const [alias, name] of Object.entries(SQL_ALIASES)) aliases.set(name, [...(aliases.get(name) ?? []), alias]);
  for (const [name, op] of SQL_FUNCTIONS) {
    if (canonicalName(name) !== name) continue;
    const [minArgs, max] = typeof op.arity === 'number' ? [op.arity, op.arity] : op.arity;
    out.push({ name, kind: 'scalar', minArgs, maxArgs: max < 0 ? null : max, deterministic: true, result: resultOf(name, minArgs, ctx), operation: { aliases: aliases.get(name) ?? [] }, traits: traitData(op.traits) });
  }
  for (const [name, f] of scalarFunctions) {
    if (SQL_FUNCTIONS.has(name)) continue;
    out.push({
      name,
      kind: 'scalar',
      minArgs: f.minArgs,
      maxArgs: f.maxArgs < 0 ? null : f.maxArgs,
      deterministic: f.deterministic && !f.pureDate,
      ...(f.pureDate ? { dateTime: true as const } : {}),
      result: resultOf(name, f.minArgs, ctx),
      traits: traitData(f.traits),
    });
  }
  for (const [name, f] of aggregateFunctions) {
    out.push({ name, kind: 'aggregate', minArgs: f.minArgs, maxArgs: f.maxArgs < 0 ? null : f.maxArgs, deterministic: true, result: resultOf(name, f.minArgs, ctx), traits: {} });
  }
  for (const name of [...RANKING, ...NAVIGATION]) {
    const [minArgs, maxArgs] = WINDOW_ARITY[name];
    out.push({ name, kind: 'window', minArgs, maxArgs, deterministic: true, result: resultOf(name, minArgs, ctx), traits: {} });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ------------------------------------------------------------------ the catalog

/** True when `e` reads nothing but constants: no columns, parameters, registers or nested plans. */
function onlyConstants(e: BoundExpr): boolean {
  switch (e.k) {
    case 'lit':
      return true;
    case 'col':
    case 'param':
    case 'slot':
    case 'native':
    case 'subquery':
    case 'inSubquery':
      return false;
    case 'call':
    case 'and':
    case 'or':
      return e.args.every(onlyConstants);
    case 'cast':
    case 'not':
    case 'isNull':
      return onlyConstants(e.arg);
    case 'case':
      return e.whens.every((w) => onlyConstants(w.when) && onlyConstants(w.then)) && onlyConstants(e.else);
    default:
      return false;
  }
}

const KINDS: readonly CatalogFunction['kind'][] = ['scalar', 'aggregate', 'window'];

/** True when `e` has no nested plan (which only the planner compiles). */
function compilable(e: BoundExpr): boolean {
  switch (e.k) {
    case 'subquery':
    case 'inSubquery':
      return false;
    case 'call':
    case 'and':
    case 'or':
      return e.args.every(compilable);
    case 'cast':
    case 'not':
    case 'isNull':
      return compilable(e.arg);
    case 'case':
      return e.whens.every((w) => compilable(w.when) && compilable(w.then)) && compilable(e.else);
    default:
      return true;
  }
}

/**
 * `e` with its columns read from a register of their written type: what the closure compiler compiles alone. `e`
 * itself when it has no columns (the binder's expressions read registers already).
 */
function asRegisters(e: BoundExpr): BoundExpr {
  switch (e.k) {
    case 'col':
      // A register of the column's type, with its meaning fields.
      return { k: 'slot', reg: 0, type: e.type, ...(e.carries ? { carries: e.carries } : {}), ...(e.affinity ? { affinity: e.affinity } : {}) };
    case 'call':
    case 'and':
    case 'or': {
      const args = mapSame(e.args, asRegisters);
      return args === e.args ? e : ({ ...e, args } as BoundExpr);
    }
    case 'cast':
    case 'not':
    case 'isNull': {
      const arg = asRegisters(e.arg);
      return arg === e.arg ? e : ({ ...e, arg } as BoundExpr);
    }
    case 'case': {
      const whens = mapSame(e.whens, (w) => {
        const when = asRegisters(w.when);
        const then = asRegisters(w.then);
        return when === w.when && then === w.then ? w : { when, then };
      });
      const els = asRegisters(e.else);
      return whens === e.whens && els === e.else ? e : { ...e, whens, else: els };
    }
    default:
      return e;
  }
}

/** `xs` mapped by `f`, or `xs` itself when `f` changed none of them. */
function mapSame<T>(xs: readonly T[], f: (x: T) => T): readonly T[] {
  let out: T[] | null = null;
  for (let i = 0; i < xs.length; i++) {
    const y = f(xs[i]);
    if (out === null && y !== xs[i]) out = xs.slice(0, i);
    if (out !== null) out.push(y);
  }
  return out ?? xs;
}

const NO_DATABASE: FunctionContext = {
  lastInsertRowid: () => 0,
  changes: () => 0,
  totalChanges: () => 0,
  now: () => Date.now(),
};

/**
 * The engine's functions as a catalog (`Catalog.functions`, `function`, `resultType`), the same for every database:
 * what a language reads where it has no database at hand (smaltdb/language).
 */
export const engineFunctions: FunctionCatalog = (() => {
  let functions: CatalogFunction[] | null = null;
  let registered = -1;
  let byName = new Map<string, CatalogFunction[]>();
  const fns = (): CatalogFunction[] => {
    // Plugins register functions as they load: rebuild when the registries have grown.
    const count = SQL_FUNCTIONS.size + scalarFunctions.size + aggregateFunctions.size;
    if (functions === null || registered !== count) {
      registered = count;
      functions = describeFunctions(NO_DATABASE);
      byName = new Map();
      for (const f of functions) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
      for (const [alias, name] of Object.entries(SQL_ALIASES)) if (byName.has(name)) byName.set(alias, byName.get(name)!);
    }
    return functions;
  };
  return {
    functions: () => [...fns()],
    function: (name, kind) => {
      fns();
      const all = byName.get(name.toLowerCase()) ?? byName.get(name) ?? [];
      return kind ? all.find((f) => f.kind === kind) : KINDS.map((k) => all.find((f) => f.kind === k)).find((f) => f !== undefined);
    },
    resultType: (name, args) => {
      const norm = args.map((a) => (typeof a === 'string' ? { type: a, collation: Collation.Binary } : { type: a.type, collation: COLLATION_IDS[a.collation ?? 'binary'] ?? Collation.Binary }));
      return resultTypeOf(name, norm, NO_DATABASE);
    },
  };
})();

export function logicalCatalog(host: CatalogHost): Catalog {
  let version = -1;
  let tables: CatalogTable[] = [];
  let views: CatalogView[] = [];
  const fresh = (): void => {
    const v = host.schemaVersion();
    if (v === version) return;
    version = v;
    const described = host.tables().map(describeTable);
    // TEMP first: the one a name finds when it shadows a main table.
    tables = [...described.filter((t) => t.schema === 'temp'), ...described.filter((t) => t.schema === 'main'), ...host.externals().map(describeExternal)];
    views = host.views().map((x) => ({ name: x.name, schema: x.temp ? 'temp' : 'main', language: x.source.language, text: x.source.text, ...(x.columns ? { columns: [...x.columns] } : {}) }));
  };
  const find = <T extends { name: string; schema: 'main' | 'temp' }>(xs: readonly T[], name: string, schema?: 'main' | 'temp'): T | undefined => {
    const lower = name.toLowerCase();
    return xs.find((x) => x.name.toLowerCase() === lower && (schema === undefined || x.schema === schema));
  };
  return {
    tables: () => (fresh(), [...tables]),
    table: (name, schema) => (fresh(), find(tables, name, schema)),
    views: () => (fresh(), [...views]),
    view: (name, schema) => (fresh(), find(views, name, schema)),
    functions: engineFunctions.functions,
    function: engineFunctions.function,
    settings: () => host.settings(),
    snapshot: (): CatalogData => (fresh(), { tables: [...tables], views: [...views], functions: engineFunctions.functions(), settings: host.settings() }),
    resultType: engineFunctions.resultType,
    typeOf: (expr) => {
      if (!compilable(expr)) return typeOf(expr);
      return boundMetadata(asRegisters(expr), host.funcCtx).type;
    },
    describe: (expr) => {
      if (!compilable(expr)) return { type: typeOf(expr), ...(expr.carries ? { carries: expr.carries } : {}), ...(expr.affinity ? { affinity: expr.affinity } : {}) };
      const m = boundMetadata(asRegisters(expr), host.funcCtx);
      return {
        type: m.type,
        ...(m.collSrc !== CollSrc.None ? { carries: { collation: COLLATION_NAMES[m.collation], from: m.collSrc === CollSrc.Explicit ? ('explicit' as const) : ('column' as const) } } : {}),
        ...(m.affinity !== 'NONE' ? { affinity: m.affinity } : {}),
      };
    },
    constant: (expr) => {
      if (!onlyConstants(expr)) return null;
      const c = compilePlanExpr(expr, host.funcCtx);
      if (!c.constant) return null;
      const value: SqlValue = c.fn([]);
      return { value };
    },
  };
}
