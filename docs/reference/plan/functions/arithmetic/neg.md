---
description: 'A number negated, in SQLite''s meaning: text converts, and the least integer becomes a real.'
---

# neg

```ebnf
neg ::= '"fn": "neg"' ', "args": [' X ']'
```

`X` negated: SQL's unary `-`. An integer negates exactly, text converts to a number first.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number, or text or a blob taken as one; a temporal value. |

## Returns

The type of `X` when it is a number or a temporal type, else `num`. NULL when `X` is NULL.

## Errors

None.

## Notes

- The least integer, -2^63, has no negative in 64 bits: negated, it is a real.
- Text and blobs convert to the number they begin with, as SQLite converts them: `'3x'` is 3, `'abc'` is 0.
- NaN stays NaN, and zero gives 0 (never -0).
- A `duration` negates to a `duration`; a `date`, `datetime` or `time` negates its integer, which is seldom what a plan
  means.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "real", "int", "duration", "int"],
    "rows": [[
      {"k": "call", "fn": "neg", "args": [{"k": "lit", "value": 5, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "neg", "args": [{"k": "lit", "value": -2.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "neg", "args": [
        {"k": "lit", "value": {"$bigint": "-9223372036854775808"}, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "neg", "args": [{"k": "lit", "value": "3x", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "neg", "args": [{"k": "lit", "value": 3600000000, "type": "duration"}], "type": "duration"},
      {"k": "call", "fn": "neg", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "real"}, {"name": "least"}, {"name": "text"}, {"name": "duration"}, {"name": "null"}]
}
```

| int | real | least | text | duration | null |
|---|---|---|---|---|---|
| -5 | 2.5 | 9223372036854776000 | -3 | -PT1H | NULL |

## Demo

Each fruit's price as a debit:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "neg", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "debit"}]
}
```

| name | debit |
|---|---|
| apple | -0.5 |
| pear | -0.75 |
| plum | -1.25 |
| cherry | -3 |
| lime | -0.4 |

## See also

- [`sub`](./sub), [`abs`](../math/abs)
- [Arithmetic functions](./)
