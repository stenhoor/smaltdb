---
description: 'Its input''s rows ordered by its keys; rows with equal keys keep their order.'
---

# sort

```railroad
sort
sort-key
```

Its input's rows ordered by its keys; rows with equal keys keep their order. SQL's `ORDER BY` is a sort.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to order. |
| `keys` | [sort keys](#sort-key) | What to order by: the first key, then the next among rows the first finds equal, and so on. |

### sort-key {#sort-key}

| Field | Type | |
|---|---|---|
| `expr` | [expression](../expressions/) | The value to order by, over the input's columns (input 0). |
| `desc` | boolean | `true`: largest first. `false`: smallest first. |
| `nullsFirst` | boolean | `true`: NULLs before every other value, `false`: after, whichever `desc` is. |
| `collation` | [collation](../collations) | How text values compare. |

## Output

Its input's columns.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | A key reads a column the input doesn't have, `desc` or `nullsFirst` is missing, or the collation is unknown. |

## Notes

- The sort is stable: rows whose keys are all equal keep their input order, also as a top-N under a
  [`limit`](./limit) and when the sort spills to disk ([order](../order)).
- Values of different kinds order as SQLite orders them: NULL, then numbers, then text, then blobs; NaN after every
  number ([values](../values)).
- Operations above a sort that keep an order ([`filter`](./filter), [`project`](./project), [`limit`](./limit)) keep
  this one.

## Examples

The fruit by stock, most first, NULL last:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        "desc": true,
        "nullsFirst": false,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| cherry | 25 |
| apple | 10 |
| pear | 4 |
| lime | 0 |
| plum | NULL |

Two keys: by color, then by price, dearest first:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 3]},
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      },
      {
        "expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"},
        "desc": true,
        "nullsFirst": false,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "name"}, {"name": "color"}, {"name": "price"}]
}
```

| name | color | price |
|---|---|---|
| pear | green | 0.75 |
| lime | green | 0.4 |
| plum | purple | 1.25 |
| cherry | red | 3 |
| apple | red | 0.5 |

Text by the `nocase` collation: `A` and `a` are equal, so they keep their input order:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "project",
      "input": {"op": "values", "rows": [], "types": ["text"], "columns": [["b", "a", "B", "A"]]},
      "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}]
    },
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "nocase"
      }
    ]
  },
  "columns": [{"name": "word"}]
}
```

| word |
|---|
| a |
| A |
| b |
| B |

A key without `nullsFirst`:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "sort",
  "input": {"op": "scan", "table": "fruit", "columns": [1]},
  "keys": [
    {
      "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      "desc": false,
      "collation": "binary"
    }
  ]
}
```

## Demo

The orders, latest day first; orders of one day keep their order by id, as the sort is stable over a sorted input:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "sort",
      "input": {"op": "scan", "table": "orders", "columns": [0, 3, 2]},
      "keys": [
        {
          "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          "desc": false,
          "nullsFirst": true,
          "collation": "binary"
        }
      ]
    },
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
        "desc": true,
        "nullsFirst": false,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "id"}, {"name": "day"}, {"name": "n"}]
}
```

| id | day | n |
|---|---|---|
| 5 | 2026-11-05 | 5 |
| 6 | 2026-11-05 | 1 |
| 4 | 2026-11-04 | 10 |
| 3 | 2026-11-03 | 2 |
| 1 | 2026-11-02 | 3 |
| 2 | 2026-11-02 | 1 |

## See also

- [`limit`](./limit): the first rows of a sort
- [`window`](./window), which orders each partition by sort keys
- [Order](../order), [collations](../collations)
- [Operations](./)
