// Maps (ADR 0038): filters on one key of a map<text, any> column, through the plan API, in process. A table of N rows
// with a name (text) and props, a map of eight keys like a graph node's (text, int, real, a bool and a list kept as typed
// values under `any`, ADR 0039); one in ten rows also has an 'extra' key. Each query's result is one count or sum. The
// first query filters the plain column, for comparison; the last two read a key of every row's map.
// Run (N rows, default 20,000; rounds, default 7):
//   npm run bench:micro -- map-get 20000
import { Database } from '../../src/engine/database.js';
import { plan as p } from '../../src/engine/index.js';
import type { PlanExpr } from '../../src/engine/plan/expr.js';
import type { PlanOp } from '../../src/engine/plan/ops.js';
import type { PlanType } from '../../src/engine/plan/types.js';
import type { ColumnDef, StorageType } from '../../src/engine/plan/schema.js';

const N = Number(process.argv[2] ?? 20_000);
const ROUNDS = Number(process.argv[3] ?? 7);
const M = 'map<text, any>' as PlanType;
const CITIES = ['Lisbon', 'Oslo', 'Kyoto', 'Lima', 'Accra'];

const db = Database.openMemory();
const column = (name: string, type: StorageType, declaredType: string): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
db.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 't', columns: [column('name', 'TEXT', 'TEXT'), column('props', 'MAP', M)], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } });
for (let at = 0; at < N; at += 5000) {
  const names: string[] = [];
  const props: Record<string, unknown>[] = [];
  for (let i = at; i < Math.min(at + 5000, N); i++) {
    names.push(`person ${i}`);
    const m: Record<string, unknown> = { active: i % 3 === 0, age: 18 + (i % 60), born: 1950 + (i % 50), city: CITIES[i % 5], email: `p${i}@example.com`, name: `person ${i}`, score: (i % 1000) / 10, tags: ['a', 'b'] };
    if (i % 10 === 0) m.extra = 'x';
    props.push(m);
  }
  db.queryPlan({ kind: 'write', plan: p.append('t', p.fromColumns([names, props] as never, ['text', M]), [0, 1]) });
}

const t = (): PlanOp => p.scan('t', [0, 1]);
const props = p.col(0, 1, M);
const get = (key: string): PlanExpr => p.call('map_get', [props, p.lit(key)], 'any');
const count = (pred: PlanExpr): PlanOp => p.aggregate(p.filter(t(), pred), [], [p.agg('count', [], 'int', { star: true })]);
const eq = (a: PlanExpr, b: PlanExpr): PlanExpr => p.call('cmp_eq', [a, b], 'bool');
const QUERIES: [string, PlanOp][] = [
  ["name = 'person 77' (a text column)", count(eq(p.col(0, 0, 'text'), p.lit('person 77')))],
  ["map_get(props, 'name') = 'person 77'", count(eq(get('name'), p.lit('person 77')))],
  ["map_get(props, 'age') = 30 (2nd key)", count(eq(get('age'), p.lit(30)))],
  ["map_get(props, 'tags') is not null (last)", count(p.not(p.isNull(get('tags'))))],
  ["map_get(props, 'nope') is not null", count(p.not(p.isNull(get('nope'))))],
  ["map_contains_key(props, 'extra')", count(p.call('map_contains_key', [props, p.lit('extra')], 'bool'))],
  ["map_get(props, 'city') = 'Oslo'", count(eq(get('city'), p.lit('Oslo')))],
  // Not a WHERE: map_get on each row's decoded map.
  ["sum(map_get(props, 'age'))", p.aggregate(t(), [], [p.agg('sum', [get('age')], 'any')])],
  ["sum(map_get(props, 'score')) (7th key)", p.aggregate(t(), [], [p.agg('sum', [get('score')], 'any')])],
];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

console.log(`node ${process.version}, ${N} rows, median of ${ROUNDS} runs after one warm-up\n`);
for (const [name, plan] of QUERIES) {
  db.queryPlan(plan);
  const ms: number[] = [];
  let result: unknown;
  for (let i = 0; i < ROUNDS; i++) {
    const s = performance.now();
    result = db.queryPlan(plan).rows[0][0];
    ms.push(performance.now() - s);
  }
  console.log(`${name.padEnd(44)} ${median(ms).toFixed(2).padStart(9)} ms   (${String(result)})`);
}
