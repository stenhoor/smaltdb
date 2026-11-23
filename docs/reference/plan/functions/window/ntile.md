---
description: 'Which of `N` nearly equal buckets a row falls in, in its partition''s order.'
---

# ntile

```ebnf
ntile ::= '"fn": "ntile"' ', "args": [' N ']'
```

The bucket of the row, from 1 to `N`, when its partition is split, in the window's `order`, into `N` buckets of nearly
equal size. A ranking function: a call in a [`window`](../../operations/window)'s `calls`. It reads the window's
`partition` and `order`, not its frame.

## Parameters

| Argument | Type | |
|---|---|---|
| `N` | `int` | The number of buckets: a positive integer. A real is truncated to an integer. |

## Returns

`int`, from 1 to `N`. Never NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `N` is not a positive integer: 0, negative or NULL. |

## Notes

- With `n` rows, the buckets hold `n / N` rows each, and the first `n % N` buckets one row more. With more buckets than
  rows, each row has a bucket of its own.
- `N` is read from the partition's first row.
- Peers can fall in different buckets.

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
        "types": ["text", "int"],
        "rows": [
          [{"k": "lit", "value": "a", "type": "text"}, {"k": "lit", "value": 10, "type": "int"}],
          [{"k": "lit", "value": "b", "type": "text"}, {"k": "lit", "value": 20, "type": "int"}],
          [{"k": "lit", "value": "c", "type": "text"}, {"k": "lit", "value": 20, "type": "int"}],
          [{"k": "lit", "value": "d", "type": "text"}, {"k": "lit", "value": 30, "type": "int"}],
          [{"k": "lit", "value": "e", "type": "text"}, {"k": "lit", "value": null, "type": "int"}]
        ]
      },
      "partition": [],
      "order": [
        {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
      ],
      "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
      "calls": [
        {"fn": "ntile", "args": [{"k": "lit", "value": 2, "type": "int"}], "star": false, "type": "int", "collation": "binary"},
        {"fn": "ntile", "args": [{"k": "lit", "value": 3, "type": "int"}], "star": false, "type": "int", "collation": "binary"},
        {"fn": "ntile", "args": [{"k": "lit", "value": 10, "type": "int"}], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "score"}, {"name": "halves"}, {"name": "thirds"}, {"name": "tenths"}]
}
```

| name | score | halves | thirds | tenths |
|---|---|---|---|---|
| e | NULL | 1 | 1 | 1 |
| a | 10 | 1 | 1 | 2 |
| b | 20 | 1 | 2 | 3 |
| c | 20 | 2 | 2 | 4 |
| d | 30 | 2 | 3 | 5 |

<!-- docs:error SMALT_ERROR -->
```json
{
  "kind": "query",
  "plan": {
    "op": "window",
    "input": {
      "op": "values",
      "types": ["text", "int"],
      "rows": [
        [{"k": "lit", "value": "a", "type": "text"}, {"k": "lit", "value": 10, "type": "int"}],
        [{"k": "lit", "value": "b", "type": "text"}, {"k": "lit", "value": 20, "type": "int"}],
        [{"k": "lit", "value": "c", "type": "text"}, {"k": "lit", "value": 20, "type": "int"}],
        [{"k": "lit", "value": "d", "type": "text"}, {"k": "lit", "value": 30, "type": "int"}],
        [{"k": "lit", "value": "e", "type": "text"}, {"k": "lit", "value": null, "type": "int"}]
      ]
    },
    "partition": [],
    "order": [
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ],
    "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
    "calls": [
      {"fn": "ntile", "args": [{"k": "lit", "value": 0, "type": "int"}], "star": false, "type": "int", "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "score"}, {"name": "ntile"}]
}
```

## Demo

All orders, split into a larger and a smaller half by pieces:

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
      "partition": [],
      "order": [
        {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"},
        {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
      ],
      "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
      "calls": [
        {"fn": "ntile", "args": [{"k": "lit", "value": 2, "type": "int"}], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}, {"name": "day"}, {"name": "half"}]
}
```

| id | fruit | n | day | half |
|---|---|---|---|---|
| 4 | 4 | 10 | 2026-11-04 | 1 |
| 5 | 3 | 5 | 2026-11-05 | 1 |
| 1 | 1 | 3 | 2026-11-02 | 1 |
| 3 | 1 | 2 | 2026-11-03 | 2 |
| 2 | 2 | 1 | 2026-11-02 | 2 |
| 6 | 1 | 1 | 2026-11-05 | 2 |

## See also

- [`row_number`](./row_number), [`percent_rank`](./percent_rank), [`cume_dist`](./cume_dist)
- [Window functions](./)
