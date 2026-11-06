/**
 * What a language reaches in the engine (ADR 0015 step 9): the language interface and the plan API, and the engine's
 * own semantics a language binds against: values and collations, type and affinity conversion, the catalog (tables,
 * functions and what the engine computes for an expression; `engineFunctions` where no database is at hand), schema
 * lookups, and reading SQL's meaning fields as `SqlMeta` (`getMeta`, `metaOf`). A language
 * writes those fields into the plan itself (ADR 0016 section 2).
 * Published as `smaltdb/language`; a language (smaltql) imports the engine only through it.
 */
export type { BindContext } from './plan/bind-context.js';
export type { Catalog, CatalogData, CatalogFunction, CatalogTable, FunctionCatalog } from './plan/catalog.js';
export { describeTableDef, engineFunctions } from './catalog/logical.js';
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
export { CollSrc, type Compiled, type ComparisonOperand, NO_META, type SqlOperand, collationName, comparisonCollation, comparisonConverters, comparisonRule, metaOf } from './exec/expr.js';
export type { Fn } from './exec/functions.js';
export { ARITHMETIC_FUNCTIONS, BITWISE_FUNCTIONS, COMPARISON_FUNCTIONS } from './exec/sql-functions.js';
export { type SqlMeta, getMeta } from './exec/sql-meta.js';
