/**
 * What a language reaches in the engine (ADR 0015 step 9): the language interface and the plan API, and the engine's
 * own semantics a language binds against: values and collations, type and affinity conversion, the catalog (tables,
 * functions and what the engine computes for an expression; `engineFunctions` where no database is at hand), and the
 * engine's comparison rule (`comparisonRule`) for the meaning fields a language writes into its plans (ADR 0016
 * sections 2 and 7).
 * Published as `smaltdb/language`; a language (smaltql) imports the engine only through it.
 */
export type { BindContext } from './plan/bind-context.js';
export type { Catalog, CatalogConnection, CatalogData, CatalogFunction, CatalogTable, FunctionCatalog, ViewInterfaceColumn } from './plan/catalog.js';
export { type Conversion, conversion, isLossless } from './plan/conversions.js';
export { describeTableDef, engineFunctions } from './catalog/logical.js';
export type { BoundQuery, BoundStatement } from './plan/bound.js';
export { type BoundExpr, type PlanExpr, call, lit, param, typeOf } from './plan/expr.js';
export { type LanguageStatement, type ObjectReference, type SmaltLanguage, registerLanguage } from './plan/language.js';
export type { AggCall, ConflictAction, JoinKind, PlanOp, SortKey, WindowCall, WindowFrame } from './plan/ops.js';
export type { AlterAction, CheckDef, ColumnDef, DefaultDef, DeferredError, ExprDef, ForeignKeyDef, IndexColumnDef, IndexDef, KeyColumnDef, KeyDef, Source, SourceEditor, TableDef } from './plan/schema.js';
export type { CollationName } from './plan/types.js';

export { type ErrorDetails, type ErrorToWord, SmaltError, withDetails } from './errors.js';
export { Collation, type SqlValue, collationByName, normalizeInt } from './values.js';

export { storageTypeFor } from './plan/catalog.js';
export { type Affinity, type StaticType, affinityOfStorage, staticTypeOfStorage } from './exec/convert.js';
export { type ComparisonOperand, comparisonRule } from './exec/expr.js';
