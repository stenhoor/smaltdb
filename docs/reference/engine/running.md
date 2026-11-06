# Running plans

The engine takes a statement as plan data (`PlanStatementInput`) and plans and runs it like any other statement:
in-process with `smaltdb/engine`, or through a worker with the client.

## Statements

A `PlanStatementInput` is one of:

| Form | Runs |
|---|---|
| A plan operation | A query whose result columns are named `column1`, `column2`, … and typed `any` |
| `{ kind: 'query', plan, columns? }` | A query and its result columns |
| `{ kind: 'write', plan, returning?, source? }` | An `append`, `update` or `delete` plan; `returning` names and types its RETURNING values |
| `{ kind: 'explain', mode: 'plan' \| 'analyze', query }` | The query's physical plan, or the plan with run-time counts |
| `{ kind: 'transaction', … }` | `begin` (with `mode` `deferred`, `immediate` or `exclusive`), `commit`, `rollback` (to an optional `savepoint`), `savepoint`, `release` |
| `{ kind: 'setting', name, value? }` | Read a setting, or set it (`value` an expression over constants and parameters), as SQL's PRAGMA |
| `{ kind: 'maintenance', action, … }` | `analyze` (optional `target`), `vacuum`, or `refresh` a materialized view |
| `{ kind: 'schema', op }` | A [schema operation](./schema) |

A query's `columns` describe its result, each `{ name, type?, declaredType?, collation?, affinity? }`; there must be one
per output column of the plan. `type` defaults to `any`, `collation` to `binary` and `affinity` to `NONE`.

## In-process

| `Database` method | |
|---|---|
| `preparePlan(stmt): PlanStatement` | Compile a statement. A `PlanStatement` has the members of a [`Statement`](../api/engine#statement) (`run`, `all`, `cursor`, `columns`, `columnTypes`, `readonly`, `paramCount`), without `sql`. It compiles again by itself after schema changes. |
| `queryPlan(stmt, params?): QueryResult` | Run a statement and return `{ columns, rows }` (a write: its RETURNING rows). Compiled plans are cached by their canonical form, so running the same plan again, built anew or read from JSON, plans it once. |
| `queryPlanAsync(stmt, params?, options?)` | `queryPlan` for a plan that reads external data: fetches it first. |

```ts
import { Database, plan as p } from 'smaltdb/engine';
import 'smaltql/register';

const db = Database.openMemory();
db.exec("CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT, qty INT); INSERT INTO fruit(name, qty) VALUES ('apple', 3), ('pear', 5), ('plum', 7)");

// UPDATE fruit SET qty = qty + 1 WHERE name = 'PEAR' COLLATE NOCASE
const pear = p.filter(p.scan('fruit', [-1, 1, 2]), p.call('cmp_eq', [p.col(0, 1, 'text'), p.lit('PEAR')], 'int', 'nocase'));
const add = db.preparePlan({ kind: 'write', plan: p.update('fruit', pear, 0, [{ column: 2, value: p.call('add', [p.col(0, 2, 'int'), p.lit(1)], 'int') }]) });
console.log(add.run().changes); // 1

// DELETE FROM fruit WHERE qty > 6 RETURNING name
const many = p.filter(p.scan('fruit', [-1, 2]), p.call('cmp_gt', [p.col(0, 1, 'int'), p.lit(6)], 'int'));
const removed = db.queryPlan({ kind: 'write', plan: p.remove('fruit', many, 0, { returning: [p.col(0, 1, 'text')] }), returning: [{ name: 'name', type: 'text' }] });
console.log(removed.rows); // [['plum']]
```

## Through the client

In a page, the client runs plans in the engine's worker: `db.queryPlan(stmt, params?, options?)` and
`db.preparePlan(stmt)` (see [the client reference](https://stenhoor.github.io/smaltql/reference/api/client#queryplan)). Build them with `smaltdb/plan`, the plan
format without the engine, so that pages which don't build plans don't load it. The plan crosses to the worker as JSON;
results, options, transactions and parallel readers work as for SQL queries.

```ts
import { open } from 'smaltdb';
import * as p from 'smaltdb/plan';

const db = await open('app');
const byId = p.project(p.filter(p.scan('fruit', [0, 1]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.param(0, 'int')], 'int')), [p.col(0, 1, 'text')]);
const rows = await db.queryPlan<{ name: string }>({ kind: 'query', plan: byId, columns: [{ name: 'name', type: 'text' }] }, [2]);
```

## Parameters

Parameters are positional: a plan reads `param` 0, 1, …, and runs with an array of that many values (a statement reads
at most 32766). Integers beyond ±(2^53 − 1) are `bigint`s; blobs are `Uint8Array`s.

## Validation

The engine validates every plan before it plans it, whoever built it. One pass checks:

- operation and expression kinds, and the fields each needs;
- column references: an input the expression has, an enclosing scope that exists, an index below the input's width;
- tables and their columns (`scan`, writes), the widths of `setop` inputs and `iterate` steps, `working` inside its
  `iterate`;
- types, collations and parameters;
- functions: a registered scalar, aggregate or window function, with a number of arguments it accepts;
- nesting depth, at most 1000 levels of operations and expressions together.

An invalid plan fails with [`SMALT_PLAN`](../api/errors#smalt-plan), and the message gives the path to the part that
is wrong:

```ts
import { Database, plan as p } from 'smaltdb/engine';
import 'smaltql/register';

const db = Database.openMemory();
db.exec('CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT, qty INT)');
try {
  db.queryPlan(p.project(p.scan('fruit', [0]), [p.col(0, 5, 'int')]));
} catch (e) {
  console.log((e as Error).message); // invalid plan at plan.exprs[0]: column 5 of input 0, which has 1
}
```

`plan.validatePlan(plan, catalog)` runs the same checks without a database: `catalog.tableColumns(name, db?)` gives a
table's column count (rowid not included), or undefined. It returns the plan's output width.

Errors in a language's own terms (an unknown name, an ambiguous column) come from the language, before it builds a
plan: a plan names nothing that has to be resolved.

## Plans as JSON

| Function | |
|---|---|
| `planToJSON(plan): string` / `planFromJSON(text): PlanOp` | A plan as JSON text. `bigint`s, blobs and non-finite numbers are tagged objects (`{"$bigint":"9007199254740993"}`). |
| `encodePlan(plan): EncodedPlan` / `decodePlan(e): PlanOp` | A plan as an object `structuredClone` can copy (`{ version, plan }`), for `postMessage`. |

Both record `PLAN_FORMAT_VERSION`, and decoding refuses a plan of another version. A decoded plan runs exactly as the
original; the engine validates it like any other.

```ts
import { plan as p } from 'smaltdb/engine';

const text = p.planToJSON(p.filter(p.scan('fruit', [0]), p.call('cmp_gt', [p.col(0, 0, 'int'), p.lit(9007199254740993n)], 'int')));
const again = p.planFromJSON(text);
```
