---
description: 'Whether a value is NULL, or with `not` whether it isn''t; never NULL.'
---

# isNull

```railroad
is-null
logic-type
```

Whether a value is NULL, or with `not` whether it isn't. The answer is true or false, never NULL.

## Fields

| Field | Type | |
|---|---|---|
| `arg` | expression | The value. |
| `not` | boolean | `false`: whether `arg` is NULL. `true`: whether it isn't. |
| `type` | `bool` or `int` | Optional: the type of the result. `bool` (the default) gives `true` and `false` in results, `int` gives `1` and `0`. The values are the same. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

With `not` false: true when `arg` is NULL, else false. With `not` true, the opposite.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `not` isn't a boolean, or `type` isn't `bool` or `int`. |

## Notes

- Only NULL is NULL: empty text, `0` and NaN are not.
- A comparison with NULL (`cmp_eq` of a value and NULL) is NULL, not true: test for NULL with `isNull`, or compare with
  [`cmp_is`](../functions/comparison/cmp_is).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "int"],
    "rows": [[
      {"k": "isNull", "arg": {"k": "lit", "value": null, "type": "int"}, "not": false},
      {"k": "isNull", "arg": {"k": "lit", "value": 1, "type": "int"}, "not": false},
      {"k": "isNull", "arg": {"k": "lit", "value": null, "type": "int"}, "not": true},
      {"k": "isNull", "arg": {"k": "lit", "value": "", "type": "text"}, "not": false},
      {"k": "isNull", "arg": {"k": "lit", "value": null, "type": "int"}, "not": false, "type": "int"}
    ]]
  },
  "columns": [{"name": "null"}, {"name": "one"}, {"name": "not_null"}, {"name": "empty"}, {"name": "as_int"}]
}
```

| null | one | not_null | empty | as_int |
|---|---|---|---|---|
| true | false | false | false | 1 |

## Demo

The fruit whose stock isn't known:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
      "pred": {"k": "isNull", "arg": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "not": false}
    },
    "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| plum |

## See also

- [`coalesce`](../functions/general/coalesce), [`ifnull`](../functions/general/ifnull): a value in place of NULL
- [`not`](./not), [`and`](./and), [`or`](./or)
- [Expressions](./)
