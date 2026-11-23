---
description: 'A parameter of the statement, by position from 0.'
---

# param

```railroad
param
```

A parameter of the statement, by position from 0. The values are given when the statement runs
([running plans](../../engine/running)), so one plan serves many values. A language maps its own parameter syntax
(SQL's `?NNN` and `:name`) to positions.

## Fields

| Field | Type | |
|---|---|---|
| `index` | integer | The parameter's position, from 0. |
| `type` | [type](../types) | Its type. With a `list<…>`, `struct<…>` or `map<text, …>` type, the parameter is given as a JavaScript array or object. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

The parameter's value, in every row.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `index` is negative or not an integer. |
| `SMALT_RANGE` | The statement is given more or fewer parameters than its highest `index` plus one. |
| `SMALT_MISMATCH` | A value can't be a parameter: an array or object for a parameter that isn't a list, struct or map, or a list element its type can't hold. |

## Notes

- A value isn't converted to `type`: text given for an `int` parameter stays text. Convert it with a
  [`cast`](./cast) or a [`call`](./call) where the plan needs the type.
- In JSON (as on these pages), a parameter that JSON can't write uses the forms a [literal](./lit) uses:
  `{"$bigint": "…"}`, `{"$blob": "…"}`.
- A parameter may appear any number of times in a plan.

## Examples

<!-- docs:params [2, "pear", [3, 1, 2]] -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "text", "list<int>", "int"],
    "rows": [[
      {"k": "param", "index": 0, "type": "int"},
      {"k": "param", "index": 1, "type": "text"},
      {"k": "param", "index": 2, "type": "list<int>"},
      {"k": "call", "fn": "list_len", "args": [{"k": "param", "index": 2, "type": "list<int>"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "list"}, {"name": "len"}]
}
```

| id | name | list | len |
|---|---|---|---|
| 2 | pear | [3,1,2] | 3 |

A statement that reads parameter 1 needs two:

<!-- docs:params [1] -->
<!-- docs:error SMALT_RANGE -->
```json
{"kind": "query", "plan": {"op": "values", "types": ["int"], "rows": [[{"k": "param", "index": 1, "type": "int"}]]}}
```

## Demo

The fruit of one colour, the colour given as a parameter:

<!-- docs:params ["green"] -->
```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "param", "index": 0, "type": "text"}
      ], "type": "bool"}
    },
    "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| pear |
| lime |

## See also

- [`lit`](./lit): a constant
- [Running plans](../../engine/running)
- [Expressions](./)
