---
description: 'The tables and the property graph the plan language''s examples run on.'
---

# Sample data

Every example on the plan language pages runs on this data, in an in-memory database of its own for each page. A
page's statements run in order, so a write is seen by the examples after it. The data is made by plan statements too:
[`sample.json`](https://github.com/stenhoor/smaltdb/blob/main/docs/reference/plan/sample.json), schema operations and
writes, run one after another.

## fruit

| Position | Column | Type |
|---|---|---|
| 0 | `id` | `int`, the primary key |
| 1 | `name` | `text` |
| 2 | `color` | `text` |
| 3 | `price` | `real` |
| 4 | `qty` | `int` |

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "fruit", "columns": [0, 1, 2, 3, 4]},
  "columns": [{"name": "id"}, {"name": "name"}, {"name": "color"}, {"name": "price"}, {"name": "qty"}]
}
```

| id | name | color | price | qty |
|---|---|---|---|---|
| 1 | apple | red | 0.5 | 10 |
| 2 | pear | green | 0.75 | 4 |
| 3 | plum | purple | 1.25 | NULL |
| 4 | cherry | red | 3 | 25 |
| 5 | lime | green | 0.4 | 0 |

## orders

| Position | Column | Type |
|---|---|---|
| 0 | `id` | `int`, the primary key |
| 1 | `fruit` | `int`: a fruit's `id` |
| 2 | `n` | `int` |
| 3 | `day` | `date` |

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "orders", "columns": [0, 1, 2, 3]},
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}, {"name": "day"}]
}
```

| id | fruit | n | day |
|---|---|---|---|
| 1 | 1 | 3 | 2026-11-02 |
| 2 | 2 | 1 | 2026-11-02 |
| 3 | 1 | 2 | 2026-11-03 |
| 4 | 4 | 10 | 2026-11-04 |
| 5 | 3 | 5 | 2026-11-05 |
| 6 | 1 | 1 | 2026-11-05 |

## baskets

| Position | Column | Type |
|---|---|---|
| 0 | `id` | `int`, the primary key |
| 1 | `owner` | `text` |
| 2 | `items` | `list<text>` |
| 3 | `counts` | `list<int>` |

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
  "columns": [{"name": "id"}, {"name": "owner"}, {"name": "items"}, {"name": "counts"}]
}
```

| id | owner | items | counts |
|---|---|---|---|
| 1 | Ada | ["apple","pear"] | [2,1] |
| 2 | Alan | ["plum"] | [6] |
| 3 | Grace | [] | [] |
| 4 | Edsger | NULL | NULL |

## The graph social

A [property graph](../engine/schema#property-graphs) over these tables:

| Table | Columns | |
|---|---|---|
| `node` | `id int`, `props map<text, any>` | Every node, with its properties: the graph's node table (label `Node`) |
| `social_labels` | `node int`, `label text` | The label index: each node's labels |
| `person` | `id int`, `props map<text, any>` | The table of the label `Person` |
| `knows` | `start int`, `end int`, `props map<text, any>` | The relationships of type `KNOWS`, with indexes on `(start, end)` and `(end, start)` |

Four people, each a node labelled `Person`:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "node", "columns": [0, 1]},
  "columns": [{"name": "id"}, {"name": "props"}]
}
```

| id | props |
|---|---|
| 0 | {"born":1815,"name":"Ada"} |
| 1 | {"born":1912,"name":"Alan"} |
| 2 | {"born":1906,"name":"Grace"} |
| 3 | {"born":1930,"name":"Edsger"} |

and who knows whom, since when:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "knows", "columns": [-1, 0, 1, 2]},
  "columns": [{"name": "rowid"}, {"name": "start"}, {"name": "end"}, {"name": "props"}]
}
```

| rowid | start | end | props |
|---|---|---|---|
| 0 | 0 | 1 | {"since":1936} |
| 1 | 1 | 2 | {"since":1944} |
| 2 | 1 | 3 | {"since":1950} |
| 3 | 2 | 3 | {"since":1960} |
