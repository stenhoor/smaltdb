---
description: 'A blob of N random bytes.'
---

# randomblob

```ebnf
randomblob ::= '"fn": "randomblob"' ', "args": [' N ']'
```

A blob of `N` random bytes, new ones each time it is evaluated.

## Parameters

| Argument | Type | |
|---|---|---|
| `N` | `int` | The number of bytes. Text and reals convert as SQLite's `CAST(… AS INTEGER)` does. |

## Returns

`blob`. Never NULL: an `N` below 1, or NULL, gives one byte, as in SQLite.

## Errors

None.

## Notes

- The bytes come from the runtime's `crypto.getRandomValues`.
- Its bytes are different every time, so the examples show what doesn't change: the blob's length and type.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "text"],
    "rows": [[
      {"k": "call", "fn": "length", "args": [{"k": "call", "fn": "randomblob", "args": [{"k": "lit", "value": 16, "type": "int"}], "type": "blob"}], "type": "int"},
      {"k": "call", "fn": "length", "args": [{"k": "call", "fn": "randomblob", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "blob"}], "type": "int"},
      {"k": "call", "fn": "length", "args": [{"k": "call", "fn": "randomblob", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "blob"}], "type": "int"},
      {"k": "call", "fn": "typeof", "args": [{"k": "call", "fn": "randomblob", "args": [{"k": "lit", "value": 4, "type": "int"}], "type": "blob"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "sixteen"}, {"name": "zero"}, {"name": "null"}, {"name": "type"}]
}
```

| sixteen | zero | null | type |
|---|---|---|---|
| 16 | 1 | 1 | blob |

## Demo

A random token of 8 bytes for each fruit, as hexadecimal text: 16 characters each:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "length", "args": [
        {"k": "call", "fn": "hex", "args": [{"k": "call", "fn": "randomblob", "args": [{"k": "lit", "value": 8, "type": "int"}], "type": "blob"}], "type": "text"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "token_length"}]
}
```

| name | token_length |
|---|---|
| apple | 16 |
| pear | 16 |
| plum | 16 |
| cherry | 16 |
| lime | 16 |

## See also

- [`random`](./random), [`random_at`](./random_at)
- [`hex`](../text/hex), `zeroblob`
- [General functions](./)
