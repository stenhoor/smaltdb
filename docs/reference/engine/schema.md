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
| `createTable` | `table` (a `TableDef`), `schema?`, `temp`, `ifNotExists`, `source?`, `rows?` (a query plan whose rows fill the new table, as SQL's `CREATE TABLE … AS SELECT`: one output column per table column, appended in the same statement, so a failure leaves no table; with `ifNotExists` and an existing table, nothing is appended) |
| `createIndex` | `index` (an `IndexDef`), `schema?`, `ifNotExists`, `source?` |
| `createView` | `name`, `schema?`, `temp`, `ifNotExists`, `columns?` (result column names), `materialized`, `options?` and `withData?` (materialized views), `source` |
| `createConnection` | `name`, `ifNotExists`, `options`, `source?` |
| `createExternalTable` | `name`, `ifNotExists`, `columns` (empty: read from the source), `options`, `source?` |
| `createPropertyGraph` | `graph` (a `PropertyGraphDef`: see [property graphs](#property-graphs)), `ifNotExists`, `source?` |
| `alterPropertyGraph` | `name`, `action` (`{ kind: 'addLabel', label, table? }`, `{ kind: 'addType', type, table? }` or `{ kind: 'addLabelIndex', table? }`: see [adding labels and types](#adding-labels-and-types) and [nodes with several labels](#nodes-with-several-labels)), `ifNotExists?` |
| `drop` | `objectType` (`table`, `index`, `view`, `materialized view`, `trigger`, `external table`, `connection`, `property graph`), `name`, `schema?`, `ifExists`, `cascade?` |
| `alterTable` | `table`, `schema?`, `action` (`renameTable`, `renameColumn`, `addColumn`, `dropColumn`), `source?`, `cascade?` |

A view is kept as its language's source, not as a plan: it is bound by its language where it is read (see
[writing a language](./languages#views)).

### View interfaces

A view keeps the columns it gave when it was made: its interface, which the [catalog](./catalog#tables-and-views)
shows ([ADR 0027](../../adr/0027-view-interfaces.md)). After `createTable`, `createView`, `drop` and `alterTable`, the
engine binds every view with an interface again and refuses the operation (rolling the statement back) when one:

- no longer binds: a table or view it reads was dropped, or shadowed by a TEMP one without its columns;
- gives fewer columns, or more for a view with a column list (a view over `*` keeps the columns it had: one added to
  the table doesn't reach it);
- gives a column whose type isn't the interface's and doesn't convert to it losslessly (`isLossless` in the
  [conversion table](./plans#conversions)): `schema change breaks the interface of view v: column n: int → real is not
  lossless`;
- gives a column that can be NULL where the interface's can't.

A rename of what a view reads holds: the view's text is edited, and its columns keep the interface's names. A
column whose type changed losslessly gives the interface's type: the engine converts it where it expands the view
(a plan's `scan` of the view), and `getView` gives the interface to a language that binds the view's text itself.

With `cascade: true`, a `drop` or `alterTable` drops the views whose interface it breaks instead of failing, and
then the views that dropping those breaks. It does so at once, inside a transaction too, and `run()` lists them in
its result as `cascaded` (in process; a client reads what is left from the catalog). Views made before interfaces are
not dropped.

Inside a transaction, the check waits for COMMIT, as deferred foreign keys do: changing a column's type rebuilds the
table (create a copy, drop the table, rename the copy), and the views are whole again only at the end. A COMMIT that
finds a broken interface fails and leaves the transaction open, to be rolled back. Materialized views have interfaces too, checked the same way;
a refresh converts and keeps their columns as a view's read does, so their stored rows keep the interface's types. A
view over external data that isn't loaded can't be bound when the check runs, and is not checked then. A view whose
language isn't registered in the database is not checked there (it can't be read there either), and views made before interfaces
reflect what they read, as before.

## Property graphs

A property graph ([ADR 0033](../../adr/0033-property-graphs-and-history.md)) is a catalog record over ordinary tables,
which every language can read and write as tables:

```ts
import type { plan } from 'smaltdb/engine';

const graph: plan.PropertyGraphDef = {
  name: 'social',
  nodes: [{ label: 'Person', table: 'person', id: 'id', props: 'props' }],
  edges: [{ type: 'KNOWS', table: 'knows', start: 'a', end: 'b' }],
};
const op: plan.SchemaOp = { op: 'createPropertyGraph', graph, ifNotExists: false };
```

- **Nodes:** one table per label, whose id column is its `INTEGER PRIMARY KEY`, and optionally a `props` column of
  type `map<text, …>` ([ADR 0038](../../adr/0038-map-type.md)) for properties that have no column of their own.
- **Relationships:** one table per type, with `INTEGER` `start` and `end` columns holding node ids, and optionally
  `props`.
- **Copies** (optional, `copy: true` on a node table): the label keeps its own row for each node that has it through
  the label index. See [per-label copies](#per-label-copies).
- **The label index** (optional, `labels: { table, node, label }`): a node's other labels, one row each, with an
  `INTEGER` node column and a `TEXT` label column. See [nodes with several labels](#nodes-with-several-labels).
- **Case** (optional, `caseSensitive`, default `true`): whether labels and types are case-sensitive. Set when the
  graph is created; see [case](#case).
- **Checks:** labels, types and tables are each listed once (labels and types as `caseSensitive` says, tables ignoring
  case); a table belongs to one graph. Tables must be row tables in
  `main`, not views, materialized views, external or columnar tables.
- **Names:** graphs have their own names, apart from tables'.
- **Protection:** while a graph exists, its tables can't be dropped or renamed, and the columns it names can't be
  dropped or renamed. Its other columns change as usual.
- **The file:** the first graph marks the database as needing property graphs, so an engine that doesn't know them
  refuses to open it ([storage format](../../STORAGE_FORMAT.md)). Dropping the graph keeps its tables.

The [catalog](./catalog) lists graphs with `graphs()` and `graph(name)`.

### The rules on a graph's tables

The engine keeps these on every write to a graph's tables, from any language (SQL, plans, DataFrames). Tables outside
a graph aren't affected.

- **Node ids are unique across the graph.** A node written without an id gets the next one: one more than the largest
  id in any of the graph's node tables. An id another node table of the graph has is refused, on insert and on update
  (`SMALT_CONSTRAINT_PRIMARYKEY`).
- **Relationships connect nodes of the graph.** An edge's `start` and `end` must be ids of nodes of the graph, of any
  label; NULL is refused (`SMALT_CONSTRAINT_FOREIGNKEY`).
- **A node with relationships can't be deleted**, nor its id changed, while a relationship refers to it, at either end
  (`SMALT_CONSTRAINT_FOREIGNKEY`). Delete the relationships first, as Cypher's `DETACH DELETE` does. Each row is
  checked when it's written, so a statement that deletes both must delete the relationships first. `INSERT OR REPLACE`
  of a connected node is refused, as its delete would be.
- **Lookups:** checking a node is a B+tree seek on each node table. Checking a node's relationships searches each edge
  table's `start` and `end`, so give edge tables indexes on both.

Errors from these rules keep the engine's wording in every language: they say which graph, table and node.

### The graph index

The engine keeps each property graph's relationships in memory, by node: a graph index
([ADR 0040](../../adr/0040-graph-index-and-relationships.md)). Where a plan reads an edge table by its start or its end
(`start = x`), the planner can answer from it instead of descending the endpoint index, and gives the same rows in the
same order. `EXPLAIN` shows it as `SEARCH <table> USING GRAPH INDEX (start=?)`. Nothing in a plan names it: joins,
[`paths`](./plans#paths) and the rules above use it where they would use the endpoint index, a `paths` that keeps
one path per node searches it directly, and [`relationships`](./plans#relationships), the graph's relationships as one
relation, reads a node's relationships of every type from it (`SEARCH RELATIONSHIPS OF <graph> (node=?)`).

- **What it needs:** an edge table with indexes on `(start, end)` and `(end, start)`, as the tables `addType` makes
  have. A table without them is read by a scan, or by whatever index it has.
- **Built on first use** from the endpoint indexes, and kept as rows are written, by any language. It is never written
  to the file, so opening a database costs nothing, and the first statement that reads a graph builds its index.
- **Dropped and built again** when a rollback undid a change to it (of a statement, a savepoint or a transaction), or
  when the graph's edge tables change.
- **Not held** for a graph with a node id or a relationship rowid outside 0 to 2^31 - 1, or that needs more memory
  than `graphIndexMem` ([options](../api/engine), 256 MiB by default; `0` turns graph indexes off). Its plans read the
  B+trees, with the same results.
- **Readers hold none:** a [parallel reader](../../ARCHITECTURE.md) reads the B+trees, and a statement that reads a
  graph index runs on the engine that writes.

### Adding labels and types

A language adds a label or relationship type the first time it writes one (ADR 0033, decision 11: Cypher's
`CREATE (:Gadget {…})` with no `Gadget` table yet) with `alterPropertyGraph`, in the same transaction as the write:

- **`addLabel`:** the label's table, named `table` or after the label, gets `id INTEGER PRIMARY KEY` and
  `props map<text, any>`.
- **Names are case-sensitive** by default: `Person` and `person` are two labels (or types), as in Cypher. Table names
  are not, so a label or type named like a table of the graph already gets the first free `<name>_<n>` (`person_2`).
  A graph created with `caseSensitive: false` ignores case instead: see below.
- **`addType`:** the type's table gets `start INTEGER`, `end INTEGER` and `props map<text, any>`, and indexes on
  `(start, end)` and on `(end, start)` (`<table>_start`, `<table>_end`), which the rules' lookups use. A hop from a
  node to the other end reads the index alone, not the table; with [the graph index](#the-graph-index), it reads
  neither.
- **An existing table** of that name is adopted instead, if it has the conventional columns (`id`, or `start` and
  `end`, and optionally `props`) and passes the checks a new graph's tables pass.
- **A label or type the graph has**, spelled the same, is an error, or a no-op with `ifNotExists`.
- The graph's record is replaced in the same transaction, and is then shown as its definition (JSON): its original
  source text no longer describes it.

### Nodes with several labels

A node's table gives its first label. The graph's label index gives it more (ADR 0033, decision 5): a table of
`(node, label)` rows, one for each other label. Add it with `alterPropertyGraph` and `{ kind: 'addLabelIndex' }`, or
name an existing table as `labels` when creating the graph:

- **The table:** `<graph>_labels` unless `table` names another, with `node INTEGER NOT NULL` and `label TEXT NOT NULL`,
  a unique index on `(label, node)` (`<table>_label`) that finds a label's nodes, and an index on `node`
  (`<table>_node`) that finds a node's labels. An existing table with those columns is adopted.
- **A label's nodes** are the rows of its table and the index's entries for it, for example in SQL
  `SELECT id FROM admin UNION SELECT node FROM g_labels WHERE label = 'Admin'`.

The engine keeps the index on every write, from any language:

- **An entry names a node of the graph** and one of the graph's labels, spelled exactly as the graph spells it (labels
  are case-sensitive), other than the label of the node's own table (`SMALT_CONSTRAINT_FOREIGNKEY`). A node has each
  label once (`SMALT_CONSTRAINT_UNIQUE`).
- **Entries belong to their node:** deleting the node deletes them, and changing its id changes theirs. `INSERT OR
  REPLACE` of a node deletes it first, so its entries go too.
- **A label in the index needs a place in the graph:** add it with `addLabel` first (its table holds the nodes whose
  first label it is).

### Case

Labels and relationship types are case-sensitive unless the graph is created with `caseSensitive: false`:

| | `caseSensitive: true` (the default) | `caseSensitive: false` |
|---|---|---|
| `Person` and `person` | two labels | one label: a graph can't list both, and adding one finds the other |
| A label index entry `person` | refused, unless the graph has a label spelled `person` | stored as `Person`, the graph's spelling |

The setting is kept with the graph and can't be changed: a graph with `Person` and `person` couldn't ignore case. Table
names ignore case either way.

### Per-label copies

A label marked `copy` (in the graph's `nodes`, or `addLabel` with `copy: true`) keeps its own row for each node that
has it through the label index (ADR 0033, decision 18), so the label's table lists all its nodes and a query reads one
table:

- **What the copy holds:** the node's id, and the columns the label's table shares with the node's table, by name. Its
  other columns get their defaults.
- **The engine keeps it:** it writes the copy when the entry is added, updates it when the node changes, moves it when
  the node's id or the entry changes, and deletes it with the entry or the node.
- **Only the engine writes copies:** changing or deleting one directly is refused (`SMALT_CONSTRAINT_FOREIGNKEY`);
  change the node, or delete its entry. A copy's id stays the node's: no other node can take it.
- **The label's own nodes** (rows whose first label it is) are ordinary rows of its table.
- **Cost:** each write to a node of a graph with copy labels looks up the node's labels, and writes each copy too.

## Tables

| `TableDef` | |
|---|---|
| `name` | The table's name |
| `columns` | `ColumnDef[]` |
| `keys` | PRIMARY KEY and UNIQUE constraints, `KeyDef[]` in declaration order |
| `checks` | CHECK constraints, `CheckDef[]` |
| `foreignKeys` | `ForeignKeyDef[]` |
| `storage` | `row` or `columnar` |
| `history` | Optional, `versions` or `log`: the table keeps its past versions, read with `asOf` on a scan. See [history](#history) |
| `exprLanguage` | Optional, for a table [defined without source text](#definitions-without-source-text): the language its expression texts are written in |

| `ColumnDef` | |
|---|---|
| `name` | The column's name |
| `declaredType` | The declared type as written, `''` when none |
| `type` | How values are stored: `INTEGER`, `BOOLEAN`, `DATE`, `DATETIME`, `TIME`, `DURATION`, `LIST`, `STRUCT`, `MAP`, `REAL`, `TEXT`, `BLOB`, `NUMERIC` or `ANY` (tables are strict). `BOOLEAN` holds 0 and 1, stored as an integer, and reads as `bool` ([ADR 0018](../../adr/0018-bool-and-nan.md)); writing anything else into it fails with `SMALT_CONSTRAINT_DATATYPE`. `DATE`, `DATETIME`, `TIME` and `DURATION` hold days and µs, stored as integers, and read as their plan types ([ADR 0019](../../adr/0019-dates-and-times.md)); a write takes an integer or the text results give. `LIST`, `STRUCT` and `MAP` hold lists, structs and maps, whose full type is the column's `declaredType` (`list<int>`, `struct<x real, y real>`, `map<text, any>`), and read as that type ([ADR 0020](../../adr/0020-lists-and-structs.md), [ADR 0038](../../adr/0038-map-type.md)); a write takes their bytes, or a JS array, object or `Map` |
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

<a id="history"></a>
### History

A table created with `history: 'versions'` or `history: 'log'` keeps its past versions ([ADR 0033](../../adr/0033-property-graphs-and-history.md),
step 6), and a plan reads it as it was after any commit, or at any time, with `asOf` on a `scan`
([plans](./plans)). It is set when the table is created, for row tables in `main`.

- **Versions are commits:** a version is valid from the commit that wrote it until the one that changed or deleted it.
  Changes within one transaction make one version: the states in between were never committed. A rolled-back
  transaction leaves no history.
- **Two methods**; `versions` is the default a language uses when its syntax names none (ADR 0033 step 7 measured
  both):
  - **`versions`:** two tables beside it, `smalt_since_<table>` (when each current row's version started) and
    `smalt_versions_<table>` (the earlier versions, with the commits they were valid between). Reading any past state
    costs about the same.
  - **`log`:** one table, `smalt_log_<table>`, with each change: its commit, the operation, the rowid and the row before
    it. A past state is the current rows unchanged since, and the row before each other row's first change since: the
    further back, the more of the log it reads. The same log will serve change tracking.
- **Written with the change:** in the same transaction. Only the engine writes these tables, and they are dropped with
  the table.
- **Times:** every commit that writes such a table is recorded in `smalt_commits` with its time, so `asOf` a time reads
  the last commit at or before it.
- **Cost:** the table and its current reads don't change. With `versions`, an insert writes one small row more, and an
  update or a delete the old version and one small row; with `log`, each change writes one log row. Tables without
  history pay nothing.
- **Forgetting** (ADR 0033, decision 16): history is kept until `{ kind: 'maintenance', action: 'forget', before }`
  drops what no read as of `before` or later needs (`before` is `{ commit }`, or `{ time }`: the last commit at or before
  it), for one `table` or every table that keeps history. Reading as of an earlier commit is then an error
  (`SMALT_RANGE`: history before that commit was forgotten). The horizon only moves forward, survives reopening and is
  part of the transaction.
- **Graphs:** a property graph with `history` keeps it for all its tables: each must keep history that way, and the
  tables it makes on first use (and its label index) are created with it.
- **`ALTER TABLE`:** its history follows the change. A renamed table keeps its history and horizon; an added column
  reads NULL in versions from before it (it didn't exist then); a renamed column keeps its past values; a dropped
  column's past values are dropped with it.
- **The file:** once a table keeps history, an engine that doesn't keep it refuses the file.

## Indexes

An `IndexDef` is `{ name, table, columns, unique, where? }`. Each column (`IndexColumnDef`) is a table column
(`column` ≥ 0) or an expression over the row (`column` -1 and `expr`), with `desc` and `collation`. `where` makes a
partial index.

```ts
import { Database, type plan } from 'smaltdb/engine';
import '@smaltworks/smaltql/register';

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

A column rename keeps the bound expressions right (they read columns by position), but the texts stay as written,
naming the old column, unless the definition names their language: with `exprLanguage`, a registered language's
`sourceEditor.renameColumnInExpr` edits the CHECK and index expression texts on a rename, so what is shown follows.
The catalog gives `exprLanguage` back with the table.

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
