/**
 * The public plan API (ADR 0014 section 4, ADR 0015 step 8), exported from `smaltdb/engine` as `plan`: the plan
 * format's types, builders, the validator and the codec. Plans run with `Database.preparePlan` / `queryPlan`.
 *
 * The plan format is experimental (`PLAN_FORMAT_VERSION` 0) until smaltdf has proven it: it may change in any
 * release until its own stability ADR.
 */
export * from './portable.js';
export { validatePlan, MAX_PLAN_DEPTH, type ValidateCatalog } from './validate.js';
