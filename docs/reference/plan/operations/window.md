---
description: 'Its input''s rows, each with window functions computed over its partition and frame.'
---

# window

```railroad
window
group-key
sort-key
frame
frame-bound
window-call
```

Its input's rows, each with window functions computed over its partition and frame: SQL's `OVER (PARTITION BY …
ORDER BY … ROWS …)`. A window operation computes the calls of one window; a plan with several windows stacks one
operation per window.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows. |
| `partition` | [group keys](./aggregate#group-key) | What splits the rows into partitions, each computed on its own. Empty: one partition of every row. |
| `order` | [sort keys](./sort#sort-key) | How each partition's rows are ordered. Empty: in input order, and every row of a partition is a peer of every other. |
| `frame` | [frame](#frame) | Which rows of the partition an aggregate, `first_value`, `last_value` and `nth_value` read for each row. |
| `calls` | [window calls](#window-call) | The functions to compute. |

### frame {#frame}

| Field | Type | |
|---|---|---|
| `unit` | `"ROWS"`, `"RANGE"` or `"GROUPS"` | What the bounds count: rows, a distance in the value of the one `order` key, or sets of peers (rows equal by `order`). |
| `start` | [frame bound](#frame) | Where the frame starts. |
| `end` | frame bound | Where it ends. |
| `exclude` | `"NO OTHERS"`, `"CURRENT ROW"`, `"GROUP"` or `"TIES"` | Rows left out of the frame: none, the row itself, the row and its peers, or its peers but not the row. |

A frame bound is `{"kind": …}`, one of `unboundedPreceding` (the partition's first row), `currentRow` (the row; with
`RANGE` and `GROUPS`, its first or last peer), `unboundedFollowing` (the partition's last row), or `{"kind":
"preceding" | "following", "offset": …}`, that many rows, groups or units of the key before or after the row. An
offset is an expression over no columns. For a `RANGE` over a `date` key, it counts days.

### window-call {#window-call}

| Field | Type | |
|---|---|---|
| `fn` | string | A ranking function (`row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`), a navigation function (`lag`, `lead`, `first_value`, `last_value`, `nth_value`) or an [aggregate function](../functions/aggregate/) over the frame. |
| `args` | [expressions](../expressions/) | Its arguments, over the input's columns, as many as the function takes. |
| `star` | boolean | `true` for `count` with no arguments (SQL's `count(*)`); `false` otherwise. |
| `filter` | [expression](../expressions/) | Optional: only the frame's rows for which this is true take part in an aggregate. |
| `type` | [type](../types) | The type of its result. |
| `collation` | [collation](../collations) | The call's collation. As an [aggregate call](./aggregate#agg-call)'s, the engine compares text by the collation the first argument carries. |
| `ignoreNulls` | boolean | Optional, navigation functions only: count only rows whose value is not NULL. |

## Output

Its input's columns, then one column for each call.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | A call names no window or aggregate function, has the wrong number of arguments, or sets `ignoreNulls` on a function that isn't a navigation function; an expression reads a column it can't, or `frame` is missing a bound. |
| `SMALT_ERROR` | A frame offset is negative or NULL, or `ntile`'s or `nth_value`'s number is not a positive integer. |

## Notes

- Ranking functions, `lag` and `lead` read the partition in order and don't read the frame; aggregates,
  `first_value`, `last_value` and `nth_value` read the frame.
- With an empty `order`, the window keeps its input's order, and its ranking and navigation calls and a `ROWS` frame
  take the rows in that order ([order](../order)). With an `order`, the order of its output is not defined.
- A frame whose start comes after its end is empty: an aggregate over it is NULL (`count` 0).
- With `ignoreNulls`, `lag(x, 2)` is the second earlier row whose `x` is not NULL (its default when there is none),
  and `first_value`, `last_value` and `nth_value` skip NULLs in the frame.

## Examples

Ranking the orders by day. Orders of one day are peers: `rank` and `dense_rank` give them one rank:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "window",
    "input": {"op": "scan", "table": "orders", "columns": [0, 3]},
    "partition": [],
    "order": [
      {
        "expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ],
    "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
    "calls": [
      {"fn": "rank", "args": [], "star": false, "type": "int", "collation": "binary"},
      {"fn": "dense_rank", "args": [], "star": false, "type": "int", "collation": "binary"},
      {"fn": "ntile", "args": [{"k": "lit", "value": 2, "type": "int"}], "star": false, "type": "int", "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "day"}, {"name": "rank"}, {"name": "dense_rank"}, {"name": "half"}]
}
```

| id | day | rank | dense_rank | half |
|---|---|---|---|---|
| 1 | 2026-11-02 | 1 | 1 | 1 |
| 2 | 2026-11-02 | 1 | 1 | 1 |
| 3 | 2026-11-03 | 3 | 2 | 1 |
| 4 | 2026-11-04 | 4 | 3 | 2 |
| 5 | 2026-11-05 | 5 | 4 | 2 |
| 6 | 2026-11-05 | 5 | 4 | 2 |

Each fruit's orders by id: the order before, and a running total over a `ROWS` frame:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "window",
    "input": {"op": "scan", "table": "orders", "columns": [0, 1, 2]},
    "partition": [
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "collation": "binary"}
    ],
    "order": [
      {
        "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ],
    "frame": {"unit": "ROWS", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
    "calls": [
      {"fn": "lag", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "type": "int", "collation": "binary"},
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "type": "int", "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}, {"name": "previous"}, {"name": "running"}]
}
```

| id | fruit | n | previous | running |
|---|---|---|---|---|
| 1 | 1 | 3 | NULL | 3 |
| 2 | 2 | 1 | NULL | 1 |
| 3 | 1 | 2 | 3 | 5 |
| 4 | 4 | 10 | NULL | 10 |
| 5 | 3 | 5 | NULL | 5 |
| 6 | 1 | 1 | 2 | 6 |

A `RANGE` frame over a date: the items ordered that day and the day before:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "window",
    "input": {"op": "scan", "table": "orders", "columns": [0, 3, 2]},
    "partition": [],
    "order": [
      {
        "expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ],
    "frame": {
      "unit": "RANGE",
      "start": {"kind": "preceding", "offset": {"k": "lit", "value": 1, "type": "int"}},
      "end": {"kind": "currentRow"},
      "exclude": "NO OTHERS"
    },
    "calls": [
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "type": "int", "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "day"}, {"name": "n"}, {"name": "two_days"}]
}
```

| id | day | n | two_days |
|---|---|---|---|
| 1 | 2026-11-02 | 3 | 4 |
| 2 | 2026-11-02 | 1 | 4 |
| 3 | 2026-11-03 | 2 | 6 |
| 4 | 2026-11-04 | 10 | 12 |
| 5 | 2026-11-05 | 5 | 16 |
| 6 | 2026-11-05 | 1 | 16 |

`ignoreNulls`: the stock of the fruit before, by id, and the last one known (plum's is NULL):

```json
{
  "kind": "query",
  "plan": {
    "op": "window",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1, 4]},
    "partition": [],
    "order": [],
    "frame": {"unit": "ROWS", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
    "calls": [
      {"fn": "lag", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "type": "int", "collation": "binary"},
      {"fn": "lag", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "type": "int", "collation": "binary", "ignoreNulls": true}
    ]
  },
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "qty"}, {"name": "lag"}, {"name": "lag_known"}]
}
```

| id | name | qty | lag | lag_known |
|---|---|---|---|---|
| 1 | apple | 10 | NULL | NULL |
| 2 | pear | 4 | 10 | 10 |
| 3 | plum | NULL | 4 | 4 |
| 4 | cherry | 25 | NULL | 4 |
| 5 | lime | 0 | 25 | 25 |

`ignoreNulls` on an aggregate:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "window",
  "input": {"op": "scan", "table": "fruit", "columns": [4]},
  "partition": [],
  "order": [],
  "frame": {"unit": "ROWS", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
  "calls": [
    {"fn": "sum", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
    ], "star": false, "type": "int", "collation": "binary", "ignoreNulls": true}
  ]
}
```

## Demo

Each fruit beside its color's total stock and its rank by price within its color, dearest first, sorted by name:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "window",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 3, 4]},
      "partition": [
        {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}, "collation": "binary"}
      ],
      "order": [
        {
          "expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"},
          "desc": true,
          "nullsFirst": false,
          "collation": "binary"
        }
      ],
      "frame": {
        "unit": "ROWS",
        "start": {"kind": "unboundedPreceding"},
        "end": {"kind": "unboundedFollowing"},
        "exclude": "NO OTHERS"
      },
      "calls": [
        {"fn": "sum", "args": [
          {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"},
        {"fn": "row_number", "args": [], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "name"}, {"name": "color"}, {"name": "price"}, {"name": "qty"}, {"name": "color_stock"}, {"name": "rank"}]
}
```

| name | color | price | qty | color_stock | rank |
|---|---|---|---|---|---|
| apple | red | 0.5 | 10 | 35 | 2 |
| cherry | red | 3 | 25 | 35 | 1 |
| lime | green | 0.4 | 0 | 4 | 2 |
| pear | green | 0.75 | 4 | 4 | 1 |
| plum | purple | 1.25 | NULL | NULL | 1 |

## See also

- [Window functions](../functions/window/), [aggregate functions](../functions/aggregate/)
- [`aggregate`](./aggregate): one row per group instead of one per row
- [`sort`](./sort), [order](../order)
- [Operations](./)
