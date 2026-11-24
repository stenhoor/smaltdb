---
description: 'Gathers statistics, forgets history, or refreshes a materialized view.'
---

# maintenance

```railroad
maintenance-statement
as-of
```

Gathers the statistics the planner reads, forgets history, or refreshes a materialized view. `vacuum` is in the
grammar, but not supported yet.

## Fields

| `action` | Fields | |
|---|---|---|
| `analyze` | optional `target`, `schema` | Gathers the statistics the planner reads, for one table or index (`target`), or for all of them. |
| `forget` | `before`, optional `table` | Forgets history: the versions of `table`, or of every table that [keeps history](../../engine/schema#history), that no read as of `before` or later needs. `before` is `{"commit": …}` (a commit id) or `{"time": …}` (the last commit at or before that time, in milliseconds since 1970), an expression over constants and parameters. |
| `refresh` | `view`, optional `schema`, `concurrently`, `withData`, `ifChanged` | Refreshes a materialized view: runs its query again and stores the rows ([schema definitions](../../engine/schema)). |
| `vacuum` | | Refused: `SMALT_UNSUPPORTED`. |

## Result

No rows.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `analyze` names a table or index that doesn't exist; `refresh` names no materialized view; `forget` names a table that keeps no history. |
| `SMALT_UNSUPPORTED` | `vacuum`. |

After a `forget`, reading a table as of an earlier commit is `SMALT_RANGE`.

## Notes

- `forget` keeps what reads as of `before` or later need, so the table as of `before` reads as it did.
- `history_horizon` ([database state functions](../functions/database/)) gives the earliest commit a table can still be
  read as of.

## Examples

```json
{"kind": "maintenance", "action": "analyze", "target": "fruit"}
```

A table that doesn't exist:

<!-- docs:error SMALT_ERROR -->
```json
{"kind": "maintenance", "action": "analyze", "target": "fruits"}
```

<!-- docs:error SMALT_UNSUPPORTED -->
```json
{"kind": "maintenance", "action": "vacuum"}
```

## Demo

A table that keeps history, a row written and changed, and the history before the change forgotten:

```json
{
  "kind": "schema",
  "op": {
    "op": "createTable",
    "temp": false,
    "ifNotExists": false,
    "table": {
      "name": "stock",
      "storage": "row",
      "history": "versions",
      "columns": [
        {"name": "id", "declaredType": "INTEGER", "type": "INTEGER", "notNull": false, "collation": "binary"},
        {"name": "n", "declaredType": "INTEGER", "type": "INTEGER", "notNull": false, "collation": "binary"}
      ],
      "keys": [{"kind": "primaryKey", "columns": [{"column": 0, "desc": false, "collation": "binary"}]}],
      "checks": [],
      "foreignKeys": []
    }
  }
}
```

```json
{
  "kind": "write",
  "plan": {
    "op": "append", "table": "stock", "db": "main", "columns": [0, 1], "upserts": [],
    "input": {"op": "values", "types": ["int", "int"], "rows": [[{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 5, "type": "int"}]]}
  }
}
```

```json
{
  "kind": "write",
  "plan": {
    "op": "update", "table": "stock", "db": "main", "rowid": 0, "from": false,
    "input": {"op": "scan", "table": "stock", "columns": [-1]},
    "sets": [{"column": 1, "value": {"k": "lit", "value": 7, "type": "int"}}]
  }
}
```

The two writes are the last two commits `smalt_commits` lists. Commit ids count up across the database, so
they depend on what ran before:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {"op": "scan", "table": "smalt_commits", "columns": [0]},
    "keys": [{"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}]
  },
  "columns": [{"name": "commit"}]
}
```

| commit |
|---|
| 18 |
| 19 |

As of commit 18, `n` was 5:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "stock", "columns": [1], "asOf": {"commit": {"k": "lit", "value": 18, "type": "int"}}},
  "columns": [{"name": "n"}]
}
```

| n |
|---|
| 5 |

Forget what comes before commit 19:

```json
{"kind": "maintenance", "action": "forget", "before": {"commit": {"k": "lit", "value": 19, "type": "int"}}, "table": "stock"}
```

Commit 19 still reads; commit 18 no longer does:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "stock", "columns": [1], "asOf": {"commit": {"k": "lit", "value": 19, "type": "int"}}},
  "columns": [{"name": "n"}]
}
```

| n |
|---|
| 7 |

<!-- docs:error SMALT_RANGE -->
```json
{"op": "scan", "table": "stock", "columns": [1], "asOf": {"commit": {"k": "lit", "value": 18, "type": "int"}}}
```

## See also

- [History](../../engine/schema#history), [`scan`](../operations/scan)'s `asOf`
- [Statements](./)
