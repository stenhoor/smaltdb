---
description: 'The value of a row `OFFSET` rows before this one in its partition, or a default.'
---

# lag

```ebnf
lag ::= '"fn": "lag"' ', "args": [' X (',' OFFSET (',' DEFAULT)?)? ']'
```

The value of `X` at the row `OFFSET` rows before the current one in its partition, in the window's `order`; `DEFAULT`
when there is no such row. A navigation function: a call in a [`window`](../../operations/window)'s `calls`. It reads
the partition's rows, not the frame.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value, read at the earlier row. |
| `OFFSET` | `int` | Optional: how many rows before (1 without it). 0 is the current row, and a negative offset counts the other way. A real is truncated; text that is an integer is taken as one. |
| `DEFAULT` | any | Optional: the value when there is no row at that offset (NULL without it). Read at the current row. |

## Returns

The type of `X`. NULL when the value at that row is NULL, when there is no such row and no `DEFAULT`, and when `OFFSET`
is NULL (or not a number).

## Errors

None.

## Notes

- With `"ignoreNulls": true` it counts only the rows whose `X` is not NULL: `lag(x, 2)` is the second earlier row with a
  value, and `DEFAULT` when there is none.
- `OFFSET` and `DEFAULT` are expressions over the current row, so each row can have its own.
- Without an `order`, it counts rows in input order ([order](../../order)).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "window",
      "input": {
        "op": "values",
        "types": ["int", "int"],
        "rows": [
          [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 5, "type": "int"}],
          [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": null, "type": "int"}],
          [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": null, "type": "int"}],
          [{"k": "lit", "value": 4, "type": "int"}, {"k": "lit", "value": 8, "type": "int"}],
          [{"k": "lit", "value": 5, "type": "int"}, {"k": "lit", "value": null, "type": "int"}]
        ]
      },
      "partition": [],
      "order": [
        {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
      ],
      "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
      "calls": [
        {"fn": "lag", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"},
        {"fn": "lag", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 0, "type": "int"}
        ], "star": false, "type": "int", "collation": "binary"},
        {"fn": "lag", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary", "ignoreNulls": true}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "x"}, {"name": "lag"}, {"name": "lag 2, default 0"}, {"name": "ignoring NULLs"}]
}
```

| id | x | lag | lag 2, default 0 | ignoring NULLs |
|---|---|---|---|---|
| 1 | 5 | NULL | 0 | NULL |
| 2 | NULL | 5 | 0 | 5 |
| 3 | NULL | NULL | 5 | 5 |
| 4 | 8 | NULL | NULL | 5 |
| 5 | NULL | 8 | NULL | 8 |

## Demo

Each order, with the pieces of the same fruit's order before it:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "window",
      "input": {
        "op": "scan",
        "table": "orders",
        "columns": [0, 1, 2, 3]
      },
      "partition": [
        {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "collation": "binary"}
      ],
      "order": [
        {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
      ],
      "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
      "calls": [
        {"fn": "lag", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}, {"name": "day"}, {"name": "previous"}]
}
```

| id | fruit | n | day | previous |
|---|---|---|---|---|
| 1 | 1 | 3 | 2026-11-02 | NULL |
| 2 | 2 | 1 | 2026-11-02 | NULL |
| 3 | 1 | 2 | 2026-11-03 | 3 |
| 4 | 4 | 10 | 2026-11-04 | NULL |
| 5 | 3 | 5 | 2026-11-05 | NULL |
| 6 | 1 | 1 | 2026-11-05 | 2 |

## See also

- [`lead`](./lead), [`first_value`](./first_value), [`nth_value`](./nth_value)
- [Window functions](./)
