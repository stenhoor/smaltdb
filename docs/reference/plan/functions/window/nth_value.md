---
description: 'The value of `X` at the `N`th row of the frame.'
---

# nth_value

```ebnf
nth_value ::= '"fn": "nth_value"' ', "args": [' X ',' N ']'
```

The value of `X` at row `N` (from 1) of the current row's frame; NULL when the frame has fewer rows. A navigation
function: a call in a [`window`](../../operations/window)'s `calls`. It reads the window's frame: with the usual frame
(`RANGE` from `unboundedPreceding` to `currentRow`), the rows from the start of the partition to the current row's last
peer.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |
| `N` | `int` | Which row of the frame, from 1: a positive integer. A real is truncated. |

## Returns

The type of `X`. NULL when the frame has no such row, or when its value there is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `N` is not a positive integer: 0, negative or NULL. |

## Notes

- With `"ignoreNulls": true` it skips the rows whose `X` is NULL, and gives the `N`th value in the frame that is not
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
        {"fn": "nth_value", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "star": false, "type": "int", "collation": "binary"},
        {"fn": "nth_value", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "star": false, "type": "int", "collation": "binary", "ignoreNulls": true}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "x"}, {"name": "nth_value"}, {"name": "ignoring NULLs"}]
}
```

| id | x | nth_value | ignoring NULLs |
|---|---|---|---|
| 1 | 5 | NULL | NULL |
| 2 | NULL | NULL | NULL |
| 3 | NULL | NULL | NULL |
| 4 | 8 | NULL | 8 |
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
        {"fn": "nth_value", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "star": false, "type": "int", "collation": "binary"},
        {"fn": "nth_value", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "star": false, "type": "int", "collation": "binary", "ignoreNulls": true}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "x"}, {"name": "nth_value"}, {"name": "ignoring NULLs"}]
}
```

| id | x | nth_value | ignoring NULLs |
|---|---|---|---|
| 1 | 5 | NULL | 8 |
| 2 | NULL | NULL | 8 |
| 3 | NULL | NULL | 8 |
| 4 | 8 | NULL | 8 |
| 5 | NULL | NULL | 8 |

<!-- docs:error SMALT_ERROR -->
```json
{
  "kind": "query",
  "plan": {
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
      {"fn": "nth_value", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "star": false, "type": "int", "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "x"}, {"name": "nth_value"}]
}
```

## Demo

Each order, with the second largest order of its day (the frame is the whole day):

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
        {"fn": "nth_value", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}, {"name": "day"}, {"name": "second"}]
}
```

| id | fruit | n | day | second |
|---|---|---|---|---|
| 1 | 1 | 3 | 2026-11-02 | 1 |
| 2 | 2 | 1 | 2026-11-02 | 1 |
| 3 | 1 | 2 | 2026-11-03 | NULL |
| 4 | 4 | 10 | 2026-11-04 | NULL |
| 5 | 3 | 5 | 2026-11-05 | 1 |
| 6 | 1 | 1 | 2026-11-05 | 1 |

## See also

- [`first_value`](./first_value), [`last_value`](./last_value), [`lag`](./lag), [`first`](../aggregate/first)
- [Window functions](./)
