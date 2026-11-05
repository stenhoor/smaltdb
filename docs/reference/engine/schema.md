# Schema definitions

DDL reaches the engine as data: a statement `{ kind: 'schema', op }` whose `op` is a **schema operation** (`SchemaOp`).
The engine keeps every object's definition in this language-neutral form, stored in the database as versioned JSON, so
opening a database parses nothing ([storage format](../../STORAGE_FORMAT.md)).

Each operation also carries its **source** (`{ language, text }`): the statement as its language wrote it. The engine
stores it beside the definition, for display (`sqlite_schema.sql`, `information_schema`), and asks that language to edit
it when ALTER TABLE changes the definition.

## Operations

| `op` | Fields |
|---|---|
| `createTable` | `table` (a `TableDef`), `schema?`, `temp`, `ifNotExists`, `source` |
| `createIndex` | `index` (an `IndexDef`), `schema?`, `ifNotExists`, `source` |
| `createView` | `name`, `schema?`, `temp`, `ifNotExists`, `columns?` (result column names), `materialized`, `options?` and `withData?` (materialized views), `source` |
| `createConnection` | `name`, `ifNotExists`, `options`, `source` |
| `createExternalTable` | `name`, `ifNotExists`, `columns` (empty: read from the source), `options`, `source` |
| `drop` | `objectType` (`table`, `index`, `view`, `materialized view`, `trigger`, `external table`, `connection`), `name`, `schema?`, `ifExists` |
| `alterTable` | `table`, `schema?`, `action` (`renameTable`, `renameColumn`, `addColumn`, `dropColumn`), `source` |

A view is kept as its language's source, not as a plan: it is bound by its language where it is read, so it follows
later changes to the tables it reads (see [writing a language](./languages#views)).

## Tables

| `TableDef` | |
|---|---|
| `name` | The table's name |
| `columns` | `ColumnDef[]` |
| `keys` | PRIMARY KEY and UNIQUE constraints, `KeyDef[]` in declaration order |
| `checks` | CHECK constraints, `CheckDef[]` |
| `foreignKeys` | `ForeignKeyDef[]` |
| `storage` | `row` or `columnar` |

| `ColumnDef` | |
|---|---|
| `name` | The column's name |
| `declaredType` | The declared type as written, `''` when none |
| `type` | How values are stored: `INTEGER`, `REAL`, `TEXT`, `BLOB`, `NUMERIC` or `ANY` (tables are strict) |
| `notNull`, `notNullConflict?` | NOT NULL, and its conflict action |
| `collation` | `binary`, `nocase` or `rtrim` |
| `default?` | A `DefaultDef`: `{ text, expr?, value }`, an expression over no columns and its value when constant |

A key (`KeyDef`) is `{ kind: 'primaryKey' | 'unique', columns, name?, onConflict?, autoincrement? }`, its columns
`{ column, desc, collation }` by column index. A single-column INTEGER primary key is the table's rowid. A foreign key
(`ForeignKeyDef`) is `{ columns, table, refColumns?, onDelete, onUpdate, deferrable, isDeferrable, name? }`, the
actions `SET NULL`, `SET DEFAULT`, `CASCADE`, `RESTRICT` or `NO ACTION`.

Expressions in definitions (`ExprDef`: `{ text, expr? }`) are plan expressions with their source text. A CHECK or an
index expression reads the table's row: column `i` is `col(0, i, …)`, the rowid `col(0, n, …)` where `n` is the number
of columns. `expr` may be absent when it could not be bound when the definition was made (a DEFAULT naming a function
that does not exist yet): the table's language binds it from `text` where it is first used.

## Indexes

An `IndexDef` is `{ name, table, columns, unique, where? }`. Each column (`IndexColumnDef`) is a table column
(`column` ≥ 0) or an expression over the row (`column` -1 and `expr`), with `desc` and `collation`. `where` makes a
partial index.

```ts
import { Database, type plan } from 'smaltdb/engine';

const db = Database.openMemory();
db.exec('CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT, qty INT)');

// CREATE INDEX fruit_name ON fruit(name COLLATE NOCASE)
const index: plan.IndexDef = { name: 'fruit_name', table: 'fruit', unique: false, columns: [{ column: 1, desc: false, collation: 'nocase' }] };
db.preparePlan({ kind: 'schema', op: { op: 'createIndex', index, ifNotExists: false, source: { language: 'sql', text: 'CREATE INDEX fruit_name ON fruit(name COLLATE NOCASE)' } } }).run();
```

## Sources and languages

The engine reads an object's source only through the language it names. A table created with a source in a language
the engine does not have works, and shows its source as given; ALTER TABLE on it fails until that language is
registered, since only the language can edit its text. Views and materialized views need their language wherever they
are read or refreshed.
