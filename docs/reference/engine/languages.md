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

A language is a `SmaltLanguage`. Besides its `name`, it provides the parts it uses: text it binds (`parse`,
`parseOne`), the objects it stores (`bindView`, `viewReferences`, `viewDefinition`, `bindTableExprs`, `sourceEditor`),
and words for errors (`errorMessage`). A language that writes no text has no parser; one whose views are its own
serialized source, not text it parses, provides the stored-object part alone. Using a part a language lacks is a
`SMALT_MISUSE` error that names both (`the dotted language does not edit its objects' source text`).

| Member | |
|---|---|
| `name` | The name sources record (`sql`). |
| `parse(text)`, `parseOne(text)` | Text as statements (`LanguageStatement`), a script or exactly one. Throws the language's syntax error. The engine calls them for the text API, so only the `sql` language's are used. |
| `bindView(source, ctx)` | A view's or materialized view's query (its source), bound against the catalog: a `{ kind: 'query', plan, columns }`. |
| `viewReferences(source)` | The tables and views a view's query names, directly, read from its source without binding (a view may name tables that do not exist yet). The engine follows them for dependencies, TEMP checks and refresh order. |
| `viewDefinition(source)` | The text of a view's query alone, for `information_schema.views`. |
| `bindTableExprs(table, ctx)` | The CHECK and DEFAULT expressions a stored table holds unbound, bound from its source (`table` as [the catalog](./catalog) describes it, its text in `table.source`). Needed only by a language whose tables keep expressions unbound. |
| `errorMessage(error)` | Optional. The message for an error a statement written in the language raised, from its `code`, the engine's `message` and its [fields](../api/errors) (`constraint`, `table`, `columns`, `name`, `origin`): undefined keeps the engine's message. Each language words errors for its users; SQL's wording is SQLite's. |
| `sourceEditor` | Edits the source texts kept beside definitions when ALTER TABLE renames a table or a column, adds or drops a column, and writes an external table's statement once its columns are known. ALTER TABLE edits every object's text, each with its own language's editor. Objects [defined without source text](./schema#definitions-without-source-text) need none. |

A `LanguageStatement` (from `parse`) is `{ text, paramCount, paramNames, bind(ctx), externalCalls?() }`: `bind` gives a
bound statement, the `PlanStatementInput` forms of [running plans](./running#statements) with the engine's column
descriptions. The engine binds a statement again when the schema changes.

`ctx` is the `BindContext`, the catalog as a language sees it:

- `table(name, schema?)`: a table, materialized view or system table as [the catalog](./catalog) describes it;
  `writeTable` and `indexTable` give the table a statement writes or indexes, and throw for objects that may not be
  written or indexed.
- `getView`, external tables and table functions, and virtual tables (`information_schema.*`).
- `catalog`: [the catalog](./catalog), with function metadata and the engine's help for building plans.

`smaltdb/language` also has `describeTableDef(def, source?)`, a table definition described as the catalog will
describe the table it makes, and `comparisonRule(a, b)`: for two operands' types and [meaning
fields](./plans#expressions), the collation a comparison of them uses and the conversion (`affinity_numeric`,
`affinity_text`) to apply to each side first, as the engine reads `carries` and `affinity`.

## Views

A view stays in its language: `bindView` binds it where it is read, so a view follows later changes to the tables it
reads. A plan reads a view as it reads a table, with `scan` naming it: the engine binds the view with its language when
it compiles the plan (again after the schema changes), and the columns `scan` lists are the view's. A view has no
rowid (`-1`).

- SQL reads views written in SQL only, since it reads a view by parsing its text. A view in another language is read by
  plans, or through a materialized view, whose rows the engine fills by binding it with its language.
- The plan `bindView` returns for a materialized view must be in the shape the planner reads: a projection over the
  query's core, as SQL builds it (see [plan shapes](./plans#plan-shapes)). Views read by `scan` are rearranged as plans
  given to `preparePlan` are.

An example: a language whose whole syntax is `table.column`, meaning that column of that table. It parses no
statements and edits no text: it provides views alone.

```ts
import { Collation, Database, plan as p, registerLanguage, type SmaltLanguage } from 'smaltdb/engine';
import 'smaltql/register';

const dotted: SmaltLanguage = {
  name: 'dotted',
  bindView(source, ctx) {
    const [table, column] = source.text.split('.');
    const index = ctx.table(table)!.columns.findIndex((c) => c.name === column);
    return { kind: 'query', plan: p.project(p.scan(table, [index]), [p.col(0, 0, 'any')]), columns: [{ name: column, type: 'any', collation: Collation.Binary, affinity: 'NONE' }] };
  },
  viewReferences: (source) => [{ name: source.text.split('.')[0] }],
  viewDefinition: (source) => source.text,
};
registerLanguage(dotted);

const db = Database.openMemory();
db.exec("CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO fruit(name) VALUES ('apple'), ('pear')");
const view = (name: string, materialized: boolean) => ({ op: 'createView' as const, name, temp: false, ifNotExists: false, materialized, source: { language: 'dotted', text: 'fruit.name' } });
// A view, read by a plan.
db.preparePlan({ kind: 'schema', op: view('names', false) }).run();
console.log(db.queryPlan(p.scan('names', [0])).rows); // [['apple'], ['pear']]
// A materialized view, which SQL reads too.
db.preparePlan({ kind: 'schema', op: view('stored_names', true) }).run();
db.exec("INSERT INTO fruit(name) VALUES ('plum'); REFRESH MATERIALIZED VIEW stored_names");
console.log(db.query('SELECT * FROM stored_names ORDER BY 1').rows); // [['apple'], ['pear'], ['plum']]
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
