/**
 * `SMALT_PLAN` selects how SELECTs are planned while the plan layer (ADR 0014) is built:
 *
 * - unset or `plan` (the default): the SQL front end (sql/frontend/select.ts) makes a plan and the physical planner
 *   (`Planner.planPlan`) builds its operators; what either does not handle yet goes through the AST path;
 * - `legacy`: the planner's AST path (`Planner.planSelect`), until it is deleted after step 8;
 * - `shadow` (tests): both. The front end must agree with the planner on the result columns (name, type, collation,
 *   declared type, affinity) and on errors, and the physical planner's operators on the planner's `EXPLAIN` rows; the
 *   physical planner's operators then run. A disagreement raises SMALT_INTERNAL, so the test suite, the differential
 *   tests and sqllogictest check the new path. Shapes not handled yet are skipped.
 */
import { SmaltError } from '../errors.js';
import type { SelectStmt } from '../sql/ast.js';
import { type FrontEndCatalog, type FrontEndResult, toPlan } from '../sql/frontend/select.js';
import { explainRows } from './operators.js';
import type { QueryPlan } from './planner.js';

let mode: string | undefined | null = null;

/** The planning mode (`SMALT_PLAN`). */
export function planMode(): 'legacy' | 'plan' | 'shadow' {
  if (mode === null) {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    mode = g.process?.env?.SMALT_PLAN;
  }
  return mode === 'legacy' || mode === 'shadow' ? mode : 'plan';
}

/** @internal Tests: set the planning mode (null: read `SMALT_PLAN` again). */
export function setPlanMode(m: 'legacy' | 'plan' | 'shadow' | null): void {
  mode = m;
}

/** True when SELECTs are checked against the SQL front end. */
export function planShadowEnabled(): boolean {
  return planMode() === 'shadow';
}

/** Statements checked and skipped so far, with the reasons for skipping. */
export const shadowStats = { checked: 0, skipped: 0, physical: 0, reasons: {} as Record<string, number> };

// SMALT_PLAN_STATS=<file>: append each skipped statement as a JSON line (reason, text), so a corpus run shows what the
// front end does not handle yet. Node only, through its built-in fs (test runners use several workers).
type Proc = { env?: Record<string, string | undefined>; getBuiltinModule?(name: string): unknown };
const proc = (globalThis as { process?: Proc }).process;
const statsFile = proc?.env?.SMALT_PLAN_STATS;
const statsFs = statsFile ? (proc?.getBuiltinModule?.('fs') as { appendFileSync(f: string, s: string): void } | undefined) : undefined;

function skip(reason: string, text: string): void {
  shadowStats.skipped++;
  shadowStats.reasons[reason] = (shadowStats.reasons[reason] ?? 0) + 1;
  if (statsFile && statsFs) statsFs.appendFileSync(statsFile, JSON.stringify({ reason, text }) + '\n');
}

function mismatch(text: string, what: string): SmaltError {
  return new SmaltError('SMALT_INTERNAL', `SMALT_PLAN=shadow: the SQL front end disagrees with the planner on ${what}\n  in: ${text}`);
}

const describe = (e: unknown): string => (e instanceof Error ? `${(e as { code?: string }).code ?? e.name}: ${e.message}` : String(e));

/**
 * Plan `stmt` with `legacy` (the current planner) and check the SQL front end against it; then, when `physical`
 * builds operators for the front end's plan, check their `EXPLAIN` rows against the planner's and return them.
 */
export function shadowCheck(
  stmt: SelectStmt,
  text: string,
  catalog: FrontEndCatalog,
  legacy: () => QueryPlan,
  rewriteSelect: ((select: SelectStmt, text: string) => SelectStmt | null) | undefined,
  physical?: (fe: FrontEndResult) => QueryPlan | null,
): QueryPlan {
  let fe: FrontEndResult | null = null;
  let feError: unknown;
  let unsupported = '';
  try {
    fe = toPlan(stmt, text, catalog, (reason) => (unsupported = reason), rewriteSelect);
  } catch (e) {
    feError = e ?? new Error('undefined');
  }
  let plan: QueryPlan;
  try {
    plan = legacy();
  } catch (e) {
    // Only planning errors are compared; others (an interrupt, a storage error) are not the front end's business.
    const code = (e as { code?: string }).code;
    if (code !== 'SMALT_ERROR' && code !== 'SMALT_UNSUPPORTED') throw e;
    if (feError !== undefined) {
      if (describe(feError) !== describe(e)) throw mismatch(text, `the error: front end ${describe(feError)}; planner ${describe(e)}`);
      shadowStats.checked++;
    } else if (fe !== null) throw mismatch(text, `whether it is valid: the planner raised ${describe(e)}`);
    else skip(unsupported, text);
    throw e;
  }
  if (feError !== undefined) throw mismatch(text, `whether it is valid: the front end raised ${describe(feError)}`);
  if (fe === null) {
    skip(unsupported, text);
    return plan;
  }
  shadowStats.checked++;
  if (fe.columns.length !== plan.columns.length) throw mismatch(text, `the number of result columns: ${fe.columns.length} vs ${plan.columns.length}`);
  plan.columns.forEach((want, i) => {
    const got = fe!.columns[i];
    for (const k of ['name', 'type', 'collation', 'declType', 'affinity'] as const) {
      if ((got[k] ?? undefined) !== (want[k] ?? undefined)) throw mismatch(text, `result column ${i + 1} ${k}: front end ${String(got[k])}, planner ${String(want[k])}`);
    }
  });
  if (!physical) return plan;
  const p = physical(fe);
  if (!p) {
    // Listed for SMALT_PLAN_STATS, not counted as skipped: the front end's plan was checked.
    if (statsFile && statsFs) statsFs.appendFileSync(statsFile, JSON.stringify({ reason: 'physical planner: not handled yet', text }) + '\n');
    return plan;
  }
  shadowStats.physical++;
  const rows = (q: QueryPlan): string => explainRows(q.root).map((x) => `${x.id} ${x.parent} ${x.detail}`).join('\n');
  const want = rows(plan);
  const got = rows(p);
  if (got !== want) throw new SmaltError('SMALT_INTERNAL', `SMALT_PLAN=shadow: the physical planner disagrees with the planner on EXPLAIN\n  in: ${text}\nphysical:\n${got}\nplanner:\n${want}`);
  return p;
}
