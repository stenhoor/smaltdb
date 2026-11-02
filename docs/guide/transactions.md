# Transactions

A transaction groups statements so that they take effect together or not at all. smaltdb has one writer per database and snapshot reads; this page covers `db.transaction()`, transactions in SQL, savepoints, what happens when a statement fails, and how transactions behave across tabs. The statements themselves are in the [SQL reference](../reference/sql/transactions).

## Autocommit

Outside an explicit transaction, every statement is its own transaction: it commits when it succeeds and changes nothing when it fails. A multi-row `INSERT` or an `UPDATE` of many rows is all or nothing.

```sql
CREATE TABLE accounts(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, balance INTEGER NOT NULL CHECK (balance >= 0));
INSERT INTO accounts(owner, balance) VALUES ('ann', 100), ('bob', 20);
```

<!-- docs:error SMALT_CONSTRAINT_CHECK -->
```sql
UPDATE accounts SET balance = balance - 50;
```

The update fails on bob's row, so ann's row is not changed either:

```sql
SELECT owner, balance FROM accounts;
```

| owner | balance |
|---|---|
| ann | 100 |
| bob | 20 |

## db.transaction()

`db.transaction(fn)` runs `fn` inside `BEGIN … COMMIT`. If `fn` throws (or returns a rejected promise), the transaction is rolled back and the error is passed on. The promise resolves to what `fn` returns.

```ts
async function transfer(from: number, to: number, amount: number): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.exec('UPDATE accounts SET balance = balance - ? WHERE id = ?', [amount, from]);
    await tx.exec('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount, to]);
    const [row] = await tx.query<{ balance: number }>('SELECT balance FROM accounts WHERE id = ?', [from]);
    return row.balance; // committed; the promise resolves to this
  });
}
```

If the first `UPDATE` violates the `CHECK` constraint, `tx.exec` rejects, `fn` throws, and nothing is changed.

The `tx` argument is the only way into the transaction. Its methods have the same signatures as on `Database` and `PreparedStatement`:

| Method | Meaning |
|---|---|
| `tx.query(sql, params?, options?)` | Run a query inside the transaction. |
| `tx.exec(sql, params?, options?)` | Run statements inside the transaction. |
| `tx.stream(sql, params?, options?)` | Stream a query's result inside the transaction. |
| `tx.statement(stmt)` | Use a prepared statement inside the transaction: the result has `query`, `stream` and `run`. |

After the callback has finished, the methods of `tx` (and of statements from `tx.statement`) reject with `SMALT_MISUSE`.

### What waits for a transaction

While the callback runs, every other call on the same `Database` waits until the transaction has ended, then runs on its own. This covers `db.query`, `db.exec`, `db.stream`, `db.prepare`, `db.transaction`, the import and export methods, `db.close`, and `query`, `stream` and `run` of a `PreparedStatement`. Code elsewhere in your app therefore never lands inside your transaction by accident, and is not rolled back with it.

::: warning Do not await `db` methods inside the callback
Inside `fn`, use `tx`. Awaiting `db.query(…)`, `db.exec(…)` or a prepared statement's `run(…)` there never resolves: the call waits for the transaction, which waits for your callback. Nested `db.transaction()` calls hang the same way; use a [savepoint](#savepoints) instead. The client cannot tell such a call from one made elsewhere in your app (JavaScript has no portable way to know which callback a call comes from), so it cannot fail it instead.
:::

To use a prepared statement in the transaction, prepare it before, and run it through `tx.statement()`:

```ts
const insert = await db.prepare('INSERT INTO accounts(owner, balance) VALUES (?, ?)');
await db.transaction(async (tx) => {
  const ins = tx.statement(insert);
  for (const [owner, balance] of [['cy', 5], ['di', 7]] as const) await ins.run([owner, balance]);
});
await insert.finalize();
```

