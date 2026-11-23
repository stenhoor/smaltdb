---
description: 'Whether any argument is true, in three-valued logic.'
---

# or

```railroad
or
logic-type
```

Whether any argument is true, in three-valued logic: true when any argument is true, else NULL when any is NULL, else
false.

## Fields

| Field | Type | |
|---|---|---|
| `args` | expressions | The conditions: one or more. |
| `type` | `bool` or `int` | Optional: the type of the result. `bool` (the default) gives `true` and `false` in results, `int` gives `1` and `0`. The values are the same. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

| | true | false | NULL |
|---|---|---|---|
| **true** | true | true | true |
| **false** | true | false | NULL |
| **NULL** | true | NULL | NULL |

More than two arguments combine from the left.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `args` is empty, or `type` isn't `bool` or `int`. |

## Notes

- A value is true when it is a non-zero number. Text reads as a number, as SQLite reads it: `'1'` is true, `'abc'`
  is false.
- Arguments are read from the left, and an `or` stops at the first true one: the rest aren't evaluated, so an error
  after it (a [`raise_error`](../functions/general/raise_error)) isn't raised.
- A [`filter`](../operations/filter) drops a row whose condition is NULL: an `or` of false and NULL keeps no row.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "int"],
    "rows": [[
      {"k": "or", "args": [{"k": "lit", "value": 1, "type": "bool"}, {"k": "lit", "value": null, "type": "bool"}]},
      {"k": "or", "args": [{"k": "lit", "value": 0, "type": "bool"}, {"k": "lit", "value": 0, "type": "bool"}]},
      {"k": "or", "args": [{"k": "lit", "value": 0, "type": "bool"}, {"k": "lit", "value": null, "type": "bool"}]},
      {"k": "or", "args": [{"k": "lit", "value": 0, "type": "bool"}, {"k": "lit", "value": 0, "type": "bool"}, {"k": "lit", "value": 1, "type": "bool"}]},
      {"k": "or", "args": [{"k": "lit", "value": 0, "type": "bool"}, {"k": "lit", "value": 1, "type": "bool"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "t_null"}, {"name": "f_f"}, {"name": "f_null"}, {"name": "three"}, {"name": "as_int"}]
}
```

| t_null | f_f | f_null | three | as_int |
|---|---|---|---|---|
| true | false | NULL | true | 1 |

A logic node's type is `bool` or `int`:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "types": ["bool"], "rows": [[{"k": "or", "args": [{"k": "lit", "value": 1, "type": "bool"}], "type": "text"}]]}
```

## Demo

The fruit that are green or cost more than 1:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 3]},
      "pred": {"k": "or", "args": [
        {"k": "call", "fn": "cmp_eq", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
          {"k": "lit", "value": "green", "type": "text"}
        ], "type": "bool"},
        {"k": "call", "fn": "cmp_gt", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 1, "type": "real"}
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
| pear |
| plum |
| cherry |
| lime |

## See also

- [`and`](./and), [`not`](./not), [`isNull`](./isNull)
- [Expressions](./)
