---
description: 'A plan statement: a query, a write, EXPLAIN, a transaction, a setting, maintenance or a schema change, as JSON.'
---

# Statements

A plan statement is what `queryPlan` and `preparePlan` take ([running plans](../engine/running)): a JSON object whose
`kind` says what it does, or an operation by itself, which is a query.

```railroad
statement
```

## Queries {#query}

```railroad
query-statement
result-column
```

A query runs its plan and gives its rows. `columns` describes them, one for each column the plan gives (`SMALT_PLAN`
otherwise): a column's `name`, and what the engine knows of its values. Each field but `name` may be left out:

| Field | Default | |
|---|---|---|
| `type` | the type the plan gives the column | Its [plan type](./types) |
| `declaredType` | none | The declared type of the table column it reads directly, as the result's metadata gives it |
| `collation` | `binary` | The [collation](./collations) its text compares by, where the result is compared again (a view's column) |
| `affinity` | `NONE` | SQLite's column affinity, which comparisons with the column apply (`INTEGER`, `REAL`, `NUMERIC`, `TEXT`, `BLOB`) |

Without `columns`, or as a bare operation, the columns are named `column1`, `column2`, … and typed from the plan.

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "fruit", "columns": [1, 3]},
  "columns": [{"name": "name"}, {"name": "price", "type": "real"}]
}
```

| name | price |
|---|---|
| apple | 0.5 |
| pear | 0.75 |
| plum | 1.25 |
| cherry | 3 |
| lime | 0.4 |

Described columns must match the plan's:

<!-- docs:error SMALT_PLAN -->
```json
{"kind": "query", "plan": {"op": "scan", "table": "fruit", "columns": [1]}, "columns": [{"name": "a"}, {"name": "b"}]}
```

## Writes {#write}

```railroad
write-statement
returned-column
```

A write runs a plan that writes: an [`append`](./operations/append), [`update`](./operations/update) or
[`delete`](./operations/delete), or a plan that [writes a property graph](./graph-writes). Its rows are what the
plan gives back: an append's, update's or delete's `returning` rows, or a graph write's rows. `returning` names them,
one for each (a column without a `type` has the type the plan gives it); without it they are named `column1`, ….
`source` describes an append's input columns, as `columns` does a query's. The result also counts the rows written
(`changes`), gives the last rowid an append made (`lastInsertRowid`), and what a graph write did (`graph`).

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "fruit",
    "db": "main",
    "input": {"op": "values", "types": ["text", "real", "int"], "rows": [[
      {"k": "lit", "value": "kiwi", "type": "text"},
      {"k": "lit", "value": 0.6, "type": "real"},
      {"k": "lit", "value": 8, "type": "int"}
    ]]},
    "columns": [1, 3, 4],
    "upserts": [],
    "returning": [
      {"k": "col", "input": 0, "index": 5, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
    ]
  },
  "returning": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 6 | kiwi |

A `returning` expression reads the row written: the table's columns, then its rowid (column 5 of `fruit`).

## EXPLAIN {#explain}

```railroad
explain-statement
```

The plan the engine picked for a query (`mode` `plan`), or that plan with the counts of a run (`analyze`), as rows of
`id`, `parent`, `notused` and `detail`.

```json
{
  "kind": "explain",
  "mode": "plan",
  "query": {
    "kind": "query",
    "plan": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
      "pred": {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "bool"}
    }
  }
}
```

| id | parent | notused | detail |
|---|---|---|---|
| 1 | 0 | 0 | SCAN fruit (fused scan + filter) |

## Transactions {#transaction}

```railroad
transaction-statement
commit-note
```

`begin` (in mode `deferred`, `immediate` or `exclusive`), `commit`, `rollback` (to a savepoint, when it names one),
`savepoint` and `release`, as SQL's. `begin` and `commit` take an `author` and a `message` (text; `commit`'s win): a
commit that changes something records them with its id and time in `smalt_commits`, which the engine alone writes.
Each gives no rows.

A transaction around a delete, rolled back:

```json
{"kind": "transaction", "action": "begin", "mode": "deferred"}
```

```json
{
  "kind": "write",
  "plan": {"op": "delete", "table": "orders", "db": "main", "input": {"op": "scan", "table": "orders", "columns": [-1]}, "rowid": 0}
}
```

```json
{
  "kind": "query",
  "plan": {"op": "aggregate", "input": {"op": "scan", "table": "orders", "columns": [0]}, "keys": [], "carry": [],
    "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}]},
  "columns": [{"name": "orders"}]
}
```

| orders |
|---|
| 0 |

```json
{"kind": "transaction", "action": "rollback"}
```

```json
{
  "kind": "query",
  "plan": {"op": "aggregate", "input": {"op": "scan", "table": "orders", "columns": [0]}, "keys": [], "carry": [],
    "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}]},
  "columns": [{"name": "orders"}]
}
```

| orders |
|---|
| 6 |

## Settings {#setting}

```railroad
setting-statement
```

A setting by name, as SQL's PRAGMA: read it (a row with its value), or set it to `value`, an expression over
constants and parameters (no rows). `schema` names the schema a setting of one applies to.

```json
{"kind": "setting", "name": "foreign_keys"}
```

| foreign_keys |
|---|
| 1 |

## Maintenance {#maintenance}

```railroad
maintenance-statement
```

| `action` | |
|---|---|
| `analyze` | Gathers the statistics the planner reads, for one table or index (`target`) or all of them |
| `vacuum` | Not supported yet: refused with `SMALT_UNSUPPORTED` |
| `forget` | Forgets history: the versions of `table` (or of every table that [keeps history](../engine/schema#history)) that no read as of `before` or later needs. `before` is `{"commit": …}` or `{"time": …}` (ms since 1970), an expression over constants and parameters. Reading as of an earlier commit is then `SMALT_RANGE` |
| `refresh` | Refreshes a materialized view: `concurrently`, `withData` and `ifChanged` as [the schema page](../engine/schema) describes |

```json
{"kind": "maintenance", "action": "analyze", "target": "fruit"}
```

<!-- docs:error SMALT_UNSUPPORTED -->
```json
{"kind": "maintenance", "action": "vacuum"}
```

## Schema changes {#schema}

```railroad
schema-statement
```

`op` is a schema operation: `createTable`, `createIndex`, `createView`, `createConnection`, `createExternalTable`,
`createPropertyGraph`, `alterPropertyGraph`, `drop` or `alterTable`. [Schema definitions](../engine/schema) describes
each, with its fields. The engine validates a schema operation given as data before it runs it.

```json
{
  "kind": "schema",
  "op": {
    "op": "createTable",
    "temp": false,
    "ifNotExists": false,
    "table": {
      "name": "shelf",
      "storage": "row",
      "columns": [
        {"name": "id", "declaredType": "INTEGER", "type": "INTEGER", "notNull": false, "collation": "binary"},
        {"name": "label", "declaredType": "TEXT", "type": "TEXT", "notNull": true, "collation": "nocase"}
      ],
      "keys": [{"kind": "primaryKey", "columns": [{"column": 0, "desc": false, "collation": "binary"}]}],
      "checks": [],
      "foreignKeys": []
    }
  }
}
```

The new table is there for the plans after it:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "shelf", "columns": [0, 1]},
  "columns": [{"name": "id"}, {"name": "label"}]
}
```

| id | label |
|---|---|
