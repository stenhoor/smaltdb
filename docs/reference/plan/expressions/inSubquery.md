---
description: 'Whether a value is among a nested plan''s values: 1, 0 or NULL.'
---

# inSubquery

```railroad
in-subquery
```

Whether a value is among a nested plan's values: 1, 0 or NULL, as SQL's `x IN (SELECT …)`. The nested plan gives one
column, and may read the row it runs for ([`col`](./col) with `depth` 1).

## Fields

| Field | Type | |
|---|---|---|
| `probe` | expression | The value to look for. |
| `plan` | [operation](../operations/) | The nested plan, of one column. |
| `collation` | [collation](../collations) | The comparison's collation, as the format states it. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

An `int`:

| | Value |
|---|---|
| A value of the plan equals `probe` | 1 |
| The plan gives no rows | 0, even when `probe` is NULL |
| `probe` is NULL, or no value equals it and one of them is NULL | NULL |
| Otherwise | 0 |

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The nested plan is invalid. |
| `SMALT_ERROR` | The nested plan gives more than one column (when the statement runs). |

## Notes

- Its type is `int`, so results show `1` and `0`, not `true` and `false`.
- The values compare without conversion: the integer `1` isn't among the text `'1'`.
- Text compares by the collation `probe` [carries](../meaning-fields#carries-and-affinity), else `binary`; the `collation` field doesn't
  change it.
- [`not`](./not) of it is SQL's `NOT IN`: NULL stays NULL, so a `filter` on it drops the rows where the answer is
  NULL.

## Examples

Found, not found, not found beside a NULL, and a NULL probe:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "inSubquery", "probe": {"k": "lit", "value": "a", "type": "text"}, "plan": {"op": "values", "types": ["text"], "rows": [[{"k": "lit", "value": "a", "type": "text"}], [{"k": "lit", "value": "b", "type": "text"}]]}, "collation": "binary"},
      {"k": "inSubquery", "probe": {"k": "lit", "value": "c", "type": "text"}, "plan": {"op": "values", "types": ["text"], "rows": [[{"k": "lit", "value": "a", "type": "text"}], [{"k": "lit", "value": "b", "type": "text"}]]}, "collation": "binary"},
      {"k": "inSubquery", "probe": {"k": "lit", "value": "c", "type": "text"}, "plan": {"op": "values", "types": ["text"], "rows": [[{"k": "lit", "value": "a", "type": "text"}], [{"k": "lit", "value": null, "type": "text"}]]}, "collation": "binary"},
      {"k": "inSubquery", "probe": {"k": "lit", "value": null, "type": "text"}, "plan": {"op": "values", "types": ["text"], "rows": [[{"k": "lit", "value": "a", "type": "text"}]]}, "collation": "binary"},
      {"k": "inSubquery", "probe": {"k": "lit", "value": null, "type": "text"}, "plan": {"op": "values", "types": ["text"], "rows": []}, "collation": "binary"}
    ]]
  },
  "columns": [{"name": "found"}, {"name": "missing"}, {"name": "beside_null"}, {"name": "null"}, {"name": "empty"}]
}
```

| found | missing | beside_null | null | empty |
|---|---|---|---|---|
| 1 | 0 | NULL | NULL | 0 |

A nested plan of two columns:

<!-- docs:error SMALT_ERROR -->
```json
{
  "op": "values",
  "types": ["int"],
  "rows": [[
    {"k": "inSubquery", "probe": {"k": "lit", "value": 1, "type": "int"}, "plan": {"op": "values", "types": ["int", "int"], "rows": [[{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}]]}, "collation": "binary"}
  ]]
}
```

## Demo

The fruit that have been ordered on or after 2026-11-04:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
      "pred": {"k": "inSubquery", "probe": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "plan": {
        "op": "project",
        "input": {
          "op": "filter",
          "input": {"op": "scan", "table": "orders", "columns": [1, 3]},
          "pred": {"k": "call", "fn": "cmp_ge", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
            {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-04", "type": "text"}], "type": "date"}
          ], "type": "bool"}
        },
        "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}]
      }, "collation": "binary"}
    },
    "exprs": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| apple |
| plum |
| cherry |

## See also

- [`subquery`](./subquery): a nested plan's first value, or whether it has a row
- [`in_list`](../functions/comparison/in_list): whether a value is among a list of expressions
- [`join`](../operations/join): `semi` and `anti` joins
- [Expressions](./)
