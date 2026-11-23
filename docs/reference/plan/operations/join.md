---
description: 'The rows of two inputs combined: inner, outer, cross, semi, anti and as-of joins.'
---

# join

```railroad
join
join-kind
asof-match
```

The rows of two inputs combined: inner, outer, cross, semi, anti and as-of joins. Its condition reads both inputs:
input 0 is the left, input 1 the right.

## Fields

| Field | Type | |
|---|---|---|
| `kind` | [join kind](#kinds) | How rows combine. |
| `inputs` | two operations | The left input, then the right. |
| `on` | [expression](../expressions/) | Optional: the condition a pair of rows must meet, over the left row (input 0) and the right row (input 1). Without it, every pair meets it. |
| `ordered` | `true` | Optional: keep the left input's order, and for each left row its matches in the right input's order. |
| `asof` | [as-of match](#as-of) | An `asof` join's match: required for that kind, and given for no other. |

## Output

The left input's columns, then the right input's. A `semi` or `anti` join gives the left input's columns only.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | There are not two inputs, the kind is unknown, `on` reads a column it can't, `ordered` is not `true`, an `asof` join has no `asof` or another kind has one, or the match's direction is unknown or its tolerance reads a column. |

## Notes

### Kinds {#kinds}

| Kind | Rows |
|---|---|
| `inner` | Each pair of rows that meets `on`. |
| `left` | As `inner`, and each left row that meets it with no right row, with NULLs for the right's columns. |
| `right` | As `inner`, and each right row that meets it with no left row, with NULLs for the left's columns. |
| `full` | As `inner`, and the unmatched rows of both sides, each with NULLs for the other's columns. |
| `cross` | Each pair of rows (with `on`, each pair that meets it, as `inner`). |
| `semi` | Each left row that meets `on` with at least one right row, once. |
| `anti` | Each left row that meets `on` with no right row. |
| `asof` | Each left row with the right row whose key is nearest its own: [as-of joins](#as-of). |

- A pair meets `on` when the condition is true, as a [`filter`](./filter) reads it: a NULL key matches nothing,
  since a comparison with NULL is unknown.
- **Order.** `semi` and `anti` joins keep the left input's order, and so does an `asof` join. With `ordered: true`,
  a join gives the left input's order, and each left row's matches in the right input's order; a left join's unmatched
  left rows keep their place, and a right or full join's unmatched right rows come last, in the right input's order.
  Without it, the order is not defined ([order](../order)).
- The right input reads no columns of the left, except a [`source`](./source)'s arguments: a table function on the
  right is read again for each left row (a lateral join).

### As-of joins {#as-of}

```railroad
asof-match
```

An `asof` join gives each left row the one right row whose key is nearest its own, or NULLs for the right's columns
when no row is near enough: each trade with the last quote before it, each reading with the nearest calibration.

| Field | Type | |
|---|---|---|
| `left` | [expression](../expressions/) | The left row's key, over input 0. |
| `right` | [expression](../expressions/) | The right row's key, over input 1. |
| `direction` | `"backward"`, `"forward"` or `"nearest"` | `backward`: the largest right key at or below the left's. `forward`: the smallest at or above it. `nearest`: the closest either way, ties to the smaller key. |
| `tolerance` | [expression](../expressions/) | Optional: the largest distance between the keys, an expression over no columns. |

- `on` limits the candidates: only right rows that meet it with the left row are considered (the same fruit, the
  same symbol). With an equality in `on`, the engine uses it to find them; without one, it compares every pair.
- The distance is the left key minus the right key (or the other way, `forward`), as [`sub`](../functions/arithmetic/sub)
  gives it: for dates and times a `duration`, so the tolerance is one too (in µs: `86400000000` is a day).
- A left row whose key is NULL has no match. Which of two right rows with the same key a left row takes is not
  defined.

## Examples

The fruit under 1.00 and their orders, kind by kind. `inner`:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "inner",
    "inputs": [
      {
        "op": "filter",
        "input": {"op": "scan", "table": "fruit", "columns": [0, 1, 3]},
        "pred": {"k": "call", "fn": "cmp_lt", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "bool"}
      },
      {"op": "scan", "table": "orders", "columns": [0, 1, 2]}
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "ordered": true
  },
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "price"}, {"name": "order"}, {"name": "fruit"}, {"name": "n"}]
}
```

| id | name | price | order | fruit | n |
|---|---|---|---|---|---|
| 1 | apple | 0.5 | 1 | 1 | 3 |
| 1 | apple | 0.5 | 3 | 1 | 2 |
| 1 | apple | 0.5 | 6 | 1 | 1 |
| 2 | pear | 0.75 | 2 | 2 | 1 |

`left` adds lime, which has no orders:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "left",
    "inputs": [
      {
        "op": "filter",
        "input": {"op": "scan", "table": "fruit", "columns": [0, 1, 3]},
        "pred": {"k": "call", "fn": "cmp_lt", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "bool"}
      },
      {"op": "scan", "table": "orders", "columns": [0, 1, 2]}
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "ordered": true
  },
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "price"}, {"name": "order"}, {"name": "fruit"}, {"name": "n"}]
}
```

