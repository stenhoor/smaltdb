# Errors

When a call fails, its promise rejects with a `SmaltdbError`. This page shows how to catch errors, which ones are worth retrying, and how errors interact with transactions. The [error code reference](../reference/api/errors) lists every code with its causes.

## SmaltdbError

```ts
import { SmaltdbError } from 'smaltdb';

try {
  await db.exec('INSERT INTO users(email) VALUES (?)', ['ann@example.com']);
} catch (e) {
  if (e instanceof SmaltdbError && e.code === 'SMALT_CONSTRAINT_UNIQUE') {
    console.log('That email is already registered.');
  } else {
    throw e;
  }
}
```

| Property | Meaning |
|---|---|
| `code` | A stable string such as `SMALT_CONSTRAINT_UNIQUE`. Branch on this. |
| `message` | A description for developers, such as `UNIQUE constraint failed: users.email`. The wording may change between versions. |
| `name` | `'SmaltdbError'` |

Codes follow SQLite's result code names where one fits (`SMALT_BUSY`, `SMALT_CORRUPT`), with constraint failures split by kind (`SMALT_CONSTRAINT_NOTNULL`, `…_UNIQUE`, `…_PRIMARYKEY`, `…_CHECK`, `…_FOREIGNKEY`, `…_DATATYPE`).

The in-process engine (`smaltdb/engine`) throws `SmaltError`, which has the same `code` and `message`; see the [engine API](../reference/api/engine#errors).

A value that cannot be sent to the engine worker at all, such as a function among the parameters, makes the call reject with the browser's own `DataCloneError` instead.

## Kinds of errors

Most errors point at the SQL or the data, and running the same call again gives the same error:

| Codes | Cause | What to do |
|---|---|---|
| `SMALT_SYNTAX`, `SMALT_ERROR`, `SMALT_UNSUPPORTED` | The SQL is wrong or uses something smaltdb lacks | Fix the SQL |
| `SMALT_CONSTRAINT_*` | The data breaks a constraint | Show the user, change the data, or use an upsert |
| `SMALT_MISMATCH`, `SMALT_RANGE` | Wrong parameter types, counts or ranges | Fix the calling code |
| `SMALT_MISUSE` | A closed database, a finalized statement, a `tx` handle used after its callback | Fix the calling code |
| `SMALT_PLUGIN_MISSING` | The call needs a [plugin](./plugins) the engine does not have, such as `@smaltdb/io` for `read_csv` | Install the plugin and add it to the engine |

Some errors depend on timing and can succeed later:

| Code | Cause | What to do |
|---|---|---|
| `SMALT_RETRY` | With multi-tab access, the tab that owned the database closed during the call | Retry (see [below](#retrying)) |
| `SMALT_BUSY` | Your own open stream blocks a write, or another tab holds the file | End the stream; or close the other database, or turn on multi-tab access |
| `SMALT_EXTERNAL` | Reading [external data](./external-data) failed | Often a network problem: retry later |
| `SMALT_INTERRUPT` | You cancelled the call | Nothing |

And some mean the environment or the file is broken: `SMALT_WORKER`, `SMALT_CANTOPEN`, `SMALT_NOTADB`, `SMALT_FORMAT`, `SMALT_CORRUPT`, `SMALT_INTERNAL`. See the [reference](../reference/api/errors) for each.

## Errors in SQL

A statement that fails changes nothing, also when it would have changed many rows:

```sql
CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
INSERT INTO users(email) VALUES ('ann@example.com');
```

<!-- docs:error SMALT_CONSTRAINT_UNIQUE -->
```sql
INSERT INTO users(email) VALUES ('bob@example.com'), ('ann@example.com');
```

```sql
SELECT email FROM users;
```

| email |
|---|
| ann@example.com |

Many constraint errors can be avoided in SQL. `INSERT OR IGNORE` and `ON CONFLICT … DO NOTHING` skip rows that would break a uniqueness constraint; `ON CONFLICT … DO UPDATE` updates the existing row instead:

```sql
INSERT INTO users(email) VALUES ('bob@example.com'), ('ann@example.com')
  ON CONFLICT(email) DO NOTHING;
SELECT email FROM users ORDER BY id;
```

| email |
|---|
| ann@example.com |
| bob@example.com |

See [INSERT](../reference/sql/insert) for upserts.

## Errors and transactions

- A failed statement inside a transaction is undone by itself; the transaction stays open. See [when a statement fails](./transactions#when-a-statement-fails).
- `db.transaction()` rolls back when its callback throws, so an uncaught error from `tx.exec` undoes the whole transaction and reaches your `catch`.
- If the callback runs `ROLLBACK` itself, `db.transaction()` rejects with `SMALT_ERROR`, so the caller learns that nothing was committed.
- If a transaction opened with SQL `BEGIN` fails halfway, send `ROLLBACK` yourself; otherwise it stays open.

## Retrying

`SMALT_RETRY` happens only with [multi-tab access](./databases#multi-tab-access), when the tab that owned the database closes while your call is in flight. Another tab takes over, and the call can be sent again. A write that was in flight may already have committed before the owner closed, so retried writes should be safe to repeat: use an upsert, a unique key, or a transaction that checks first.

A prepared statement made before the change of owner also fails with `SMALT_RETRY`; prepare it again.

A small helper:

```ts
import { SmaltdbError } from 'smaltdb';

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof SmaltdbError) || e.code !== 'SMALT_RETRY' || i >= attempts) throw e;
    }
  }
}

await withRetry(() =>
  db.transaction(async (tx) => {
    await tx.exec('INSERT INTO users(email) VALUES (?) ON CONFLICT(email) DO NOTHING', ['cy@example.com']);
  }),
);
```

Retry a whole `db.transaction()` call, not single statements inside it: after a change of owner, the transaction is gone.

`SMALT_BUSY` from a write during your own [stream](./queries#streaming) is not worth retrying in a loop: the write can only run once the stream is finished or closed, which your code controls. `SMALT_BUSY` at `open()` means another engine worker has the file; see [multi-tab access](./databases#multi-tab-access).

## Cancelled calls

Calls cancelled with an `AbortSignal` reject with `SMALT_INTERRUPT`. Check for it to tell a cancellation from a failure:

```ts
import { SmaltdbError } from 'smaltdb';

async function search(term: string, signal: AbortSignal) {
  try {
    return await db.query('SELECT id, title FROM notes WHERE title LIKE ?', [`%${term}%`], { signal });
  } catch (e) {
    if (e instanceof SmaltdbError && e.code === 'SMALT_INTERRUPT') return null; // superseded by a newer search
    throw e;
  }
}
```

See [cancellation](./queries#cancellation) for when a running statement can be stopped.
