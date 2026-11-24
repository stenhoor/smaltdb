---
description: 'Begins, commits or rolls back a transaction, or sets or releases a savepoint.'
---

# transaction

```railroad
transaction-statement
commit-note
```

Begins, commits or rolls back a transaction, or sets or releases a savepoint, as SQL's `BEGIN`, `COMMIT`,
`ROLLBACK`, `SAVEPOINT` and `RELEASE` do.

## Fields

| `action` | Fields | |
|---|---|---|
| `begin` | `mode`, and optional `author` and `message` | Begins a transaction. `mode` is `deferred` (take the write lock at the first write), `immediate` (take it now) or `exclusive`. |
| `commit` | optional `author` and `message` | Commits the transaction. |
| `rollback` | optional `savepoint` | Rolls the transaction back, or, with `savepoint`, back to that savepoint, which stays set. |
| `savepoint` | `name` | Sets a savepoint, beginning a transaction if none is open. |
| `release` | `name` | Releases the savepoint and the ones set after it, keeping what was done since. Releasing the savepoint that began the transaction commits it. |

## Result

No rows.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `commit` or `rollback` with no transaction open, `begin` inside one, or a savepoint that isn't set. |

## Notes

- **Commit notes.** `author` and `message` (text) describe the commit, given on `begin`, on `commit`, or both
  (`commit`'s win). A commit that changes something records them with its id and time in `smalt_commits` (`id`,
  `time` in milliseconds since 1970, `author`, `message`), which only the engine writes; tables that
  [keep history](../../engine/schema#history) are read as of those ids.
- A statement outside a transaction is its own: it commits by itself, with no author or message.
- The client's `db.transaction(fn, { author, message })` sends these statements around `fn`.

## Examples

A delete inside a transaction, rolled back. First the transaction begins and the orders are deleted:

```json
{"kind": "transaction", "action": "begin", "mode": "deferred"}
```

```json
{
  "kind": "write",
  "plan": {"op": "delete", "table": "orders", "db": "main", "input": {"op": "scan", "table": "orders", "columns": [-1]}, "rowid": 0}
}
```

Inside the transaction, they are gone:

```json
{
  "kind": "query",
  "plan": {"op": "aggregate", "input": {"op": "scan", "table": "orders", "columns": [0]}, "keys": [], "carry": [],
    "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}]},
  "columns": [{"name": "orders"}]
}
```

| orders |
|---|
| 0 |

Rolled back, they are all there again:

```json
{"kind": "transaction", "action": "rollback"}
```

```json
{
  "kind": "query",
  "plan": {"op": "aggregate", "input": {"op": "scan", "table": "orders", "columns": [0]}, "keys": [], "carry": [],
    "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}]},
  "columns": [{"name": "orders"}]
}
```

| orders |
|---|
| 6 |

With no transaction open, there is nothing to commit:

<!-- docs:error SMALT_ERROR -->
```json
{"kind": "transaction", "action": "commit"}
```

## Demo

A restock with a note, and a savepoint undone inside it. The price of every fruit goes up, the lime's is set to 0
after a savepoint, the savepoint is rolled back, and the transaction commits with its author and message:

```json
{"kind": "transaction", "action": "begin", "mode": "immediate", "author": "ada", "message": "new prices"}
```

```json
{
  "kind": "write",
  "plan": {
    "op": "update",
    "table": "fruit",
    "db": "main",
    "input": {"op": "scan", "table": "fruit", "columns": [-1, 3]},
    "rowid": 0,
    "sets": [{"column": 3, "value": {"k": "call", "fn": "add", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
      {"k": "lit", "value": 0.1, "type": "real"}
    ], "type": "real"}}],
    "from": false
  }
}
```

```json
{"kind": "transaction", "action": "savepoint", "name": "before_lime"}
```

```json
{
  "kind": "write",
  "plan": {
    "op": "update",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [-1, 1]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "lime", "type": "text"}
      ], "type": "bool"}
    },
    "rowid": 0,
    "sets": [{"column": 3, "value": {"k": "lit", "value": 0, "type": "real"}}],
    "from": false
  }
}
```

```json
{"kind": "transaction", "action": "rollback", "savepoint": "before_lime"}
```

```json
{"kind": "transaction", "action": "commit"}
```

```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "fruit", "columns": [1, 3]},
  "columns": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| apple | 0.6 |
| pear | 0.85 |
| plum | 1.35 |
| cherry | 3.1 |
| lime | 0.5 |

The commit's note, in the row of `smalt_commits` with the largest id:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "limit",
      "input": {
        "op": "sort",
        "input": {"op": "scan", "table": "smalt_commits", "columns": [0, 2, 3]},
        "keys": [{"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"}]
      },
      "count": {"k": "lit", "value": 1, "type": "int"}
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "text", "collation": "binary"}
    ]
  },
  "columns": [{"name": "author"}, {"name": "message"}]
}
```

| author | message |
|---|---|
| ada | new prices |

## See also

- [History](../../engine/schema#history): reading a table as of a commit
- [Statements](./)