| id | name | price | order | fruit | n |
|---|---|---|---|---|---|
| 1 | apple | 0.5 | 1 | 1 | 3 |
| 1 | apple | 0.5 | 3 | 1 | 2 |
| 1 | apple | 0.5 | 6 | 1 | 1 |
| 2 | pear | 0.75 | 2 | 2 | 1 |
| 5 | lime | 0.4 | NULL | NULL | NULL |

`right` adds, after the matches, the orders whose fruit is not under 1.00:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "right",
    "inputs": [
      {
        "op": "filter",
        "input": {"op": "scan", "table": "fruit", "columns": [0, 1, 3]},
        "pred": {"k": "call", "fn": "cmp_lt", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "bool"}
      },
      {"op": "scan", "table": "orders", "columns": [0, 1, 2]}
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "ordered": true
  },
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "price"}, {"name": "order"}, {"name": "fruit"}, {"name": "n"}]
}
```

| id | name | price | order | fruit | n |
|---|---|---|---|---|---|
| 1 | apple | 0.5 | 1 | 1 | 3 |
| 1 | apple | 0.5 | 3 | 1 | 2 |
| 1 | apple | 0.5 | 6 | 1 | 1 |
| 2 | pear | 0.75 | 2 | 2 | 1 |
| NULL | NULL | NULL | 4 | 4 | 10 |
| NULL | NULL | NULL | 5 | 3 | 5 |

`full` adds both:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "full",
    "inputs": [
      {
        "op": "filter",
        "input": {"op": "scan", "table": "fruit", "columns": [0, 1, 3]},
        "pred": {"k": "call", "fn": "cmp_lt", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "bool"}
      },
      {"op": "scan", "table": "orders", "columns": [0, 1, 2]}
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "ordered": true
  },
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "price"}, {"name": "order"}, {"name": "fruit"}, {"name": "n"}]
}
```

| id | name | price | order | fruit | n |
|---|---|---|---|---|---|
| 1 | apple | 0.5 | 1 | 1 | 3 |
| 1 | apple | 0.5 | 3 | 1 | 2 |
| 1 | apple | 0.5 | 6 | 1 | 1 |
| 2 | pear | 0.75 | 2 | 2 | 1 |
| 5 | lime | 0.4 | NULL | NULL | NULL |
| NULL | NULL | NULL | 4 | 4 | 10 |
| NULL | NULL | NULL | 5 | 3 | 5 |

`semi` gives each fruit that has an order, once; `anti` each that has none:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "semi",
    "inputs": [
      {
        "op": "filter",
        "input": {"op": "scan", "table": "fruit", "columns": [0, 1, 3]},
        "pred": {"k": "call", "fn": "cmp_lt", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "bool"}
      },
      {"op": "scan", "table": "orders", "columns": [0, 1, 2]}
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "ordered": true
  },
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "price"}]
}
```

| id | name | price |
|---|---|---|
| 1 | apple | 0.5 |
| 2 | pear | 0.75 |

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "anti",
    "inputs": [
      {
        "op": "filter",
        "input": {"op": "scan", "table": "fruit", "columns": [0, 1, 3]},
        "pred": {"k": "call", "fn": "cmp_lt", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "bool"}
      },
      {"op": "scan", "table": "orders", "columns": [0, 1, 2]}
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "ordered": true
  },
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "price"}]
}
```

