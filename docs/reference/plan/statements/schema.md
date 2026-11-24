---
description: 'A schema operation: creates, changes or drops a table, an index, a view, a graph and the rest.'
---

# schema

```railroad
schema-statement
```

A schema operation: creates, changes or drops a table, an index, a view, a connection, an external table or a
property graph. The operation is described in full on [schema definitions](../../engine/schema); the grammar here
leaves it as an object.

## Fields

| Field | Type | |
|---|---|---|
| `op` | object | A schema operation: its own `op` is `createTable`, `createIndex`, `createView`, `createConnection`, `createExternalTable`, `createPropertyGraph`, `alterPropertyGraph`, `drop` or `alterTable`. |

## Result

No rows. `changes` is 0. A `drop` or `alterTable` with `cascade` lists the views it dropped as `cascaded` (in
process).

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The operation is not valid: an unknown `op`, a field missing or of the wrong kind, a column that doesn't exist. The engine validates a schema operation given as data before it runs it. |
| `SMALT_ERROR` | It can't be done: a table that exists already (without `ifNotExists`), one to drop that doesn't exist (without `ifExists`). |

## Notes

- A schema operation may carry its `source`, the statement as its language wrote it, which the engine keeps for
  display. A view needs one; the others can leave it out ([definitions without source text](../../engine/schema#definitions-without-source-text)).
- An object made by a schema statement is there for the statements after it, in the same transaction too.

## Examples

A table with an integer primary key and a text column compared without case:

```json
{
  "kind": "schema",
  "op": {
    "op": "createTable",
    "temp": false,
    "ifNotExists": false,
    "table": {
      "name": "shelf",
      "storage": "row",
      "columns": [
        {"name": "id", "declaredType": "INTEGER", "type": "INTEGER", "notNull": false, "collation": "binary"},
        {"name": "label", "declaredType": "TEXT", "type": "TEXT", "notNull": true, "collation": "nocase"}
      ],
      "keys": [{"kind": "primaryKey", "columns": [{"column": 0, "desc": false, "collation": "binary"}]}],
      "checks": [],
      "foreignKeys": []
    }
  }
}
```

It is there, empty, for the plans after it:

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "shelf", "columns": [0, 1]},
  "columns": [{"name": "id"}, {"name": "label"}]
}
```

| id | label |
|---|---|

An operation the engine doesn't know:

<!-- docs:error SMALT_PLAN -->
```json
{"kind": "schema", "op": {"op": "createShelf", "name": "shelf"}}
```

A table that doesn't exist, dropped without `ifExists`:

<!-- docs:error SMALT_ERROR -->
```json
{"kind": "schema", "op": {"op": "drop", "objectType": "table", "name": "cupboard", "ifExists": false}}
```

## Demo

An index on the fruit's colour. With five rows the planner would rather read the whole table, so the scan names the
index (`indexedBy`), and the lookup searches it:

```json
{
  "kind": "schema",
  "op": {
    "op": "createIndex",
    "ifNotExists": false,
    "index": {"name": "fruit_color", "table": "fruit", "columns": [{"column": 2, "desc": false, "collation": "binary"}], "unique": false}
  }
}
```

```json
{
  "kind": "explain",
  "mode": "plan",
  "query": {
    "kind": "query",
    "plan": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2], "indexedBy": "fruit_color"},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "red", "type": "text"}
      ], "type": "bool"}
    }
  }
}
```

| id | parent | notused | detail |
|---|---|---|---|
| 1 | 0 | 0 | SEARCH fruit USING INDEX fruit_color (=?) |

## See also

- [Schema definitions](../../engine/schema): every schema operation and its fields
- [Statements](./)
