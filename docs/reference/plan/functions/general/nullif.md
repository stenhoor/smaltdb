---
description: 'NULL when its two arguments are equal, else the first.'
---

# nullif

```ebnf
nullif ::= '"fn": "nullif"' ', "args": [' X ',' Y ']'
```

NULL when its two arguments are equal, else the first. It turns a value that stands for "none" (an empty text, a 0)
into NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |
| `Y` | any | The value that gives NULL. |

## Returns

`X`'s type. NULL when `X` is NULL or equals `Y`; `X` when `Y` is NULL.

## Errors

None.

## Notes

- The values compare as [`cmp_eq`](../comparison/cmp_eq) compares them, without conversion: `1` doesn't equal
  `'1'`, and `1` equals `1.0`.
- Text compares by the collation `X` [carries](../../meaning-fields#carries-and-affinity), else `binary`. The call's
  `collation` field doesn't change it.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "nullif", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "nullif", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "nullif", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": "1", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "nullif", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": null, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "nullif", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "equal"}, {"name": "differ"}, {"name": "text"}, {"name": "null_y"}, {"name": "null_x"}]
}
```

| equal | differ | text | null_y | null_x |
|---|---|---|---|---|
| NULL | 1 | 1 | 1 | NULL |

## Demo

Each fruit's stock, NULL where it is 0:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "nullif", "args": [
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
| plum | NULL |
| cherry | 25 |
| lime | NULL |

## See also

- [`coalesce`](./coalesce), [`ifnull`](./ifnull)
- [General functions](./)