| id | name | price |
|---|---|---|
| 5 | lime | 0.4 |

`cross`: every pair, here of two fruit names and two days:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "cross",
    "inputs": [
      {"op": "values", "rows": [], "types": ["text"], "columns": [["apple", "pear"]]},
      {"op": "values", "rows": [], "types": ["date"], "columns": [["2026-11-02", "2026-11-03"]]}
    ],
    "ordered": true
  },
  "columns": [{"name": "fruit"}, {"name": "day"}]
}
```

| fruit | day |
|---|---|
| apple | 2026-11-02 |
| apple | 2026-11-03 |
| pear | 2026-11-02 |
| pear | 2026-11-03 |

An as-of join: each order with its fruit's price on the order's day, from a list of prices and the day each took
effect. `backward` takes the latest price at or before the day; pear (2) and plum (3) have no prices:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "asof",
    "inputs": [
      {"op": "scan", "table": "orders", "columns": [0, 1, 3]},
      {
        "op": "values",
        "rows": [],
        "types": ["int", "date", "real"],
        "columns": [[1, 1, 4, 4], ["2026-11-01", "2026-11-03", "2026-11-01", "2026-11-05"], [0.5, 0.6, 3, 2.8]]
      }
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "asof": {
      "left": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"},
      "right": {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
      "direction": "backward"
    }
  },
  "columns": [{"name": "order"}, {"name": "fruit"}, {"name": "day"}, {"name": "p_fruit"}, {"name": "since"}, {"name": "price"}]
}
```

| order | fruit | day | p_fruit | since | price |
|---|---|---|---|---|---|
| 1 | 1 | 2026-11-02 | 1 | 2026-11-01 | 0.5 |
| 2 | 2 | 2026-11-02 | NULL | NULL | NULL |
| 3 | 1 | 2026-11-03 | 1 | 2026-11-03 | 0.6 |
| 4 | 4 | 2026-11-04 | 4 | 2026-11-01 | 3 |
| 5 | 3 | 2026-11-05 | NULL | NULL | NULL |
| 6 | 1 | 2026-11-05 | 1 | 2026-11-03 | 0.6 |

`forward` takes the first price on or after the day, and `nearest` the closest:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "asof",
    "inputs": [
      {"op": "scan", "table": "orders", "columns": [0, 1, 3]},
      {
        "op": "values",
        "rows": [],
        "types": ["int", "date", "real"],
        "columns": [[1, 1, 4, 4], ["2026-11-01", "2026-11-03", "2026-11-01", "2026-11-05"], [0.5, 0.6, 3, 2.8]]
      }
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "asof": {
      "left": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"},
      "right": {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
      "direction": "forward"
    }
  },
  "columns": [{"name": "order"}, {"name": "fruit"}, {"name": "day"}, {"name": "p_fruit"}, {"name": "since"}, {"name": "price"}]
}
```

| order | fruit | day | p_fruit | since | price |
|---|---|---|---|---|---|
| 1 | 1 | 2026-11-02 | 1 | 2026-11-03 | 0.6 |
| 2 | 2 | 2026-11-02 | NULL | NULL | NULL |
| 3 | 1 | 2026-11-03 | 1 | 2026-11-03 | 0.6 |
| 4 | 4 | 2026-11-04 | 4 | 2026-11-05 | 2.8 |
| 5 | 3 | 2026-11-05 | NULL | NULL | NULL |
| 6 | 1 | 2026-11-05 | NULL | NULL | NULL |

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "asof",
    "inputs": [
      {"op": "scan", "table": "orders", "columns": [0, 1, 3]},
      {
        "op": "values",
        "rows": [],
        "types": ["int", "date", "real"],
        "columns": [[1, 1, 4, 4], ["2026-11-01", "2026-11-03", "2026-11-01", "2026-11-05"], [0.5, 0.6, 3, 2.8]]
      }
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "asof": {
      "left": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"},
      "right": {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
      "direction": "nearest"
    }
  },
  "columns": [{"name": "order"}, {"name": "fruit"}, {"name": "day"}, {"name": "p_fruit"}, {"name": "since"}, {"name": "price"}]
}
```

