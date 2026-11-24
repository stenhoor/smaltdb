---
description: 'For AI agents that write plans for smaltdb: how to run them, the rules a plan follows, and where the complete agent guide is.'
---

# For AI agents

This page is written for AI agents that write plans for smaltdb, and it opens the agent guide. The site publishes
Markdown made for agents beside its pages:

- [`/agents.md`](https://smaltdb.dev/agents.md): this page, then the plan grammar as EBNF, the plan language pages,
  every operation, expression and function, running plans, schema operations and the error codes, in one file. Every
  example in it is tested, with its result.
- [`/llms.txt`](https://smaltdb.dev/llms.txt): an index of every page, each as Markdown.
- Any page as Markdown: its address with `.md`, such as
  [`reference/plan/statements/query.md`](https://smaltdb.dev/reference/plan/statements/query.md).

## What a plan is

smaltdb is an embedded database engine for browsers and Node, written in TypeScript. It reads no query language of
its own: it runs plans, trees of operations over rows with expressions over their columns, written as JSON.
Languages (SQL in `@smaltworks/smaltql`, dataframes in `@smaltworks/smaltdf`) build plans; an agent can write them
directly. The format is experimental (plan format version 1).

## How to run one

```ts
import { Database, type plan } from 'smaltdb/engine';

const db = Database.openMemory(); // in a page: open() from 'smaltdb', with the engine in a worker
const stmt: plan.PlanStatementInput = {
  kind: 'query',
  plan: { op: 'values', types: ['int'], rows: [[{ k: 'col', input: 0, index: 0, depth: 0, type: 'int', collation: 'binary' }]] },
};
try {
  db.queryPlan(stmt);
} catch (e) {
  // SMALT_PLAN: a values row reads no columns. The message names the path: plan.rows[0][0].
  console.log((e as { code?: string }).code);
}
const rows = db.queryPlan({ kind: 'query', plan: { op: 'scan', table: 'sqlite_schema', columns: [1] } }).rows;
```

- `db.queryPlan(stmt, params?)` runs a statement and gives `{ columns, columnTypes, rows }`; `db.preparePlan(stmt)`
  compiles it once to run many times. A statement is JSON-shaped data ([statements](./statements/)).
- **Validate by running.** The engine validates every plan before it plans it. A plan that breaks a rule fails with
  `SMALT_PLAN`, and the message gives the path of the node at fault (`plan.input.pred.args[0]`).
- **Pass values as parameters** (`{"k": "param", "index": 0, "type": "text"}` and `queryPlan(stmt, ['Ada'])`) rather
  than writing them into the plan.
- **Errors** have a `code`: [error codes](../api/errors).

## The rules a plan follows

- **Columns are positions.** A [`col`](./expressions/col) reads column `index` of input `input` of the operation that
  holds the expression; `depth` is 0 except in a correlated subquery. Count the columns each operation gives: its page
  says which. A [`join`](./operations/join)'s output is the left input's columns, then the right's.
- **Every expression is typed.** A [`call`](./expressions/call) states the type of its value; a
  [`lit`](./expressions/lit) states its type. Use the [plan types](./types): `int`, `real`, `text`, `bool`, `date`,
  `list<int>`, …
- **Comparisons are calls** ([`cmp_eq`](./functions/comparison/cmp_eq), `cmp_lt`, …), declared `bool`. Text compares
  by the call's `collation` (`binary` when absent).
- **Every sort key, grouping key and aggregate names its collation**: `binary` unless the comparison should ignore
  case (`nocase`).
- **Literals are numbers, strings or null**, and the [tagged values](./values) for bigints, blobs and non-finite
  reals. A list, struct or map is made by a call (`list_of`, `struct_of`, `map_of`); a date by `cast_date` on text.
- **Rows come in no order** unless a [`sort`](./operations/sort) gives one ([order](./order)).
- **Aggregates are calls of an [`aggregate`](./operations/aggregate) operation**, not expressions; `count(*)` is
  `{"fn": "count", "args": [], "star": true, …}`.
- **Write statements** hold an `append`, `update`, `delete` or graph write, as `{"kind": "write", "plan": …}`.

## Writing a plan from SQL

Where a SQL language is registered, `db.boundPlan(sql)` gives the plan SQL binds a statement to: a working starting
point to read or change. It carries SQL's meaning fields (`affinity`, `carries`, `origin`), which a plan written by
hand can leave out.
