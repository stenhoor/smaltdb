---
description: 'Ranking and navigation over a window''s rows: row numbers, ranks, buckets, and values of other rows.'
---

# Window functions

```railroad
window-call
frame
frame-bound
```

A window function gives each row a value computed from other rows of its partition. A plan calls one in a
[`window`](../../operations/window)'s `calls`; the operation gives its input's columns, then one column per call. The
window's `partition` splits the rows, its `order` orders each partition, and its `frame` chooses, for each row, the rows
that some functions read. A call names the function (`fn`), gives its arguments (`args`, expressions over the row) and
the `type` of its result.

- **Ranking functions** (`row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`) number the rows of a
  partition in the window's `order`. Rows whose `order` keys are equal are peers, and share a rank. They don't read the
  frame.
- **Navigation functions** read the value of another row. `lag` and `lead` count rows back or forward from the current
  row in the partition, and don't read the frame. `first_value`, `last_value` and `nth_value` read the frame.
- **Aggregates.** Any [aggregate function](../aggregate/) can be a call: it is computed over each row's frame. A window
  call has no `distinct`; its `filter` leaves rows out of the aggregate. Ranking and navigation calls ignore a `filter`.
- **`ignoreNulls`.** With `"ignoreNulls": true`, a navigation function counts only rows whose value is not NULL (SQL's
  `IGNORE NULLS`). Any other function is refused with it (`SMALT_PLAN`).
- **Without an `order`,** every row of a partition is a peer of every other, and functions that count rows take them in
  input order ([order](../../order)).
- **Errors.** A name that is no window or aggregate function, or a wrong number of arguments, is refused when the plan
  is compiled (`SMALT_PLAN`). A bad argument found while it runs (`ntile` of 0, `nth_value` at 0, a negative frame
  offset) is `SMALT_ERROR`.

## Frames {#frames}

A frame is `{unit, start, end, exclude}`: the rows from `start` to `end` around the current row, less those `exclude`
names.

- **`unit`.** `ROWS` counts rows. `GROUPS` counts groups of peers. `RANGE` measures by the value of the first `order`
  key: `preceding` with offset 1 starts at the first row whose key is at most 1 less than the current row's. A row whose
  key is not a number (NULL, text) has its peers as its offset bounds.
- **Bounds.** `unboundedPreceding` and `unboundedFollowing` are the ends of the partition. `currentRow` is the current
  row in `ROWS`, and its first (as a start) or last (as an end) peer in `RANGE` and `GROUPS`. `preceding` and
  `following` take an `offset`, an expression over no columns: a non-negative integer, or for `RANGE` a non-negative
  number.
- **`exclude`.** `NO OTHERS` keeps every row; `CURRENT ROW` takes out the current row, `GROUP` the current row and its
  peers, `TIES` its peers but not the current row.
- **The usual frame,** SQL's default, is `RANGE` from `unboundedPreceding` to `currentRow`, with `NO OTHERS`: the rows
  from the start of the partition to the current row's last peer. Without an `order`, that is the whole partition.
- A frame that starts after it ends has no rows: an aggregate over it gives what it gives for an empty group.

## Examples

Ranking and navigation: each day's orders numbered and ranked, largest first, with the pieces of the order before it:

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
      "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
      "calls": [
        {"fn": "row_number", "args": [], "star": false, "type": "int", "collation": "binary"},
        {"fn": "rank", "args": [], "star": false, "type": "int", "collation": "binary"},
        {"fn": "lag", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"},
      {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"}
    ]
  },
  "columns": [
    {"name": "id"},
    {"name": "fruit"},
    {"name": "n"},
    {"name": "day"},
    {"name": "number"},
    {"name": "rank"},
    {"name": "before"}
  ]
}
```

| id | fruit | n | day | number | rank | before |
|---|---|---|---|---|---|---|
| 1 | 1 | 3 | 2026-11-02 | 1 | 1 | NULL |
| 2 | 2 | 1 | 2026-11-02 | 2 | 2 | 3 |
| 3 | 1 | 2 | 2026-11-03 | 1 | 1 | NULL |
| 4 | 4 | 10 | 2026-11-04 | 1 | 1 | NULL |
| 5 | 3 | 5 | 2026-11-05 | 1 | 1 | NULL |
| 6 | 1 | 1 | 2026-11-05 | 2 | 2 | 5 |

One `sum` over five values with different frames (each `window` has one frame):

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "window",
      "input": {
        "op": "window",
        "input": {
          "op": "window",
          "input": {
            "op": "values",
            "types": ["int"],
            "rows": [
              [{"k": "lit", "value": 1, "type": "int"}],
              [{"k": "lit", "value": 2, "type": "int"}],
              [{"k": "lit", "value": 2, "type": "int"}],
              [{"k": "lit", "value": 4, "type": "int"}],
              [{"k": "lit", "value": 7, "type": "int"}]
            ]
          },
          "partition": [],
          "order": [
            {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
          ],
          "frame": {"unit": "ROWS", "start": {
            "kind": "preceding",
            "offset": {"k": "lit", "value": 1, "type": "int"}
          }, "end": {
            "kind": "following",
            "offset": {"k": "lit", "value": 1, "type": "int"}
          }, "exclude": "NO OTHERS"},
          "calls": [
            {"fn": "sum", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
            ], "star": false, "type": "int", "collation": "binary"}
          ]
        },
        "partition": [],
        "order": [
          {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
        ],
        "frame": {"unit": "RANGE", "start": {
          "kind": "preceding",
          "offset": {"k": "lit", "value": 1, "type": "int"}
        }, "end": {
          "kind": "following",
          "offset": {"k": "lit", "value": 1, "type": "int"}
        }, "exclude": "NO OTHERS"},
        "calls": [
          {"fn": "sum", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ], "star": false, "type": "int", "collation": "binary"}
        ]
      },
      "partition": [],
      "order": [
        {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
      ],
      "frame": {"unit": "GROUPS", "start": {
        "kind": "preceding",
        "offset": {"k": "lit", "value": 1, "type": "int"}
      }, "end": {
        "kind": "currentRow"
      }, "exclude": "NO OTHERS"},
      "calls": [
        {"fn": "sum", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "rows -1 to +1"}, {"name": "range -1 to +1"}, {"name": "groups -1 to current"}]
}
```

