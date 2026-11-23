---
description: 'A commit, checked against a table''s forgotten history: an error when it is before the table''s horizon.'
---

# history_horizon

```ebnf
history_horizon ::= '"fn": "history_horizon"' ', "args": [' COMMIT ',' TABLE ']'
```

A commit, checked against a table's forgotten history: the commit itself, or an error when it is before the table's
horizon. A table that [keeps history](../../../engine/schema#history) can be read as it was after a commit (`asOf` on a
[`scan`](../../operations/scan)), until a `forget` drops the history before some commit: that commit is the table's
horizon. A read as of a commit before it is checked with this function.

## Parameters

| Argument | Type | |
|---|---|---|
| `COMMIT` | `int` | The commit to read as of. |
| `TABLE` | `text` | The table's name, in any case. |

## Returns

`int`: `COMMIT`. NULL when `COMMIT` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_RANGE` | `COMMIT` is before the table's horizon: its history before the horizon was forgotten. |

## Notes

- The horizon is read when the statement runs, so a plan made before a `forget` still checks against it.
- A table whose history was never forgotten, or that keeps none (or doesn't exist), has the horizon 0: every commit
  passes.
- The horizon only moves forward, and survives reopening the database ([history](../../../engine/schema#history)).
- A [`scan`](../../operations/scan) with `asOf` makes this check itself; a plan that computes a commit another way
  calls it.

## Examples

`fruit` keeps no history, so any commit passes:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int"],
    "rows": [[
      {"k": "call", "fn": "history_horizon", "args": [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": "fruit", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "history_horizon", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": "fruit", "type": "text"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "commit"}, {"name": "null"}]
}
```

| commit | null |
|---|---|
| 3 | NULL |

A table that keeps history, written to, then its history before commit 3 forgotten:

```json
{"kind": "schema", "op": {"op": "createTable", "temp": false, "ifNotExists": false, "table": {"name": "stock", "storage": "row", "history": "versions", "columns": [{"name": "id", "declaredType": "INTEGER", "type": "INTEGER", "notNull": false, "collation": "binary"}, {"name": "qty", "declaredType": "INTEGER", "type": "INTEGER", "notNull": false, "collation": "binary"}], "keys": [{"kind": "primaryKey", "columns": [{"column": 0, "desc": false, "collation": "binary"}]}], "checks": [], "foreignKeys": []}}}
```

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "stock",
    "db": "main",
    "input": {"op": "values", "types": ["int", "int"], "rows": [[{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 10, "type": "int"}]]},
    "columns": [0, 1],
    "upserts": []
  }
}
```

```json
{"kind": "maintenance", "action": "forget", "before": {"commit": {"k": "lit", "value": 3, "type": "int"}}, "table": "stock"}
```

Commit 2 is before the horizon:

<!-- docs:error SMALT_RANGE -->
```json
{"op": "values", "types": ["int"], "rows": [[{"k": "call", "fn": "history_horizon", "args": [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": "stock", "type": "text"}], "type": "int"}]]}
```

## Demo

Commits checked against `stock`'s horizon: commit 3, the horizon itself, and those after it pass. The table's name
may be in any case:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int"],
    "rows": [[
      {"k": "call", "fn": "history_horizon", "args": [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": "stock", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "history_horizon", "args": [{"k": "lit", "value": 5, "type": "int"}, {"k": "lit", "value": "STOCK", "type": "text"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "at_horizon"}, {"name": "after"}]
}
```

| at_horizon | after |
|---|---|
| 3 | 5 |

## See also

- [`scan`](../../operations/scan): `asOf`
- [History](../../../engine/schema#history)
- [Database state functions](./)
