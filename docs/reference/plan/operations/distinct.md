---
description: 'One row of each set of rows that are equal, by every column or by some.'
---

# distinct

```railroad
distinct
```

One row of each set of rows that are equal, by every column or by some. SQL's `SELECT DISTINCT` is a distinct over
every column; with `on`, it is PostgreSQL's `DISTINCT ON`, or Polars' `unique(subset, keep)`.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to deduplicate. |
| `collations` | [collations](../collations) | One per input column: how its text values compare. |
| `ordered` | `"first"` | Optional: give the rows in the order of each set's first row. |
| `on` | integers | Optional: the columns that make rows equal, by position. Rows are equal when these columns are, whatever the others hold. At least one, each once. |
| `keep` | `"first"` or `"last"` | Optional: which row of each set to keep, by input order. `first` when left out. |

## Output

Its input's columns.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `collations` doesn't have one collation per input column, `on` is empty, names a column the input doesn't have or names one twice, or `keep` or `ordered` has another value. |

## Notes

- NULLs are equal to each other here: rows that differ only by NULLs in the same columns are one set.
- With `on` or `keep`, the kept row is the set's first or last by input order, and the kept rows come in input order;
  with `ordered: "first"` also, in the order of each set's first row. `keep` without `on` compares every column.
- With neither, the kept row of a set and the order of the rows are not defined; `ordered: "first"` gives the order of
  each set's first row ([order](../order)).

## Examples

The colors of the fruit, each once, in the order they first come:

```json
{
  "kind": "query",
  "plan": {
    "op": "distinct",
    "input": {"op": "scan", "table": "fruit", "columns": [2]},
    "collations": ["binary"],
    "ordered": "first"
  },
  "columns": [{"name": "color"}]
}
```

| color |
|---|
| red |
| green |
| purple |

One row for each word, ignoring case, by the `nocase` collation: the first row of each, then the last:

```json
{
  "kind": "query",
  "plan": {
    "op": "distinct",
    "input": {
      "op": "values",
      "rows": [],
      "types": ["text", "int"],
      "columns": [["Red", "red", "green", "RED", null, null, "green"], [1, 2, 3, 4, 5, 6, 7]]
    },
    "collations": ["nocase", "binary"],
    "on": [0]
  },
  "columns": [{"name": "word"}, {"name": "n"}]
}
```

| word | n |
|---|---|
| Red | 1 |
| green | 3 |
| NULL | 5 |

```json
{
  "kind": "query",
  "plan": {
    "op": "distinct",
    "input": {
      "op": "values",
      "rows": [],
      "types": ["text", "int"],
      "columns": [["Red", "red", "green", "RED", null, null, "green"], [1, 2, 3, 4, 5, 6, 7]]
    },
    "collations": ["nocase", "binary"],
    "on": [0],
    "keep": "last"
  },
  "columns": [{"name": "word"}, {"name": "n"}]
}
```

| word | n |
|---|---|
| RED | 4 |
| NULL | 6 |
| green | 7 |

One collation for two columns:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "distinct", "input": {"op": "scan", "table": "fruit", "columns": [1, 2]}, "collations": ["binary"]}
```

## Demo

Each fruit's latest order: the orders by day, and of each fruit the last:

```json
{
  "kind": "query",
  "plan": {
    "op": "distinct",
    "input": {
      "op": "sort",
      "input": {"op": "scan", "table": "orders", "columns": [1, 3, 2]},
      "keys": [
        {
          "expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
          "desc": false,
          "nullsFirst": true,
          "collation": "binary"
        }
      ]
    },
    "collations": ["binary", "binary", "binary"],
    "on": [0],
    "keep": "last"
  },
  "columns": [{"name": "fruit"}, {"name": "day"}, {"name": "n"}]
}
```

| fruit | day | n |
|---|---|---|
| 2 | 2026-11-02 | 1 |
| 4 | 2026-11-04 | 10 |
| 3 | 2026-11-05 | 5 |
| 1 | 2026-11-05 | 1 |

## See also

- [`aggregate`](./aggregate): one row per group, with aggregates over it
- [`setop`](./setop): `union` deduplicates the rows of two inputs
- [Collations](../collations), [order](../order)
- [Operations](./)
