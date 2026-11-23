---
description: 'Columns turned into rows: one row per input row and column, with the column''s name.'
---

# unpivot

```railroad
unpivot
```

Columns turned into rows: each input row gives one row for each of `columns`, holding the `keep` columns, the
column's name and its value.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to unpivot. |
| `keep` | integers | The input columns every output row holds, by position. May be empty. |
| `columns` | integers | The input columns whose values become rows, in order. At least one. |
| `names` | strings | The name each of `columns` gives its rows: one per column. |
| `type` | [type](../types) | The type of the value column. |

## Output

The `keep` columns, then the column's name (`text`), then its value (`type`).

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `columns` is empty, a column is not one of the input's, or `names` doesn't have one name per column. |

## Notes

- Rows come in the input's order, and each input row's in the order of `columns`.
- A NULL value gives a row too. To leave it out, filter on the value column.
- The values are not converted: `type` is the type the plan states for the column, so give one every value has (or
  `any`).

## Examples

Each fruit's price and stock as rows:

```json
{
  "kind": "query",
  "plan": {
    "op": "unpivot",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
    "keep": [0],
    "columns": [1, 2],
    "names": ["price", "qty"],
    "type": "real"
  },
  "columns": [{"name": "name"}, {"name": "measure"}, {"name": "value"}]
}
```

| name | measure | value |
|---|---|---|
| apple | price | 0.5 |
| apple | qty | 10 |
| pear | price | 0.75 |
| pear | qty | 4 |
| plum | price | 1.25 |
| plum | qty | NULL |
| cherry | price | 3 |
| cherry | qty | 25 |
| lime | price | 0.4 |
| lime | qty | 0 |

Two columns and one name:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "unpivot",
  "input": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
  "keep": [0],
  "columns": [1, 2],
  "names": ["price"],
  "type": "real"
}
```

## Demo

The fruit whose name or colour is longer than five letters, and which it is:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {
      "op": "unpivot",
      "input": {"op": "scan", "table": "fruit", "columns": [0, 1, 2]},
      "keep": [0],
      "columns": [1, 2],
      "names": ["name", "color"],
      "type": "text"
    },
    "pred": {
      "k": "call",
      "fn": "cmp_gt",
      "args": [
        {"k": "call", "fn": "length", "args": [{"k": "col", "input": 0, "index": 2, "depth": 0, "type": "text", "collation": "binary"}], "type": "int"},
        {"k": "lit", "value": 5, "type": "int"}
      ],
      "type": "bool"
    }
  },
  "columns": [{"name": "id"}, {"name": "which"}, {"name": "text"}]
}
```

| id | which | text |
|---|---|---|
| 3 | color | purple |
| 4 | name | cherry |

## See also

- [`pivot`](./pivot): values turned into columns
- [`explode`](./explode): a list's elements as rows
- [Operations](./)
