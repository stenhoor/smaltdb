# Schema definitions

DDL reaches the engine as data: a statement `{ kind: 'schema', op }` whose `op` is a **schema operation** (`SchemaOp`).
The engine keeps every object's definition in this language-neutral form, stored in the database as versioned JSON, so
opening a database parses nothing ([storage format](../../STORAGE_FORMAT.md)).

An operation may carry its **source** (`{ language, text }`): the statement as its language wrote it. The engine
stores it beside the definition, for display (`sqlite_schema.sql`, `information_schema`), and asks that language to edit
it when ALTER TABLE changes the definition. Views need one; every other operation can leave it out (see
[definitions without source text](#definitions-without-source-text)).

## Operations

| `op` | Fields |
|---|---|
| `createTable` | `table` (a `TableDef`), `schema?`, `temp`, `ifNotExists`, `source?` |
| `createIndex` | `index` (an `IndexDef`), `schema?`, `ifNotExists`, `source?` |
| `createView` | `name`, `schema?`, `temp`, `ifNotExists`, `columns?` (result column names), `materialized`, `options?` and `withData?` (materialized views), `source` |
| `createConnection` | `name`, `ifNotExists`, `options`, `source?` |
| `createExternalTable` | `name`, `ifNotExists`, `columns` (empty: read from the source), `options`, `source?` |
| `drop` | `objectType` (`table`, `index`, `view`, `materialized view`, `trigger`, `external table`, `connection`), `name`, `schema?`, `ifExists` |
| `alterTable` | `table`, `schema?`, `action` (`renameTable`, `renameColumn`, `addColumn`, `dropColumn`), `source?` |

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
import 'smaltql/register';

const db = Database.openMemory();
db.exec('CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT, qty INT)');

// CREATE INDEX fruit_name ON fruit(name COLLATE NOCASE)
const index: plan.IndexDef = { name: 'fruit_name', table: 'fruit', unique: false, columns: [{ column: 1, desc: false, collation: 'nocase' }] };
db.preparePlan({ kind: 'schema', op: { op: 'createIndex', index, ifNotExists: false, source: { language: 'sql', text: 'CREATE INDEX fruit_name ON fruit(name COLLATE NOCASE)' } } }).run();
```

## Definitions without source text

Without `source`, the engine stores the definition alone. Where the source text would be shown (`sqlite_schema.sql`,
`information_schema`), it shows a neutral description instead: the definition as JSON, with each expression as its
`text`. The catalog's table has no `source`. ALTER TABLE changes the definition and describes it again, without asking
any language; other objects' source texts are still edited by their own languages (a SQL view over the table follows a
renamed column).

Such a definition's expressions must be bound (`expr` on every CHECK, DEFAULT and index expression): there is no text to
bind them from later, so the validator refuses an expression without one, and so does ALTER TABLE ADD COLUMN on such a
table. Each expression's `text` is kept for display.

```ts
import { Database, plan } from 'smaltdb/engine';

const db = Database.openMemory();
const table: plan.TableDef = {
  name: 'stock',
  columns: [
    { name: 'id', declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' },
    { name: 'qty', declaredType: 'INTEGER', type: 'INTEGER', notNull: true, collation: 'binary', default: { text: '0', expr: plan.lit(0), value: 0 } },
  ],
  keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }] }],
  checks: [{ text: 'qty >= 0', expr: plan.call('cmp_ge', [plan.col(0, 1, 'int'), plan.lit(0)], 'int') }],
  foreignKeys: [],
  storage: 'row',
};
db.preparePlan({ kind: 'schema', op: { op: 'createTable', table, temp: false, ifNotExists: false } }).run();
```

## Sources and languages

The engine reads an object's source only through the language it names. A table created with a source in a language
the engine does not have works, and shows its source as given; ALTER TABLE on it fails until that language is
registered, since only the language can edit its text. Views and materialized views need their language wherever they
are read or refreshed.
