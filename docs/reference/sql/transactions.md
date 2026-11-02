# Transactions

Statements that group changes so they take effect together or not at all. For transactions through the client API (`db.transaction(…)`), concurrency between tabs and durability, see [Transactions](../../guide/transactions).

## Syntax

```text
BEGIN [DEFERRED | IMMEDIATE | EXCLUSIVE] [TRANSACTION [name]]
COMMIT [TRANSACTION [name]]
END [TRANSACTION [name]]
ROLLBACK [TRANSACTION [name]] [TO [SAVEPOINT] savepoint-name]
SAVEPOINT savepoint-name
RELEASE [SAVEPOINT] savepoint-name
```

## Autocommit

Outside an explicit transaction, every statement is its own transaction: it is committed when it finishes, or undone completely when it fails.

## BEGIN, COMMIT, ROLLBACK

`BEGIN` starts a transaction; changes are visible to the connection right away and become permanent at `COMMIT` (`END` is the same). `ROLLBACK` undoes everything since `BEGIN`. `DEFERRED`, `IMMEDIATE` and `EXCLUSIVE` are accepted for compatibility and behave the same. The optional transaction name is ignored.

```sql
CREATE TABLE account(id INTEGER PRIMARY KEY, balance INTEGER);
INSERT INTO account VALUES (1, 100), (2, 50);
BEGIN;
UPDATE account SET balance = balance - 30 WHERE id = 1;
UPDATE account SET balance = balance + 30 WHERE id = 2;
COMMIT;
SELECT * FROM account
```

| id | balance |
| --- | --- |
| 1 | 70 |
| 2 | 80 |

```sql
BEGIN;
DELETE FROM account;
ROLLBACK;
SELECT count(*) AS n FROM account
```

| n |
| --- |
| 2 |

DDL is transactional too: a `CREATE TABLE`, `ALTER TABLE` or `DROP` inside a rolled-back transaction is undone, including `CREATE TEMP TABLE`.

**Statement atomicity.** When a statement fails inside a transaction, only that statement's changes are undone; the transaction stays open with its earlier changes, as in SQLite.

```sql
BEGIN;
INSERT INTO account VALUES (3, 10);
```

<!-- docs:error SMALT_CONSTRAINT_PRIMARYKEY -->
```sql
INSERT INTO account VALUES (4, 1), (1, 1)
```

```sql
COMMIT;
SELECT id FROM account ORDER BY id
```

| id |
| --- |
| 1 |
| 2 |
| 3 |

Errors (`SMALT_ERROR`): `cannot start a transaction within a transaction`, `cannot commit - no transaction is active`, `cannot rollback - no transaction is active`.

**Deferred foreign keys.** Constraints declared `DEFERRABLE INITIALLY DEFERRED` are checked at `COMMIT`. If one is violated, `COMMIT` fails with `SMALT_CONSTRAINT_FOREIGNKEY` and the transaction stays open, so it can be fixed or rolled back, as in SQLite.

## SAVEPOINT, RELEASE, ROLLBACK TO

A savepoint marks a point inside a transaction that you can roll back to without ending the transaction.

- `SAVEPOINT name` sets a savepoint. Outside a transaction it also starts one, which `RELEASE` of that savepoint then commits.
- `ROLLBACK TO name` undoes the changes made after the savepoint. The savepoint stays, so it can be rolled back to again; savepoints set after it are removed.
- `RELEASE name` removes the savepoint and every savepoint set after it, keeping their changes.

Names are matched without regard to case, and the most recent savepoint with the name is used. An unknown name fails with `no such savepoint: name`.

```sql
BEGIN;
INSERT INTO account VALUES (10, 1);
SAVEPOINT before_bulk;
INSERT INTO account VALUES (11, 1), (12, 1);
ROLLBACK TO before_bulk;
RELEASE before_bulk;
COMMIT;
SELECT id FROM account WHERE id >= 10
```

| id |
| --- |
| 10 |

```sql
SAVEPOINT solo;
INSERT INTO account VALUES (20, 0);
RELEASE solo;
SELECT count(*) AS n FROM account WHERE id = 20
```

| n |
| --- |
| 1 |

## Settings inside transactions

`PRAGMA foreign_keys = …` has no effect inside a transaction, as in SQLite. See [PRAGMA](./pragmas#foreign-keys).
