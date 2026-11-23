---
description: 'Functions of the database''s state: changes made, the last rowid, the engine''s version, history.'
---

# Database state functions

Functions that read the database and its connection rather than their arguments: the rows the writes changed, the
last rowid inserted, the engine's version, and the horizon of a table's history. Most take no arguments and are never
NULL. Their values depend on what ran before (`changes`, `total_changes`, `last_insert_rowid`), on the release
(`smaltdb_version`) or on the table's history (`history_horizon`).
Inside a write statement, the counts and the rowid are those from before it.

## Functions {#functions}

- [`changes`](./changes): The number of rows the last write statement inserted, updated or deleted.
- [`total_changes`](./total_changes): The number of rows inserted, updated or deleted since the database was opened.
- [`last_insert_rowid`](./last_insert_rowid): The rowid of the last row inserted.
- [`smaltdb_version`](./smaltdb_version): The version of the smaltdb engine, as text.
- [`history_horizon`](./history_horizon): A commit, checked against a table's forgotten history: an error when it is before the table's horizon.