While a stream is open, writes from this tab fail with `SMALT_BUSY`, also through `tx` (see [transactions and open streams](#transactions-and-open-streams)): read a `tx.stream()` to the end, or leave its loop, before the next write.

### Rules for the callback

- Do not run `BEGIN`, `COMMIT` or `ROLLBACK` through `tx`. If the callback does end the transaction: after a `COMMIT`, the work stays committed and `db.transaction()` resolves to the callback's result; after a `ROLLBACK`, nothing is committed and `db.transaction()` rejects with `SMALT_ERROR` ("the transaction was rolled back inside the transaction callback"). Statements run through `tx` after that point run outside any transaction.
- `db.transaction()` fails with `SMALT_ERROR` ("cannot start a transaction within a transaction") if a transaction started with SQL `BEGIN` is still open.
- A failed statement inside the callback does not end the transaction by itself (see [below](#when-a-statement-fails)). If you catch its error and carry on, the transaction commits with the statements that succeeded.

## Transactions in SQL

`BEGIN`, `COMMIT` and `ROLLBACK` work as in SQLite. From JavaScript, send them with `db.exec()`; everything between them on the same `Database` is part of the transaction.

```sql
BEGIN;
UPDATE accounts SET balance = balance - 30 WHERE owner = 'ann';
UPDATE accounts SET balance = balance + 30 WHERE owner = 'bob';
COMMIT;
SELECT owner, balance FROM accounts;
```

| owner | balance |
|---|---|
| ann | 70 |
| bob | 50 |

`ROLLBACK` undoes everything since `BEGIN`, including schema changes:

```sql
BEGIN;
DELETE FROM accounts;
CREATE TABLE audit(note TEXT);
ROLLBACK;
SELECT count(*) AS n, (SELECT count(*) FROM sqlite_schema WHERE name = 'audit') AS audit_tables FROM accounts;
```

| n | audit_tables |
|---|---|
| 2 | 0 |

`BEGIN DEFERRED`, `BEGIN IMMEDIATE` and `BEGIN EXCLUSIVE` are accepted and behave like `BEGIN`: there is only one writer, so a transaction never has to wait for a lock while it runs.

Starting a transaction inside another one, or committing when none is open, is an error:

<!-- docs:error SMALT_ERROR -->
```sql
COMMIT;
```

::: tip Prefer db.transaction()
A transaction opened with SQL `BEGIN` stays open until your code sends `COMMIT` or `ROLLBACK`. If an exception skips that, the transaction stays open and blocks other tabs. `db.transaction()` always ends it.
:::

## When a statement fails

A statement that fails inside a transaction is undone on its own, as in autocommit mode; the transaction stays open with the earlier statements in place. You decide whether to roll back or go on.

```sql
BEGIN;
INSERT INTO accounts(owner, balance) VALUES ('cy', 10);
```

<!-- docs:error SMALT_CONSTRAINT_NOTNULL -->
```sql
INSERT INTO accounts(owner, balance) VALUES (NULL, 5);
```

```sql
COMMIT;
SELECT owner, balance FROM accounts ORDER BY id;
```

| owner | balance |
|---|---|
| ann | 70 |
| bob | 50 |
| cy | 10 |

`db.transaction()` turns any error thrown out of the callback into a rollback, so a failing `tx.exec` that you do not catch rolls back the whole transaction.

## Savepoints

A savepoint marks a point inside a transaction that you can roll back to without abandoning the whole transaction.

| Statement | Effect |
|---|---|
| `SAVEPOINT name` | Mark a point. Outside a transaction, it also starts one. |
| `ROLLBACK TO name` | Undo everything after the savepoint. The savepoint stays, and the transaction stays open. |
| `RELEASE name` | Forget the savepoint (and any later ones), keeping the changes. Releasing the savepoint that started the transaction commits it. |

```sql
BEGIN;
UPDATE accounts SET balance = balance + 1 WHERE owner = 'ann';
SAVEPOINT bonus;
UPDATE accounts SET balance = balance + 1000 WHERE owner = 'ann';
ROLLBACK TO bonus;
RELEASE bonus;
COMMIT;
SELECT owner, balance FROM accounts WHERE owner = 'ann';
```

| owner | balance |
|---|---|
| ann | 71 |

Savepoints give `db.transaction()` callbacks a way to try a step and undo only that step:

```ts
await db.transaction(async (tx) => {
  await tx.exec("UPDATE accounts SET balance = balance - 10 WHERE owner = 'ann'");
  await tx.exec('SAVEPOINT optional_step');
  try {
    await tx.exec("INSERT INTO accounts(owner, balance) VALUES ('ann-savings', 10)");
    await tx.exec('RELEASE optional_step');
  } catch {
    await tx.exec('ROLLBACK TO optional_step');
    await tx.exec('RELEASE optional_step');
  }
});
```

Savepoint names are not case-sensitive. Rolling back to a name that does not exist fails with `SMALT_ERROR` ("no such savepoint").

## Isolation

There is one writer. Inside a transaction you see your own uncommitted changes. Other tabs never see them: their requests wait until the transaction ends (see below). [Parallel readers](./databases#parallel-readers) read a snapshot of the latest commit and never see uncommitted changes.

## Multiple tabs

With [multi-tab access](./databases#multi-tab-access), a transaction belongs to the tab that opened it:

- While it is open, other tabs' requests wait until it commits or rolls back. Keep transactions short, and never wait for user input inside one.
- If the tab closes while its transaction is open, the transaction is rolled back and the other tabs continue.
- If the tab that owns the engine worker closes during your transaction, your requests in flight fail with `SMALT_RETRY` and the transaction is gone. Run the whole transaction again.

## Transactions and open streams

An open [stream](./queries#streaming) served by the owning engine worker blocks writes. A write from the same tab fails with `SMALT_BUSY` until the stream is finished or closed; writes from other tabs wait. Read a result to the end, or `break` out of the loop, before writing.