| x | rows -1 to +1 | range -1 to +1 | groups -1 to current |
|---|---|---|---|
| 1 | 3 | 5 | 1 |
| 2 | 5 | 5 | 5 |
| 2 | 8 | 5 | 5 |
| 4 | 13 | 4 | 8 |
| 7 | 11 | 7 | 11 |

The usual frame, and the whole partition less the current row's peers:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "window",
      "input": {
        "op": "window",
        "input": {
          "op": "values",
          "types": ["int"],
          "rows": [
            [{"k": "lit", "value": 1, "type": "int"}],
            [{"k": "lit", "value": 2, "type": "int"}],
            [{"k": "lit", "value": 2, "type": "int"}],
            [{"k": "lit", "value": 4, "type": "int"}],
            [{"k": "lit", "value": 7, "type": "int"}]
          ]
        },
        "partition": [],
        "order": [
          {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
        ],
        "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
        "calls": [
          {"fn": "sum", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ], "star": false, "type": "int", "collation": "binary"}
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
      }, "exclude": "GROUP"},
      "calls": [
        {"fn": "sum", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "usual"}, {"name": "others"}]
}
```

| x | usual | others |
|---|---|---|
| 1 | 1 | 15 |
| 2 | 5 | 12 |
| 2 | 5 | 12 |
| 4 | 9 | 12 |
| 7 | 16 | 9 |

`ignoreNulls` is for navigation functions only:

<!-- docs:error SMALT_PLAN -->
```json
{
  "kind": "query",
  "plan": {
    "op": "window",
    "input": {
      "op": "values",
      "types": ["int"],
      "rows": [
        [{"k": "lit", "value": 1, "type": "int"}],
        [{"k": "lit", "value": 2, "type": "int"}],
        [{"k": "lit", "value": 2, "type": "int"}],
        [{"k": "lit", "value": 4, "type": "int"}],
        [{"k": "lit", "value": 7, "type": "int"}]
      ]
    },
    "partition": [],
    "order": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ],
    "frame": {"unit": "RANGE", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
    "calls": [{"fn": "rank", "args": [], "star": false, "type": "int", "collation": "binary", "ignoreNulls": true}]
  },
  "columns": [{"name": "x"}, {"name": "rank"}]
}
```

A frame offset must not be negative:

<!-- docs:error SMALT_ERROR -->
```json
{
  "kind": "query",
  "plan": {
    "op": "window",
    "input": {
      "op": "values",
      "types": ["int"],
      "rows": [
        [{"k": "lit", "value": 1, "type": "int"}],
        [{"k": "lit", "value": 2, "type": "int"}],
        [{"k": "lit", "value": 2, "type": "int"}],
        [{"k": "lit", "value": 4, "type": "int"}],
        [{"k": "lit", "value": 7, "type": "int"}]
      ]
    },
    "partition": [],
    "order": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ],
    "frame": {"unit": "ROWS", "start": {
      "kind": "preceding",
      "offset": {"k": "lit", "value": -1, "type": "int"}
    }, "end": {
      "kind": "currentRow"
    }, "exclude": "NO OTHERS"},
    "calls": [
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "type": "int", "collation": "binary"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "sum"}]
}
```

## Functions {#functions}

- [`row_number`](./row_number): The number of a row in its partition, from 1, in the window's order.
- [`rank`](./rank): The rank of a row in its partition, with gaps after ties: 1 plus the rows before its peers.
- [`dense_rank`](./dense_rank): The rank of a row in its partition, without gaps: the number of its peer group.
- [`percent_rank`](./percent_rank): The relative rank of a row in its partition, from 0 to 1: `(rank − 1) / (rows − 1)`.
- [`cume_dist`](./cume_dist): The cumulative distribution of a row in its partition: the share of rows up to its last peer.
- [`ntile`](./ntile): Which of `N` nearly equal buckets a row falls in, in its partition's order.
- [`lag`](./lag): The value of a row `OFFSET` rows before this one in its partition, or a default.
- [`lead`](./lead): The value of a row `OFFSET` rows after this one in its partition, or a default.
- [`first_value`](./first_value): The value of `X` at the first row of the frame.
- [`last_value`](./last_value): The value of `X` at the last row of the frame.
- [`nth_value`](./nth_value): The value of `X` at the `N`th row of the frame.
