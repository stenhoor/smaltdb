---
description: 'The opposite of a truth value; NULL stays NULL.'
---

# not

```railroad
not
logic-type
```

The opposite of a truth value: true for false, false for true. NULL stays NULL.

## Fields

| Field | Type | |
|---|---|---|
| `arg` | expression | The condition. |
| `type` | `bool` or `int` | Optional: the type of the result. `bool` (the default) gives `true` and `false` in results, `int` gives `1` and `0`. The values are the same. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

| `arg` | Value |
|---|---|
| true | false |
| false | true |
| NULL | NULL |

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `type` isn't `bool` or `int`. |

## Notes

- A value is true when it is a non-zero number. Text reads as a number, as SQLite reads it: `not` of `'abc'` is true,
  of `'2x'` false.
- `not` of a NULL is NULL, so a [`filter`](../operations/filter) on `not` of a condition drops the rows where the
  condition is NULL as well as those where it is true. [`isNull`](./isNull) tests for NULL.
- [`truth_not`](../functions/comparison/truth_not) is the same as a function.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "int"],
    "rows": [[
      {"k": "not", "arg": {"k": "lit", "value": 1, "type": "bool"}},
      {"k": "not", "arg": {"k": "lit", "value": 0, "type": "bool"}},
      {"k": "not", "arg": {"k": "lit", "value": null, "type": "bool"}},
      {"k": "not", "arg": {"k": "lit", "value": "abc", "type": "text"}},
      {"k": "not", "arg": {"k": "lit", "value": 0, "type": "bool"}, "type": "int"}
    ]]
  },
  "columns": [{"name": "true"}, {"name": "false"}, {"name": "null"}, {"name": "text"}, {"name": "as_int"}]
}
```

| true | false | null | text | as_int |
|---|---|---|---|---|
| false | true | NULL | true | 1 |

## Demo

The fruit that are not red. Plum's colour is known, so it is kept; a fruit whose colour were NULL would not be:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2]},
      "pred": {"k": "not", "arg": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "red", "type": "text"}
      ], "type": "bool"}}
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
| lime |

## See also

- [`and`](./and), [`or`](./or), [`isNull`](./isNull)
- [Expressions](./)
