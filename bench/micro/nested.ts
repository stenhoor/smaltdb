// Lists (ADR 0031): explode and `each` against a function of one list, through the plan API, in process. A table of N rows with
// an id and a list<int> of 10 elements on six rows in seven (empty on the rest); each query's result is one row.
// Run (N rows, default 100,000; rounds, default 5):
//   npm run bench:micro -- nested 100000
import { Database } from '../../src/engine/database.js';
import { plan as p } from '../../src/engine/index.js';
import type { PlanOp } from '../../src/engine/plan/ops.js';
import type { PlanType } from '../../src/engine/plan/types.js';
import type { ColumnDef, StorageType } from '../../src/engine/plan/schema.js';

const N = Number(process.argv[2] ?? 100_000);
const ROUNDS = Number(process.argv[3] ?? 5);
const LIST = 'list<int>' as PlanType;

const db = Database.openMemory();
const column = (name: string, type: StorageType, declaredType: string): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
db.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 't', columns: [column('id', 'INTEGER', 'INTEGER'), column('v', 'LIST', 'list<int>')], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } });
for (let at = 0; at < N; at += 5000) {
  const rows = Array.from({ length: Math.min(5000, N - at) }, (_, k) => {
    const i = at + k;
    const elements = i % 7 === 0 ? [] : Array.from({ length: 10 }, (_, j) => p.lit((i * j) % 97));
    return [p.lit(i), p.call('list_of', elements, LIST)];
  });
  db.queryPlan({ kind: 'write', plan: p.append('t', p.values(rows, ['int', LIST]), [0, 1]) });
}

const t = (): PlanOp => p.scan('t', [0, 1]);
const v = p.col(0, 1, LIST);
const el = p.element('int');
const count = (input: PlanOp): PlanOp => p.aggregate(input, [], [p.agg('count', [], 'int', { star: true })]);
const QUERIES: [string, PlanOp][] = [
  ['sum(list_sum(v))', p.aggregate(t(), [], [p.agg('sum', [p.call('list_sum', [v], 'int')], 'int')])],
  ['count of explode(v)', count(p.explode(t(), 1, LIST))],
  ['explode(v), sum by id, count', count(p.aggregate(p.explode(t(), 1, LIST), [p.col(0, 0, 'int')], [p.agg('sum', [p.col(0, 1, 'int')], 'int')]))],
  ['count where list_contains(v, 5)', count(p.filter(t(), p.call('list_contains', [v, p.lit(5)], 'bool')))],
  ['count of explode(v) where element = 5', count(p.filter(p.explode(t(), 1, LIST), p.call('cmp_eq', [p.col(0, 1, 'int'), p.lit(5)], 'bool')))],
  // The same work by `each` (ADR 0031 step 5), over each row's list, with no explode.
  ['sum(each agg sum(v))', p.aggregate(t(), [], [p.agg('sum', [p.listAgg(v, [{ fn: 'sum', args: [el], star: false, distinct: false, collation: 'binary', type: 'int' }], p.aggResult(0, 'int'))], 'int')])],
  ['sum(list_len(each filter v = 5))', p.aggregate(t(), [], [p.agg('sum', [p.call('list_len', [p.listFilter(v, p.call('cmp_eq', [el, p.lit(5)], 'bool'))], 'int')], 'int')])],
  ['sum(list_sum(each map v * 2))', p.aggregate(t(), [], [p.agg('sum', [p.call('list_sum', [p.listMap(v, p.call('mul', [el, p.lit(2)], 'int'))], 'int')], 'int')])],
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
  console.log(`${name.padEnd(42)} ${median(ms).toFixed(1).padStart(9)} ms   (${String(result)})`);
}
