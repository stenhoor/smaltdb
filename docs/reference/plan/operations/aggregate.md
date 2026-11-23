---
description: 'One row for each group of its input''s rows, with aggregate functions over the group.'
---

# aggregate

```railroad
aggregate
group-key
agg-call
```

One row for each group of its input's rows, with aggregate functions over the group: SQL's `GROUP BY` and its
aggregates. Rows whose keys are equal make a group; with no keys, every row is in one group.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to group. |
| `keys` | [group keys](#group-key) | What makes a group. May be empty: then the aggregate gives one row. |
| `aggs` | [aggregate calls](#agg-call) | The aggregates to compute over each group. May be empty. |
| `carry` | [expressions](../expressions/) | Input values carried to the output, from one row of each group: SQL's bare columns. May be empty. |
| `ordered` | `"first"` | Optional: give the groups in the order of each group's first row. |

### group-key {#group-key}

| Field | Type | |
|---|---|---|
| `expr` | [expression](../expressions/) | The key's value, over the input's columns (input 0). |
| `collation` | [collation](../collations) | How its text values compare: rows whose keys are equal by it are one group. |

### agg-call {#agg-call}

| Field | Type | |
|---|---|---|
| `fn` | string | An [aggregate function](../functions/aggregate/): `count`, `sum`, `avg`, `min`, `max`, `group_concat`, … |
| `args` | [expressions](../expressions/) | Its arguments, over the input's columns, as many as the function takes. |
| `star` | boolean | `true` for `count` with no arguments, which counts rows (SQL's `count(*)`); `false` otherwise. |
| `distinct` | boolean | `true`: each distinct value of the argument once (SQL's `count(DISTINCT x)`). |
| `filter` | [expression](../expressions/) | Optional: only the group's rows for which this is true take part (SQL's `FILTER (WHERE …)`). |
| `collation` | [collation](../collations) | The call's collation. See the notes for what the engine reads. |
| `type` | [type](../types) | The type of its result, as the function's page gives it. |

## Output

The keys, then one column for each aggregate call, then the carried columns, in that order.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | A call names no aggregate function, has the wrong number of arguments, or is `count` with no arguments and `star` false; an expression reads a column the input doesn't have; or `ordered` has another value. |

Errors an aggregate function raises (an argument out of range, say) are the aggregate's.

## Notes

- NULL keys are equal to each other here: rows whose key is NULL are one group.
- With no keys, an aggregate gives one row also over no input rows: `count` is 0 there, and most others NULL. With
  keys, no input rows give no rows.
- Groups come in no promised order; `ordered: "first"` gives them in the order of each group's first row
  ([order](../order)). [`first`](../functions/aggregate/first) and
  [`last`](../functions/aggregate/last) are defined by the group's input order.
- A carried value comes from one row of the group. With one `min` or `max` call, it is the row that holds that value,
  as SQLite's bare columns are.
- At present the engine compares an aggregate's text values (for `min`, `max`, and `distinct`) by the collation its
  first argument carries ([`carries`](../meaning-fields#carries-and-affinity)), `binary` where it carries none, and
  does not read the call's `collation`.
- A plan that filters on the aggregates (SQL's `HAVING`) puts a [`filter`](./filter) above the aggregate, over its
  output columns.

## Examples

The fruit by color: how many, their stock, their average price and their names:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 3, 4]},
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "avg", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "group_concat", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "text"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "fruit"}, {"name": "stock"}, {"name": "avg_price"}, {"name": "names"}]
}
```

| color | fruit | stock | avg_price | names |
|---|---|---|---|---|
| red | 2 | 35 | 1.75 | apple,cherry |
| green | 2 | 4 | 0.575 | pear,lime |
| purple | 1 | NULL | 1.25 | plum |

No keys, over no rows: one row all the same:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [4]},
      "pred": {"k": "lit", "value": 0, "type": "bool"}
    },
    "keys": [],
    "aggs": [
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "count"}, {"name": "sum"}]
}
```

| count | sum |
|---|---|
| 0 | NULL |

`distinct` and `filter`: how many fruit were ordered, how many of fruit 1, and the orders in all:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {"op": "scan", "table": "orders", "columns": [1, 2]},
    "keys": [],
    "aggs": [
      {"fn": "count", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": true, "collation": "binary", "type": "int"},
      {
        "fn": "sum",
        "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}],
        "star": false,
        "distinct": false,
        "filter": {"k": "call", "fn": "cmp_eq", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "bool"},
        "collation": "binary",
        "type": "int"
      },
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "fruit"}, {"name": "of_fruit_1"}, {"name": "orders"}]
}
```

| fruit | of_fruit_1 | orders |
|---|---|---|
| 4 | 6 | 6 |

A carried column: the dearest fruit of each color, with `max` choosing the row:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 3]},
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "max", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "price"}, {"name": "name"}]
}
```

| color | price | name |
|---|---|---|
| red | 3 | cherry |
| green | 0.75 | pear |
| purple | 1.25 | plum |

`count` with no arguments must say `star`:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "aggregate",
  "input": {"op": "scan", "table": "fruit", "columns": [0]},
  "keys": [],
  "aggs": [{"fn": "count", "args": [], "star": false, "distinct": false, "collation": "binary", "type": "int"}],
  "carry": []
}
```

## Demo

Each fruit's orders: how many, how many items, and the last day, for the fruit ordered more than once (a filter above
the aggregate, SQL's `HAVING`):

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {
      "op": "aggregate",
      "input": {
        "op": "join",
        "kind": "inner",
        "inputs": [{"op": "scan", "table": "fruit", "columns": [0, 1]}, {"op": "scan", "table": "orders", "columns": [1, 2, 3]}],
        "on": {"k": "call", "fn": "cmp_eq", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "bool"}
      },
      "keys": [
        {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}, "collation": "binary"}
      ],
      "aggs": [
        {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"},
        {"fn": "sum", "args": [
          {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "distinct": false, "collation": "binary", "type": "int"},
        {"fn": "max", "args": [
          {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "date", "collation": "binary"}
        ], "star": false, "distinct": false, "collation": "binary", "type": "date"}
      ],
      "carry": []
    },
    "pred": {"k": "call", "fn": "cmp_gt", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "lit", "value": 1, "type": "int"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}, {"name": "orders"}, {"name": "items"}, {"name": "last_day"}]
}
```

| name | orders | items | last_day |
|---|---|---|---|
| apple | 3 | 6 | 2026-11-05 |

## See also

- [Aggregate functions](../functions/aggregate/)
- [`window`](./window): aggregates over each row's frame, keeping the rows
- [`distinct`](./distinct), [`pivot`](./pivot)
- [Operations](./)
