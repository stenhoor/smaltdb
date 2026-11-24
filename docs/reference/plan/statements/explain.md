---
description: 'The plan the engine picked for a query, or that plan with the counts of a run.'
---

# explain

```railroad
explain-statement
```

The plan the engine picked for a query, or that plan with the counts of a run, one row per step of it.

## Fields

| Field | Type | |
|---|---|---|
| `mode` | `"plan"` or `"analyze"` | `plan`: the plan, without running it. `analyze`: the plan, run, with what each step did. |
| `query` | [query](./query) | The query to explain. |

## Result

With `mode` `plan`, a row per step: `id`, `parent` (the step it feeds, 0 for none), `notused` (0) and `detail`, the
step in words, as SQLite's EXPLAIN QUERY PLAN gives them.

With `mode` `analyze`, the query runs, and each row has `id`, `parent`, `detail`, `est_rows` (the planner's estimate
of its rows, or NULL), `loops` (how many times it ran), `rows` (the rows it gave) and `time_ms` (the time it took).

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `query` is not a query, or its plan is not valid. |

An `analyze` raises the errors the query raises when it runs.

## Notes

- The plan is the engine's, after its rewrites: a [`paths`](../operations/paths) shows as the `iterate` it becomes,
  and a search of [the graph index](../../engine/schema#the-graph-index) as `SEARCH … USING GRAPH INDEX`.
- The words of `detail` show how the engine runs a plan; they can change in any release.
- `analyze` times change from run to run, so the examples here use `plan`.

## Examples

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

A query by itself is not what `explain` takes:

<!-- docs:error SMALT_PLAN -->
```json
{"kind": "explain", "mode": "plan", "query": {"op": "scan", "table": "fruit", "columns": [1]}}
```

## Demo

A lookup by the primary key reads one row through it rather than the whole table:

```json
{
  "kind": "explain",
  "mode": "plan",
  "query": {
    "kind": "query",
    "plan": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "bool"}
    }
  }
}
```

| id | parent | notused | detail |
|---|---|---|---|
| 1 | 0 | 0 | SEARCH fruit USING INTEGER PRIMARY KEY (rowid=?) |

## See also

- [`query`](./query)
- [Statements](./)
