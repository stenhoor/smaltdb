/**
 * What a language reaches in the engine (ADR 0015 step 9): the language interface and the plan API, and the engine's
 * own semantics a language binds against: values and collations, type and affinity conversion, the function registry,
 * window functions, schema lookups, and the SQL metadata that code generation reads beside a plan (exec/sql-meta.ts).
 * The SQL language (sql/) imports the engine only through this module; test/boundary.test.ts checks that.
 */
export type { BindContext } from './plan/bind-context.js';
export type { BoundQuery, BoundStatement } from './plan/bound.js';
export { type BoundExpr, type PlanExpr, call, lit, param, typeOf } from './plan/expr.js';
export { type LanguageStatement, type ObjectReference, type SmaltLanguage, registerLanguage } from './plan/language.js';
export type { AggCall, ConflictAction, JoinKind, PlanOp, SortKey, WindowCall, WindowFrame } from './plan/ops.js';
export type { AlterAction, CheckDef, ColumnDef, DefaultDef, DeferredError, ExprDef, ForeignKeyDef, IndexColumnDef, IndexDef, KeyColumnDef, KeyDef, Source, SourceEditor, TableDef } from './plan/schema.js';
export type { CollationName } from './plan/types.js';

export { SmaltError } from './errors.js';
export { Collation, type SqlValue, collationByName, normalizeInt } from './values.js';

export { type IndexSchema, type TableSchema, findColumn, storageTypeFor, tableSchemaFromDef } from './catalog/schema.js';
export { type Affinity, type StaticType, affinityOfStorage, applyNumericAffinity, staticTypeOfStorage } from './exec/convert.js';
export { CollSrc, type Compiled, NO_META, type SqlOperand, boundMetadata, collationName, comparisonCollation, comparisonConverters, compileBoundExpr, compilePlanExpr, metaOf, withMeta } from './exec/expr.js';
export { type Fn, type FunctionContext, aggregateFunctions, scalarFunctions } from './exec/functions.js';
export { ARITHMETIC_FUNCTIONS, BITWISE_FUNCTIONS, COMPARISON_FUNCTIONS } from './exec/sql-functions.js';
export { type SqlMeta, getMeta, markFlattened, setMeta } from './exec/sql-meta.js';
export { NAVIGATION, RANKING, WINDOW_ARITY } from './exec/window.js';
