---
description: 'The value of `X` at the last row of the frame.'
---

# last_value

```ebnf
last_value ::= '"fn": "last_value"' ', "args": [' X ']'
```

The value of `X` at the last row of the current row's frame. With the usual frame that is the current row's last peer,
not the partition's last row: give the frame an end of `unboundedFollowing` for that. A navigation function: a call in a
[`window`](../../operations/window)'s `calls`. It reads the window's frame: with the usual frame (`RANGE` from
`unboundedPreceding` to `currentRow`), the rows from the start of the partition to the current row's last peer.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

The type of `X`. NULL when the frame has no such row, or when its value there is NULL.

## Errors

None.

## Notes

- With `"ignoreNulls": true` it skips the rows whose `X` is NULL, and gives the last value in the frame that is not
  NULL.
- A frame's `exclude` takes rows out of it: they are not counted.

## Examples

With the usual frame, up to the current row, and with the whole partition as the frame:

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
        {"fn": "last_value", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"},
        {"fn": "last_value", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary", "ignoreNulls": true}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "x"}, {"name": "last_value"}, {"name": "ignoring NULLs"}]
}
```

| id | x | last_value | ignoring NULLs |
|---|---|---|---|
| 1 | 5 | 5 | 5 |
| 2 | NULL | NULL | 5 |
| 3 | NULL | NULL | 5 |
| 4 | 8 | 8 | 8 |
| 5 | NULL | NULL | 8 |

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
      "frame": {"unit": "ROWS", "start": {
        "kind": "unboundedPreceding"
      }, "end": {
        "kind": "unboundedFollowing"
      }, "exclude": "NO OTHERS"},
      "calls": [
        {"fn": "last_value", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"},
        {"fn": "last_value", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary", "ignoreNulls": true}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "x"}, {"name": "last_value"}, {"name": "ignoring NULLs"}]
}
```

| id | x | last_value | ignoring NULLs |
|---|---|---|---|
| 1 | 5 | NULL | 8 |
| 2 | NULL | NULL | 8 |
| 3 | NULL | NULL | 8 |
| 4 | 8 | NULL | 8 |
| 5 | NULL | NULL | 8 |

## Demo

Each order, with the smallest order of its day (the frame is the whole day):

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
        {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "collation": "binary"}
      ],
      "order": [
        {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"}
      ],
      "frame": {"unit": "ROWS", "start": {
        "kind": "unboundedPreceding"
      }, "end": {
        "kind": "unboundedFollowing"
      }, "exclude": "NO OTHERS"},
      "calls": [
        {"fn": "last_value", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}, {"name": "day"}, {"name": "smallest"}]
}
```

| id | fruit | n | day | smallest |
|---|---|---|---|---|
| 1 | 1 | 3 | 2026-11-02 | 1 |
| 2 | 2 | 1 | 2026-11-02 | 1 |
| 3 | 1 | 2 | 2026-11-03 | 2 |
| 4 | 4 | 10 | 2026-11-04 | 10 |
| 5 | 3 | 5 | 2026-11-05 | 1 |
| 6 | 1 | 1 | 2026-11-05 | 1 |

## See also

- [`first_value`](./first_value), [`nth_value`](./nth_value), [`lead`](./lead), [`last`](../aggregate/last)
- [Window functions](./)
