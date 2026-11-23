---
description: 'The plan language: smaltdb''s own language, plans written as JSON, which every other language builds.'
---

# The plan language

smaltdb runs **plans**: trees of operations over rows, with expressions over the rows' columns, given as plain data.
Every language on the engine turns its own text into plans, and an application can write plans itself. Written as
JSON, the plan format is a language of its own, and these pages describe it like one: a syntax diagram for every part,
a page for every operation, expression and function, and examples that run.

::: warning Experimental
The plan format is experimental (`PLAN_FORMAT_VERSION` is `1`). It may change in any release until its stability ADR
([ADR 0014](../../adr/0014-shared-plan-layer.md), [ADR 0015](../../adr/0015-smaltql.md)).
:::

## One query, every language

The fruit in stock, dearest first. In SQL, with [smaltql](https://stenhoor.github.io/smaltql/):

```sql
SELECT name, price FROM fruit WHERE qty > 0 ORDER BY price DESC
```

| name | price |
|---|---|
| cherry | 3 |
| pear | 0.75 |
| apple | 0.5 |

In smaltdf, [the dataframe language](https://stenhoor.github.io/smaltdf/):

<!-- docs:skip -->
```ts
import { col, table } from '@smaltworks/smaltdf';

await table('fruit').filter(col('qty').gt(0)).sort('price', { descending: true }).select('name', 'price').collect(db);
```

And as a plan: a `scan` of the table, a `filter`, a `sort` and a `project`, each reading the one below it. Columns
are positions: `qty` is column 4 of `fruit`, and after the `project`, `price` is column 1.

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "project",
      "input": {
        "op": "filter",
        "input": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
        "pred": {"k": "call", "fn": "cmp_gt", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 0, "type": "int"}
        ], "type": "bool"}
      },
      "exprs": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| cherry | 3 |
| pear | 0.75 |
| apple | 0.5 |

The plan a language builds says more than this one: SQL's comparison applies SQLite's affinity, and its nodes carry
where in the text they came from. `db.boundPlan(sql)` gives the plan SQL binds a statement to, and smaltdf's
`frame.plan(db)` the plan a frame runs as. Either can be stored as JSON, read back and run with `queryPlan`.

## The rules

- **Columns are positions.** An expression reads column `index` of input `input` of the operation that holds it
  ([`col`](./expressions/col)), never a name. Each operation's page says which columns it gives.
- **Nothing is implicit.** Every value has a static [type](./types), every comparison, sort and grouping names its
  [collation](./collations), and every conversion is a [`cast`](./expressions/cast) or a function
  [`call`](./expressions/call). Behaviour that differs between languages is in the engine's operations, named for
  what they do: a language picks the ones that give its meaning ([functions](./functions/)).
- **NULL is three-valued.** Conditions are 1 (true), 0 (false) or NULL. A filter keeps the rows whose condition is 1.
- **Plans are data.** No closures and no names to resolve: a plan survives JSON, and the engine
  [validates](../engine/running#validation) every plan it is given, built or written by hand, before it plans it.

## The language

| Page | |
|---|---|
| [Sample data](./sample-data) | The tables and the graph the examples run on |
| [Statements](./statements) | What a plan statement is: a query, a write, EXPLAIN, a transaction, a setting, maintenance, a schema change |
| [Types](./types) | The plan types, and how a list, struct or map type is written |
| [Collations](./collations) | How text compares and sorts |
| [Conversions](./conversions) | How a value of one type becomes one of another |
| [Values in JSON](./values) | Literals, tagged values, and values given as columns |
| [Meaning fields](./meaning-fields) | `carries`, `affinity`, `inline`, `decorrelate` and `origin` |
| [Order](./order) | The order of rows: what each operation keeps, and what is defined by it |
| [Plan shapes](./shapes) | Which trees are plans |
| [Writing a property graph](./graph-writes) | The rules the graph writes share, and the order they run in |
| [Builders](./builders) | Building plans in TypeScript with `smaltdb/plan` |
| [Operations](./operations/) | A page for each operation |
| [Expressions](./expressions/) | A page for each kind of expression |
| [Functions](./functions/) | A page for each function |
| [For AI agents](./agents) | How an agent writes plans, and the agent guide |

The grammar the diagrams are drawn from is one file, [`docs/grammar.ebnf`](https://github.com/stenhoor/smaltdb/blob/main/docs/grammar.ebnf), in W3C EBNF. A
statement in full:

```railroad
statement
```

## Running a plan

In process, with `smaltdb/engine`:

```ts
import { Database, type plan } from 'smaltdb/engine';

const db = Database.openMemory();
const stmt = JSON.parse('{"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 42, "type": "int"}]]}') as plan.PlanStatementInput;
console.log(db.queryPlan(stmt).rows); // [[42]]
```

In a page, the client runs plans in the engine's worker with `db.queryPlan(stmt)`. [Running plans](../engine/running)
has both, parameters, writes and plans with data. Values that JSON can't hold (bigints, blobs, typed arrays) are
written as [tagged values](./values); `plan.planToJSON` and `plan.planFromJSON` write and read a plan with them.
