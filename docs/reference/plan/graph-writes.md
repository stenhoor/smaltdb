---
description: 'The rules the graph writes share: the graph they need, ids, new labels and types, what a statement did, and the order a plan that writes a graph runs in.'
---

# Writing a property graph

[`graphCreate`](./operations/graphCreate), [`graphSet`](./operations/graphSet),
[`graphDelete`](./operations/graphDelete) and [`graphMerge`](./operations/graphMerge) write a
[property graph](../engine/schema#property-graphs) ([ADR 0042](../../adr/0042-graph-writes.md), section 1). Each
passes its input's rows on, so a write can sit in the middle of a plan and the plan can read on from it; a plan that
holds one is a [write statement](./statements#write)'s. They write the graph's tables through the tables' writers, as
an `append`, an `update` or a `delete` of them does, so the graph's rules, foreign keys, history and
[the graph's index](../engine/schema#the-graph-index) are kept, and a statement that fails leaves nothing.

## The rules they share

- **The graph** must be laid out for it: a node table with a properties column, where new nodes go and where
  `graphSet` and `graphDelete` find a node by its id, and a [label index](../engine/schema#nodes-with-several-labels).
  A graph without them is refused. The [sample graph](./sample-data#the-graph-social) `social` is laid out so.
- **Ids.** A new node's id is one more than the largest the graph's node tables have had, and a new relationship's
  rowid one more than the largest its relationship tables have had, as far as the connection knows: in the tables, in
  their past versions where they [keep history](../engine/schema#history), and given by an earlier statement of the
  connection, whether that statement ended, failed or was rolled back.
- **A label or a relationship type the graph has not** is added to it, as `alterPropertyGraph` adds one, when a row
  first needs it, inside the statement's transaction. A statement that fails adds none, and neither does one no row
  of which reaches the write. `tables` names the table made for one (`{"label", "table"}` or `{"type", "table"}`),
  which must not exist; a plan may read a table it names, which has the columns the engine gives it (a label's `id`
  and `props`; a type's `start`, `end` and `props`).
- **Values keep their kind** in a node's or a relationship's properties, which are a `map<text, any>`: a truth value,
  a list or a map given as a property is one there ([ADR 0039](../../adr/0039-typed-values-under-any.md)), whether it
  is an item's `value` or a value of a map of that type (`map<text, bool>`). A NULL value in a map of properties sets
  no key.
- **What a statement did** comes with its result as `graph`: `nodesCreated`, `nodesDeleted`, `relationshipsCreated`,
  `relationshipsDeleted`, `propertiesSet` (keys set or removed, counted for each write that names one, whether or not
  it changed the value), `labelsAdded` and `labelsRemoved`. `changes` is their sum.

```railroad
new-node
new-relationship
graph-end
new-table
set-item
relationship-ref
delete-target
```

## Example

Two new people, one node each, and the rows the write passes on: each input row, then its new node's id.

```json
{
  "kind": "write",
  "plan": {
    "op": "graphCreate",
    "graph": "social",
    "input": {"op": "values", "types": ["text"], "rows": [[{"k": "lit", "value": "Barbara", "type": "text"}], [{"k": "lit", "value": "Donald", "type": "text"}]]},
    "nodes": [{"labels": ["Person"], "props": {"k": "call", "fn": "map_of", "args": [
      {"k": "lit", "value": "name", "type": "text"},
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}
    ], "type": "map<text, any>"}}],
    "relationships": []
  },
  "returning": [{"name": "name"}, {"name": "id"}]
}
```

| name | id |
|---|---|
| Barbara | 4 |
| Donald | 5 |

Its result's `graph` counts 2 nodes created, 2 labels added and 2 properties set, and `changes` is 6.

## The order a plan that writes a graph runs in {#order}

A write handles its input's rows in order, each before the next is read, and what a row's expressions read of the
graph is the graph as it is then: a property set from itself counts up over rows that name one node, and a
`graphMerge` finds what it made for an earlier row.

- **Below a write,** a part of the plan that writes nothing is read to its end before anything above it runs, so no
  scan is open on a table while it is written. One exception: operations at the top of such a part that read the
  graph for each row (a `filter`, `project`, `explode` or `unpivot` with a nested plan; `paths`) run when each row's
  turn comes, so they read what the rows before it wrote. An [`eager`](./operations/eager) has everything below it
  done first, whatever it reads.
- **Above a write,** `filter`, `project`, `explode`, `unpivot`, `paths` and a `join` whose left input is the one that
  writes pass each row on as it is written, through every operation above before the next row is written. `sort`,
  `aggregate`, `distinct`, `window`, `sample` and `pivot` read all the rows first. A `limit` stops the write below it
  once it has its rows.
- **All a write's rows at once.** Where no row could tell the difference, the engine writes a write's rows together,
  a pass over each table, and runs the operations above over all of them: when nothing above the write, up to an
  operation that reads all its rows, reads the graph, writes or stops early, and what the write computes reads only
  its row. The rows and the graph are what row by row gives. A statement that would fail for more than one reason may
  report another of them.
- **Refused** (`SMALT_UNSUPPORTED`): a write in a plan nested in an expression or in a `graphMerge`'s `match`, on the
  right of a join or on both sides of one, under a `right`, `full` or `asof` join, under a `limit` counted from the
  end, under a `setop` or an `iterate`, and as the input of an `append`, an `update` or a `delete`.

## See also

- [Property graphs](../engine/schema#property-graphs): the tables a graph is made of, and the rules the engine keeps
  on them
- [`relationships`](./operations/relationships), [`paths`](./operations/paths): reading a graph
