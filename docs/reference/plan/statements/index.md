---
description: 'The plan statements: what queryPlan and preparePlan take, one kind on each page.'
---

# Statements

A plan statement is what `queryPlan` and `preparePlan` take ([running plans](../../engine/running)): a JSON object
whose `kind` says what it does, or an operation by itself, which is a [query](./query).

```railroad
statement
```

Rules every statement follows:

- **One statement at a time.** `queryPlan` runs one statement and gives its result: `{ columns, columnTypes, rows }`,
  and for a write also `changes`, `lastInsertRowid` and `graph`.
- **Validated first.** The engine validates a statement's plan, or its schema operation, before it plans it, and
  refuses one that breaks a rule with `SMALT_PLAN`, naming the path of the part at fault.
- **Its own transaction.** A statement outside a [transaction](./transaction) commits by itself; one that fails
  leaves nothing.
- **Parameters** are given when it runs, by position ([`param`](../expressions/param)).

## Kinds of statement {#kinds}

- [`query`](./query): A plan whose rows are the result, with its result columns described.
- [`write`](./write): A plan that writes: an append, update or delete, or a write of a property graph.
- [`explain`](./explain): The plan the engine picked for a query, or that plan with the counts of a run.
- [`transaction`](./transaction): Begins, commits or rolls back a transaction, or sets or releases a savepoint.
- [`setting`](./setting): Reads a setting, or sets it, as SQL's PRAGMA.
- [`maintenance`](./maintenance): Gathers statistics, forgets history, or refreshes a materialized view.
- [`schema`](./schema): A schema operation: creates, changes or drops a table, an index, a view, a graph and the rest.
