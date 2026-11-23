---
description: 'The rows of a table, a materialized view or a view: the columns it lists, by position.'
---

# scan

```railroad
scan
```

The rows of a table, a materialized view or a view: the columns it lists, by position. `-1` is the rowid.

## Fields

| Field | Type | |
|---|---|---|
| `table` | string | The table's name. A view's name reads the view: its query, bound by its language when the plan is compiled ([views](../../engine/languages#views)). |
| `columns` | integers | The table's columns to read, by position from 0, in the order they are given; `-1` is the rowid. A column may be listed more than once. |
| `db` | `"main"` or `"temp"` | Optional: the schema. Without it, a TEMP table of that name is read before a main one. |
| `indexedBy` | string or `null` | Optional: the index the planner must use (SQL's `INDEXED BY`), or `null` for none (`NOT INDEXED`). |
| `asOf` | [as-of](#as-of) | Optional: read the table as it was after a commit. The table must [keep history](../../engine/schema#history). |

## Output

One column for each of `columns`, in that order, with the table column's type and collation.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The table doesn't exist, it has no such column, an `asOf` table keeps no history, or `asOf` reads a TEMP table. |
| `SMALT_RANGE` | `asOf` reads a commit older than the table's history keeps (it was [forgotten](../statements#maintenance)). |

## Notes

- Rows come in no promised order. A plan that needs one sorts ([order](../order)).
- The planner picks how to read: the whole table, or an index that answers a filter or a sort above the scan.

### as-of {#as-of}

```railroad
as-of
```

`{"commit": …}` reads the table as it was after that commit (its id in `smalt_commits`); `{"time": …}` after the last
commit at or before that time, in milliseconds since 1970. The expression reads no columns. Before the table's first
commit, it is empty.

## Examples

A table's columns in another order, with its rowid:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "fruit", "columns": [-1, 4, 1]},
  "columns": [{"name": "rowid"}, {"name": "qty"}, {"name": "name"}]
}
```

| rowid | qty | name |
|---|---|---|
| 1 | 10 | apple |
| 2 | 4 | pear |
| 3 | NULL | plum |
| 4 | 25 | cherry |
| 5 | 0 | lime |

Without `columns` in the statement, the result's columns are named `column1`, `column2`, …:

```json
{"op": "scan", "table": "orders", "columns": [3, 2]}
```

| column1 | column2 |
|---|---|
| 2026-11-02 | 3 |
| 2026-11-02 | 1 |
| 2026-11-03 | 2 |
| 2026-11-04 | 10 |
| 2026-11-05 | 5 |
| 2026-11-05 | 1 |

A table that doesn't exist:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "scan", "table": "fruits", "columns": [0]}
```

## Demo

The fruit and their prices, cheapest first:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| lime | 0.4 |
| apple | 0.5 |
| pear | 0.75 |
| plum | 1.25 |
| cherry | 3 |

## See also

- [`values`](./values), [`source`](./source): rows that are not a table's
- [`filter`](./filter), [`project`](./project)
- [Operations](./)
