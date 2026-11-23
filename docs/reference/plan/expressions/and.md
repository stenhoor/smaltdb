---
description: 'Whether every argument is true, in three-valued logic.'
---

# and

```railroad
and
logic-type
```

Whether every argument is true, in three-valued logic: false when any argument is false, else NULL when any is NULL,
else true.

## Fields

| Field | Type | |
|---|---|---|
| `args` | expressions | The conditions: one or more. |
| `type` | `bool` or `int` | Optional: the type of the result. `bool` (the default) gives `true` and `false` in results, `int` gives `1` and `0`. The values are the same. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

| | true | false | NULL |
|---|---|---|---|
| **true** | true | false | NULL |
| **false** | false | false | false |
| **NULL** | NULL | false | NULL |

More than two arguments combine from the left.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `args` is empty, or `type` isn't `bool` or `int`. |

## Notes

- A value is true when it is a non-zero number. Text reads as a number, as SQLite reads it: `'1'` is true, `'abc'`
  is false.
- Arguments are read from the left, and an `and` stops at the first false one: the rest aren't evaluated, so an error
  after it (a [`raise_error`](../functions/general/raise_error)) isn't raised. After a NULL it reads on.
- A [`filter`](../operations/filter) keeps a row whose condition is true, and drops it when the condition is false or
  NULL.
- `type` is for a language whose results show truth values as numbers, as SQL's do.

## Examples

Each pair of truth values, and one as `int`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "int"],
    "rows": [[
      {"k": "and", "args": [{"k": "lit", "value": 1, "type": "bool"}, {"k": "lit", "value": 1, "type": "bool"}]},
      {"k": "and", "args": [{"k": "lit", "value": 1, "type": "bool"}, {"k": "lit", "value": 0, "type": "bool"}]},
      {"k": "and", "args": [{"k": "lit", "value": 1, "type": "bool"}, {"k": "lit", "value": null, "type": "bool"}]},
      {"k": "and", "args": [{"k": "lit", "value": 0, "type": "bool"}, {"k": "lit", "value": null, "type": "bool"}]},
      {"k": "and", "args": [{"k": "lit", "value": 1, "type": "bool"}, {"k": "lit", "value": 1, "type": "bool"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "t_t"}, {"name": "t_f"}, {"name": "t_null"}, {"name": "f_null"}, {"name": "as_int"}]
}
```

| t_t | t_f | t_null | f_null | as_int |
|---|---|---|---|---|
| true | false | NULL | false | 1 |

An `and` of nothing:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "types": ["bool"], "rows": [[{"k": "and", "args": []}]]}
```

## Demo

The red fruit with more than 5 in stock:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 4]},
      "pred": {"k": "and", "args": [
        {"k": "call", "fn": "cmp_eq", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
          {"k": "lit", "value": "red", "type": "text"}
        ], "type": "bool"},
        {"k": "call", "fn": "cmp_gt", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 5, "type": "int"}
        ], "type": "bool"}
      ]}
    },
    "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| apple |
| cherry |

## See also

- [`or`](./or), [`not`](./not), [`isNull`](./isNull)
- [`truth_not`](../functions/comparison/truth_not): NOT as a function
- [Expressions](./)
