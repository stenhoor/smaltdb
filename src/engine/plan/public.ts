/**
 * The public plan API (ADR 0014 section 4, ADR 0015 step 8), exported from `smaltdb/engine` as `plan`: the plan
 * format's types, builders, the validator and the codec. Plans run with `Database.preparePlan` / `queryPlan`.
 *
 * The plan format is experimental (`PLAN_FORMAT_VERSION` 0) until smaltdf has proven it: it may change in any
 * release until its own stability ADR.
 */
export * from './build.js';
export { PLAN_FORMAT_VERSION, type PlanType, type CollationName, type Field, type Schema } from './types.js';
export type { PlanOp, SortKey, AggCall, WindowFrame, WindowCall, JoinKind, ConflictAction } from './ops.js';
export type { PlanExpr, NestedPlan, ColExpr, LitExpr, ParamExpr, CallExpr, CastExpr, LogicExpr, NotExpr, IsNullExpr, CaseExpr, SubqueryExpr, InSubqueryExpr } from './expr.js';
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
export { validatePlan, MAX_PLAN_DEPTH, type ValidateCatalog } from './validate.js';
export { encodePlan, decodePlan, planToJSON, planFromJSON, type EncodedPlan } from './codec.js';
