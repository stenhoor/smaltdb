# Writing a language

A language turns its source text into [plans](./plans) and gives the engine what it needs of the objects written in
it. The engine never reads a language's syntax: it holds a view as `{ language, text }` and asks that language to bind
it. SQL is a language in this sense ([smaltql](https://github.com/stenhoor/smaltql)); a dataframe library is another.

A language reaches the engine only through `smaltdb/language`: the language interface, the plan types, values and
collations, type and affinity conversion, the function registry and catalog lookups. It declares smaltdb as a peer
dependency, so an application has one engine.

## Running statements

A language's statements run as plans: it binds them itself and runs the result with
[`preparePlan` / `queryPlan`](./running), in-process or through the client. The text API (`db.query(text)`,
`db.exec`, `db.prepare`) is SQL's: it hands its text to the language named `sql`.

## Registering

`registerLanguage(language)` (from `smaltdb/engine` or `smaltdb/language`) makes a language available, by its name, to
every database in the engine. That is what lets the engine keep objects written in it:

- views and materialized views whose source is in the language, bound by it where they are read or refreshed;
- tables whose source is in it, whose text it edits when ALTER TABLE changes them;
- DEFAULT and CHECK expressions it could not bind when a table was made, bound from their text where first used.

## The interface

A language is a `SmaltLanguage`:

| Member | |
|---|---|
| `name` | The name sources record (`sql`). |
| `parse(text)`, `parseOne(text)` | Text as statements (`LanguageStatement`), a script or exactly one. Throws the language's syntax error. The engine calls them for the text API, so only the `sql` language's are used. |
| `bindView(source, ctx)` | A view's or materialized view's query (its source), bound against the catalog: a `{ kind: 'query', plan, columns }`. |
| `viewReferences(source)` | The tables and views a view's query names, directly, read from its source without binding (a view may name tables that do not exist yet). The engine follows them for dependencies, TEMP checks and refresh order. |
| `viewDefinition(source)` | The text of a view's query alone, for `information_schema.views`. |
| `bindStoredExprs(table, ctx)` | The CHECK and DEFAULT expressions a stored table holds unbound, bound from its source. |
| `sourceEditor` | Edits the source texts kept beside definitions when ALTER TABLE renames a table or a column, adds or drops a column, and writes an external table's statement once its columns are known. |

A `LanguageStatement` (from `parse`) is `{ text, paramCount, paramNames, bind(ctx), externalCalls?() }`: `bind` gives a
bound statement, the `PlanStatementInput` forms of [running plans](./running#statements) with the engine's column
descriptions. The engine binds a statement again when the schema changes.

`ctx` is the `BindContext`, the catalog as a language sees it: `getTable(name, schema?)` (a table's columns, types,
collations, keys), `getView`, `writeTarget` and `indexTarget` (which throw for objects that may not be written or
indexed), external tables and table functions, virtual tables (`information_schema.*`), and `funcCtx` for function
lookups.

## Views

A view stays in its language: `bindView` binds it where it is read, so a view follows later changes to the tables it
reads. Two limits apply today:

- The plan `bindView` returns must be in the shape the planner reads: a projection over the query's core, as SQL builds
  it (see [plan shapes](./plans#plan-shapes)). The engine rearranges plans given to `preparePlan` and `queryPlan`, but
  not yet those of views.
- SQL reads views written in SQL only. A view in another language is read through a materialized view, whose rows the
  engine fills by binding it with its language.

An example: a language whose whole syntax is `table.column`, meaning that column of that table.

```ts
import { Collation, Database, plan as p, registerLanguage, type SmaltLanguage } from 'smaltdb/engine';

const unchanged = (text: string): string => text;
const dotted: SmaltLanguage = {
  name: 'dotted',
  parse: () => {
    throw new Error('dotted statements run as plans');
  },
  parseOne: () => {
    throw new Error('dotted statements run as plans');
  },
  bindView(source, ctx) {
    const [table, column] = source.text.split('.');
    const index = ctx.getTable(table)!.columns.findIndex((c) => c.name === column);
    return { kind: 'query', plan: p.project(p.scan(table, [index]), [p.col(0, 0, 'any')]), columns: [{ name: column, type: 'any', collation: Collation.Binary, affinity: 'NONE' }] };
  },
  viewReferences: (source) => [{ name: source.text.split('.')[0] }],
  viewDefinition: (source) => source.text,
  bindStoredExprs: () => ({ checks: [], defaults: [] }),
  sourceEditor: { renameTable: unchanged, renameColumn: unchanged, renameColumnInExpr: unchanged, addColumn: unchanged, dropColumn: unchanged, externalTable: () => '' },
};
registerLanguage(dotted);

const db = Database.openMemory();
db.exec("CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO fruit(name) VALUES ('apple'), ('pear')");
db.preparePlan({ kind: 'schema', op: { op: 'createView', name: 'names', temp: false, ifNotExists: false, materialized: true, source: { language: 'dotted', text: 'fruit.name' } } }).run();
db.exec("INSERT INTO fruit(name) VALUES ('plum'); REFRESH MATERIALIZED VIEW names");
console.log(db.query('SELECT * FROM names ORDER BY 1').rows); // [['apple'], ['pear'], ['plum']]
```

## Workers

In a page, the engine runs in a worker, and the languages and plugins it uses are registered there. A worker entry
does that with `defineWorker` from `smaltdb/worker-runtime`; the engine's parallel readers run the same entry, so they
get the same:

<!-- docs:skip -->
```ts
import { defineWorker } from 'smaltdb/worker-runtime';
import io from '@smaltdb/io';
import { dotted } from './dotted.js';

defineWorker({ languages: [dotted], plugins: [io] });
```

and the page opens a database with that worker:

```ts
import { open } from 'smaltdb';

const db = await open('app', { worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }) });
```

A language usually exports both: its worker entry and an `open()` that uses it, as smaltql does
(`import { open } from 'smaltql'`).
