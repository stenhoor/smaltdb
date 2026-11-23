---
description: 'The first of its arguments that isn''t NULL.'
---

# coalesce

```ebnf
coalesce ::= '"fn": "coalesce"' ', "args": [' X ',' X (',' X)* ']'
```

The first of its arguments that isn't NULL, or NULL when they all are.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The values, two or more, in the order to try them. |

## Returns

The arguments' type: declare it on the call (`int` for integers, `num` for integers and reals). NULL when every
argument is NULL.

## Errors

None.

## Notes

- Arguments are read from the left, and the ones after the first non-NULL value aren't evaluated: an error in them
  (a [`raise_error`](./raise_error)) isn't raised.
- [`ifnull`](./ifnull) is the same with two arguments.
- The value isn't converted: arguments of different types give the first non-NULL value as it is.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "text"],
    "rows": [[
      {"k": "call", "fn": "coalesce", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": 3, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "coalesce", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": null, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "coalesce", "args": [{"k": "lit", "value": "a", "type": "text"}, {"k": "call", "fn": "raise_error", "args": [{"k": "lit", "value": "not read", "type": "text"}], "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "second"}, {"name": "all_null"}, {"name": "first"}]
}
```

| second | all_null | first |
|---|---|---|
| 2 | NULL | a |

## Demo

Each fruit's stock, 0 where it isn't known:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "coalesce", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| apple | 10 |
| pear | 4 |
| plum | 0 |
| cherry | 25 |
| lime | 0 |

## See also

- [`ifnull`](./ifnull), [`nullif`](./nullif)
- [`isNull`](../../expressions/isNull): whether a value is NULL
- [General functions](./)
