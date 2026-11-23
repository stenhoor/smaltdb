---
description: 'The value after the first true condition, else the last argument or NULL.'
---

# if, iif

```ebnf
iif ::= '"fn": "iif"' ', "args": [' COND ',' THEN (',' COND ',' THEN)* (',' ELSE)? ']'
if ::= '"fn": "if"' ', "args": [' COND ',' THEN (',' COND ',' THEN)* (',' ELSE)? ']'
```

The value after the first true condition, else the last argument or NULL: conditions and values in pairs, and an
optional value for when none is true. `if` and `iif` are the same function. It is a [`case`](../../expressions/case)
as a function.

## Parameters

| Argument | Type | |
|---|---|---|
| `COND` | any | A condition: true when it is a non-zero number. |
| `THEN` | any | The value when its condition is the first true one. |
| `ELSE` | any | Optional: the value when no condition is true. An odd number of arguments ends with it. |

## Returns

The values' type: declare it on the call. NULL when no condition is true and there is no `ELSE`.

## Errors

None.

## Notes

- Conditions are read in order, and only the chosen value is evaluated: an error in another (a
  [`raise_error`](./raise_error)) isn't raised.
- A NULL condition isn't true. Text reads as a number, as SQLite reads it: `'2x'` is true.
- As SQLite's `iif` from 3.48, it takes more than one pair.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "iif", "args": [{"k": "lit", "value": 1, "type": "bool"}, {"k": "lit", "value": "yes", "type": "text"}, {"k": "lit", "value": "no", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "iif", "args": [{"k": "lit", "value": 0, "type": "bool"}, {"k": "lit", "value": "yes", "type": "text"}, {"k": "lit", "value": "no", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "iif", "args": [{"k": "lit", "value": null, "type": "bool"}, {"k": "lit", "value": "yes", "type": "text"}, {"k": "lit", "value": "no", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "iif", "args": [{"k": "lit", "value": 0, "type": "bool"}, {"k": "lit", "value": "yes", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "if", "args": [
        {"k": "lit", "value": 0, "type": "bool"}, {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": 1, "type": "bool"}, {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": "c", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "true"}, {"name": "false"}, {"name": "null"}, {"name": "no_else"}, {"name": "two_pairs"}]
}
```

| true | false | null | no_else | two_pairs |
|---|---|---|---|---|
| yes | no | no | NULL | b |

## Demo

Whether each fruit is in stock:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "iif", "args": [
        {"k": "isNull", "arg": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "not": false},
        {"k": "lit", "value": "unknown", "type": "text"},
        {"k": "call", "fn": "cmp_gt", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 0, "type": "int"}
        ], "type": "bool"},
        {"k": "lit", "value": "in stock", "type": "text"},
        {"k": "lit", "value": "sold out", "type": "text"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "stock"}]
}
```

| name | stock |
|---|---|
| apple | in stock |
| pear | in stock |
| plum | unknown |
| cherry | in stock |
| lime | sold out |

## See also

- [`case`](../../expressions/case), [`coalesce`](./coalesce)
- [General functions](./)
