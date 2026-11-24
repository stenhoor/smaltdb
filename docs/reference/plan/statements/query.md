---
description: 'A plan whose rows are the result, with its result columns described.'
---

# query

```railroad
query-statement
result-column
```

A plan whose rows are the result, with its result columns described. An operation given by itself is a query too.

## Fields

| Field | Type | |
|---|---|---|
| `plan` | [operation](../operations/) | The plan whose rows the query gives. |
| `columns` | result columns | Optional: one for each column the plan gives, in order. Without it, the columns are named `column1`, `column2`, … and typed from the plan. |

A result column:

| Field | Default | |
|---|---|---|
| `name` | required | The column's name in the result |
| `type` | the type the plan gives the column | Its [plan type](../types) |
| `declaredType` | none | The declared type of the table column it reads directly, as the result's metadata gives it |
| `collation` | `binary` | The [collation](../collations) its text compares by, where the result is compared again (a view's column) |
| `affinity` | `NONE` | SQLite's column affinity, which comparisons with the column apply: `INTEGER`, `REAL`, `NUMERIC`, `TEXT`, `BLOB` or `NONE` |

## Result

The plan's rows, as `{ columns, columnTypes, rows }`: the names, the plan types and the values.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The plan is not valid, or `columns` describes another number of columns than the plan gives. |

## Notes

- The plan may read [parameters](../expressions/param): `queryPlan(stmt, [4])`.
- Rows come in no promised order unless the plan's top keeps one ([order](../order)).
- A query that writes is a [`write`](./write), not a query.

## Examples

Two columns of `fruit`, named, one restating its type:

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

An operation by itself: its columns are named `column1`, `column2`, …:

```json
{"op": "scan", "table": "fruit", "columns": [1]}
```

| column1 |
|---|
| apple |
| pear |
| plum |
| cherry |
| lime |

Described columns must match the plan's:

<!-- docs:error SMALT_PLAN -->
```json
{"kind": "query", "plan": {"op": "scan", "table": "fruit", "columns": [1]}, "columns": [{"name": "a"}, {"name": "b"}]}
```

## Demo

The fruit that cost more than a parameter, dearest first:

<!-- docs:params [0.6] -->
```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
      "pred": {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "param", "index": 0, "type": "real"}
      ], "type": "bool"}
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
| plum | 1.25 |
| pear | 0.75 |

## See also

- [`explain`](./explain): the plan the engine picks for a query
- [Running plans](../../engine/running)
- [Statements](./)
