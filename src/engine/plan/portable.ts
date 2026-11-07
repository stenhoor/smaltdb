/**
 * The plan format as the client (`smaltdb`) exports it, as `plan`: its types, builders and codec, with nothing that
 * needs the engine. `smaltdb/engine`'s `plan` (plan/public.ts) adds the validator.
 *
 * The plan format is experimental (`PLAN_FORMAT_VERSION` 0) until smaltdf has proven it: it may change in any
 * release until its own stability ADR.
 */
export * from './build.js';
export { PLAN_FORMAT_VERSION, type PlanType, type CollationName, type Field, type Schema } from './types.js';
export type { PlanOp, SortKey, AggCall, WindowFrame, WindowCall, JoinKind, ConflictAction, ValueColumn, ColumnArray } from './ops.js';
export type { PlanExpr, PlanOrigin, NestedPlan, ColExpr, LitExpr, ParamExpr, CallExpr, CastExpr, LogicExpr, NotExpr, IsNullExpr, CaseExpr, SubqueryExpr, InSubqueryExpr } from './expr.js';
export type { BoundStatement, BoundQuery, BoundWrite, BoundTransaction, BoundColumn } from './bound.js';
export type {
  SchemaOp,
  AlterAction,
  DeferredError,
  TableDef,
  ColumnDef,
  KeyDef,
  KeyColumnDef,
  CheckDef,
  ForeignKeyDef,
  FkAction,
  IndexDef,
  IndexColumnDef,
  ExprDef,
  DefaultDef,
  StorageType,
  Source,
  DropObject,
} from './schema.js';
export type { PlanColumn, PlanQuery, PlanWrite, PlanStatementInput } from './statement.js';
export { MAX_PARAMS } from './statement.js';
export { encodePlan, decodePlan, planToJSON, planFromJSON, type EncodedPlan } from './codec.js';
export {
  type Catalog,
  type CatalogColumn,
  type CatalogData,
  type CatalogFunction,
  type CatalogIndex,
  type CatalogKey,
  type CatalogSettings,
  type CatalogTable,
  type CatalogView,
  type FunctionCatalog,
  affinityOfStorage,
  declaredType,
  planTypeOfStorage,
  storageTypeFor,
} from './catalog.js';
/** List and struct types (ADR 0020): parsing and checking their text. */
export { type NestedType, type NestedTypeName, isNested, isNestedType, isPlanTypeName, parseNested } from '../../shared/nested-types.js';
