---
description: 'Fails the statement with a message and an error code, when a row reaches it.'
---

# raise_error

```ebnf
raise_error ::= '"fn": "raise_error"' ', "args": [' MESSAGE (',' CODE)? ']'
```

Fails the statement with a message and an error code, when a row reaches it. A language raises its own errors with
it: a type error, a failed check.

## Parameters

| Argument | Type | |
|---|---|---|
| `MESSAGE` | `text` | The error's message. NULL gives the message `error`. |
| `CODE` | `text` | Optional: the error's code, upper-case letters, digits and `_`, starting with a letter. Left out or NULL: `SMALT_ERROR`. |

## Returns

It returns nothing: it raises. Its type is `any`; declare the type the place needs, so that it fits beside the other
values of a [`case`](../../expressions/case) or [`coalesce`](./coalesce).

## Errors

| Code | When |
|---|---|
| `CODE`, or `SMALT_ERROR` | Always, when it is evaluated. |
| `SMALT_MISUSE` | `CODE` isn't upper-case letters, digits and `_`. |

## Notes

- It raises only where it is evaluated: in a `case` branch not taken, an [`iif`](./iif) value not chosen, or a
  [`coalesce`](./coalesce) argument after a non-NULL one, it doesn't. It is never computed ahead of time, even with
  constant arguments.
- An error it raises carries the [`origin`](../../meaning-fields#origin) of the innermost expression around it that
  has one.

## Examples

A branch not taken doesn't raise:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "case", "whens": [
        {"when": {"k": "lit", "value": 0, "type": "bool"}, "then": {"k": "call", "fn": "raise_error", "args": [{"k": "lit", "value": "not raised", "type": "text"}], "type": "int"}}
      ], "else": {"k": "lit", "value": 1, "type": "int"}, "type": "int"}
    ]]
  },
  "columns": [{"name": "value"}]
}
```

| value |
|---|
| 1 |

With a code of the language's own:

<!-- docs:error MY_TYPE_ERROR -->
```json
{"op": "values", "types": ["int"], "rows": [[{"k": "call", "fn": "raise_error", "args": [{"k": "lit", "value": "expected a number", "type": "text"}, {"k": "lit", "value": "MY_TYPE_ERROR", "type": "text"}], "type": "int"}]]}
```

Without one:

<!-- docs:error SMALT_ERROR -->
```json
{"op": "values", "types": ["int"], "rows": [[{"k": "call", "fn": "raise_error", "args": [{"k": "lit", "value": "failed", "type": "text"}], "type": "int"}]]}
```

A code that isn't one:

<!-- docs:error SMALT_MISUSE -->
```json
{"op": "values", "types": ["int"], "rows": [[{"k": "call", "fn": "raise_error", "args": [{"k": "lit", "value": "failed", "type": "text"}, {"k": "lit", "value": "oops", "type": "text"}], "type": "int"}]]}
```

## Demo

A check over the fruit: the stock where it is known, and an error for plum, which has none:

<!-- docs:error STOCK_UNKNOWN -->
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
        {"k": "call", "fn": "raise_error", "args": [
          {"k": "call", "fn": "text_concat", "args": [
            {"k": "lit", "value": "no stock for ", "type": "text"},
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
          ], "type": "text"},
          {"k": "lit", "value": "STOCK_UNKNOWN", "type": "text"}
        ], "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}]
}
```

The same plan over the fruit that have a stock gives each:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
      "pred": {"k": "isNull", "arg": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "not": true}
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "coalesce", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "call", "fn": "raise_error", "args": [
          {"k": "call", "fn": "text_concat", "args": [
            {"k": "lit", "value": "no stock for ", "type": "text"},
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
          ], "type": "text"},
          {"k": "lit", "value": "STOCK_UNKNOWN", "type": "text"}
        ], "type": "int"}
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
| cherry | 25 |
| lime | 0 |

## See also

- [`case`](../../expressions/case), [`iif`](./iif), [`coalesce`](./coalesce)
- [General functions](./)
