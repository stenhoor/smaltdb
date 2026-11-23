---
description: 'A call of a function by name: a scalar function, or one of the engine''s operations.'
---

# call

```railroad
call
```

A call of a function by name: one of the engine's [functions](../functions/), or one a plugin registers. Its
arguments are expressions, and the call states its result type.

## Fields

| Field | Type | |
|---|---|---|
| `fn` | string | The function's name, as the [functions reference](../functions/) and the [catalog](../../engine/catalog#functions) give it. |
| `args` | expressions | Its arguments, in order. |
| `type` | [type](../types) | The type of the call's value. A function that can give several types (`coalesce`, `max`) gives the one the plan declares. |
| `collation` | [collation](../collations) | Optional: how a comparison (`cmp_eq`, `cmp_lt`, …) compares text. Without it: `binary`. The collation an operand [carries](../meaning-fields) doesn't change it. A few functions (`in_list`, `min`, `max`, `nullif`) compare by the collation their first argument carries instead: their pages say so. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

The function's value for the arguments. Most functions give NULL when an argument is NULL; each function's page says
what it does.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | No function has the name, or it doesn't take that many arguments. |
| `SMALT_MISMATCH` | An argument has a type the function doesn't take (a date function given text, a list function given a number), when the plan is compiled. |

A function raises its own errors while it runs: its page lists them.

## Notes

- The validator checks the name and the number of arguments. Types are checked when the plan is compiled, by the
  functions that take particular types (dates and times, lists, maps).
- Aggregate and window functions are not called with `call`: they are an [`aggregate`](../operations/aggregate)'s or a
  [`window`](../operations/window)'s calls.
- Comparisons are function calls too ([`cmp_eq`](../functions/comparison/cmp_eq), …): the engine's operations are
  named for what they do, and a language picks the one with the meaning it gives its syntax.

## Examples

Arithmetic and a comparison, by name:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "bool"],
    "rows": [[
      {"k": "call", "fn": "add", "args": [{"k": "lit", "value": 40, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "cmp_lt", "args": [{"k": "lit", "value": "apple", "type": "text"}, {"k": "lit", "value": "Pear", "type": "text"}], "type": "bool", "collation": "nocase"}
    ]]
  },
  "columns": [{"name": "sum"}, {"name": "less"}]
}
```

| sum | less |
|---|---|
| 42 | true |

A function that doesn't exist:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "types": ["text"], "rows": [[{"k": "call", "fn": "shout", "args": [], "type": "text"}]]}
```

## Demo

Each fruit's value in stock, `price × qty`:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "mul", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "value"}]
}
```

| name | value |
|---|---|
| apple | 5 |
| pear | 3 |
| plum | NULL |
| cherry | 75 |
| lime | 0 |

## See also

- [`cast`](./cast): a conversion
- [Functions](../functions/)
- [Expressions](./)