| order | fruit | day | p_fruit | since | price |
|---|---|---|---|---|---|
| 1 | 1 | 2026-11-02 | 1 | 2026-11-01 | 0.5 |
| 2 | 2 | 2026-11-02 | NULL | NULL | NULL |
| 3 | 1 | 2026-11-03 | 1 | 2026-11-03 | 0.6 |
| 4 | 4 | 2026-11-04 | 4 | 2026-11-05 | 2.8 |
| 5 | 3 | 2026-11-05 | NULL | NULL | NULL |
| 6 | 1 | 2026-11-05 | 1 | 2026-11-03 | 0.6 |

With a tolerance of one day (a `duration`, in µs), a price older than that is no match:

```json
{
  "kind": "query",
  "plan": {
    "op": "join",
    "kind": "asof",
    "inputs": [
      {"op": "scan", "table": "orders", "columns": [0, 1, 3]},
      {
        "op": "values",
        "rows": [],
        "types": ["int", "date", "real"],
        "columns": [[1, 1, 4, 4], ["2026-11-01", "2026-11-03", "2026-11-01", "2026-11-05"], [0.5, 0.6, 3, 2.8]]
      }
    ],
    "on": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
    ], "type": "bool"},
    "asof": {
      "left": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"},
      "right": {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
      "direction": "backward",
      "tolerance": {"k": "lit", "value": 86400000000, "type": "duration"}
    }
  },
  "columns": [{"name": "order"}, {"name": "fruit"}, {"name": "day"}, {"name": "p_fruit"}, {"name": "since"}, {"name": "price"}]
}
```

| order | fruit | day | p_fruit | since | price |
|---|---|---|---|---|---|
| 1 | 1 | 2026-11-02 | 1 | 2026-11-01 | 0.5 |
| 2 | 2 | 2026-11-02 | NULL | NULL | NULL |
| 3 | 1 | 2026-11-03 | 1 | 2026-11-03 | 0.6 |
| 4 | 4 | 2026-11-04 | NULL | NULL | NULL |
| 5 | 3 | 2026-11-05 | NULL | NULL | NULL |
| 6 | 1 | 2026-11-05 | NULL | NULL | NULL |

An `asof` join without its match:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "join",
  "kind": "asof",
  "inputs": [
    {"op": "scan", "table": "orders", "columns": [0, 3]},
    {
      "op": "values",
      "rows": [],
      "types": ["int", "date", "real"],
      "columns": [[1, 1, 4, 4], ["2026-11-01", "2026-11-03", "2026-11-01", "2026-11-05"], [0.5, 0.6, 3, 2.8]]
    }
  ]
}
```

## Demo

The total each fruit was ordered for, at the price in force on each order's day: an as-of join, then an
[`aggregate`](./aggregate) over it:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "join",
      "kind": "asof",
      "inputs": [
        {"op": "scan", "table": "orders", "columns": [1, 2, 3]},
        {
          "op": "values",
          "rows": [],
          "types": ["int", "date", "real"],
          "columns": [[1, 1, 4, 4], ["2026-11-01", "2026-11-03", "2026-11-01", "2026-11-05"], [0.5, 0.6, 3, 2.8]]
        }
      ],
      "on": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "bool"},
      "asof": {
        "left": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"},
        "right": {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
        "direction": "backward"
      }
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "sum", "args": [
        {"k": "call", "fn": "mul", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "col", "input": 0, "index": 5, "depth": 0, "type": "real", "collation": "binary"}
        ], "type": "real"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "fruit"}, {"name": "total"}]
}
```

| fruit | total |
|---|---|
| 1 | 3.3 |
| 2 | NULL |
| 4 | 30 |
| 3 | NULL |

## See also

- [`relationships`](./relationships): a hop of a graph pattern is a join
- [`source`](./source): a table function as a lateral join's right input
- [`setop`](./setop): rows of two inputs, one after the other
- [`filter`](./filter), [order](../order)
- [Operations](./)
