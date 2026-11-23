# Writing a language

A language turns its source text into [plans](../plan/) and gives the engine what it needs of the objects written in
it. The engine never reads a language's syntax: it holds a view as `{ language, text }` and asks that language to bind
it. SQL is a language in this sense ([smaltql](https://github.com/stenhoor/smaltql)); a dataframe library is another.

A language reaches the engine only through `smaltdb/language`: the language interface, the plan types, values and
collations, type and affinity conversion, the function registry and catalog lookups. It declares smaltdb as a peer
dependency, so an application has one engine.

## Running statements

A language's statements run in one of two ways:

- **As plans.** The language binds a statement itself and runs the result with
  [`preparePlan` / `queryPlan`](./running), in-process or through the client.
- **As text.** A registered language that parses text is named to the engine's text methods:
  `db.query(text, params, { language: 'tiny' })`, and the same option on `run`, `exec`, `prepare`, `queryAsync`,
  `runAsync` and `execAsync`. The engine asks the language to parse the text and to bind the statement, and keeps
  what it binds to ([statements the engine keeps](#statements-the-engine-keeps)). Without the option the text is
  SQL's: it goes to the language named `sql`. This is the in-process engine (`smaltdb/engine`): the client and the
  worker take SQL and plans.

## Registering

`registerLanguage(language)` (from `smaltdb/engine` or `smaltdb/language`) makes a language available, by its name, to
every database in the engine. That is what lets the engine keep objects written in it:

- views and materialized views whose source is in the language, bound by it where they are read or refreshed;
- tables whose source is in it, whose text it edits when ALTER TABLE changes them;
- DEFAULT and CHECK expressions it could not bind when a table was made, bound from their text where first used.

## The interface

A language is a `SmaltLanguage`. Besides its `name`, it provides the parts it uses: text it binds (`parse`,
`parseOne`), the objects it stores (`bindView`, `viewReferences`, `viewDefinition`, `bindTableExprs`, `sourceEditor`),
words for errors (`errorMessage`), and how it binds parameters (`parameter`). A language that writes no text has no parser; one whose views are its own
serialized source, not text it parses, provides the stored-object part alone. Using a part a language lacks is a
`SMALT_MISUSE` error that names both (`the dotted language does not edit its objects' source text`).

| Member | |
|---|---|
| `name` | The name sources record (`sql`). |
| `parse(text)`, `parseOne(text)` | Text as statements (`LanguageStatement`), a script or exactly one. Throws the language's syntax error. The engine calls them for text given to its text methods in the language's name (`{ language }`), and SQL's for text given without one. |
| `plans` | `'data'`: the language's statements bind to plan data, a `PlanStatementInput` as [`preparePlan`](./running#statements) takes one, which the engine validates and puts in its own terms as it does there. Left out by a language whose binder gives the engine's own terms, as SQL's does. |
| `bindView(source, ctx)` | A view's or materialized view's query (its source), bound against the catalog: a `{ kind: 'query', plan, columns }`. |
| `viewReferences(source)` | The tables and views a view's query names, directly, read from its source without binding (a view may name tables that do not exist yet). The engine follows them for dependencies, TEMP checks and refresh order. |
| `viewDefinition(source)` | The text of a view's query alone, for `information_schema.views`. |
| `bindTableExprs(table, ctx)` | The CHECK and DEFAULT expressions a stored table holds unbound, bound from its source (`table` as [the catalog](./catalog) describes it, its text in `table.source`). Needed only by a language whose tables keep expressions unbound. |
| `errorMessage(error)` | Optional. The message for an error a statement written in the language raised, from its `code`, the engine's `message` and its [fields](../api/errors) (`constraint`, `table`, `columns`, `name`, `origin`): undefined keeps the engine's message. Each language words errors for its users; SQL's wording is SQLite's. |
| `sourceEditor` | Edits the source texts kept beside definitions when ALTER TABLE renames a table or a column, adds or drops a column, and writes an external table's statement once its columns are known. ALTER TABLE edits every object's text, each with its own language's editor. Objects [defined without source text](./schema#definitions-without-source-text) need none. |
| `parameter(value)` | Optional. A parameter of one of the language's statements as the language means it, after the engine's own conversions (booleans to 1 / 0, bigints checked). The engine keeps NaN, a value of `real` ([ADR 0018](../../adr/0018-bool-and-nan.md)); SQL gives it as NULL, as SQLite binds it. Without the hook, a language statement's NaN parameters are NULL for now; plans' parameters keep NaN. |

A `LanguageStatement` (from `parse`) is `{ text, paramCount, paramNames, bind(ctx, params?), variant?(params), shape?,
externalCalls?() }`: `bind` gives a bound statement, the `PlanStatementInput` forms of
[running plans](./running#statements) with the engine's column descriptions, or, from a language whose `plans` is
`'data'`, those forms as `preparePlan` takes them. The engine binds a statement again when the schema changes.
`paramNames` gives the parameters that have names, each by the name as written and its position from 1; a statement
runs with its values by position or by name. Where the language's `plans` is `'data'`, a parameter the plan reads as
a list, a struct or a map takes a JS array, an object or a `Map`, as [a plan's](./running#parameters) does; any other
language's parameters are scalars.

`ctx` is the `BindContext`, the catalog as a language sees it:

- `table(name, schema?)`: a table, materialized view or system table as [the catalog](./catalog) describes it;
  `writeTable` and `indexTable` give the table a statement writes or indexes, and throw for objects that may not be
  written or indexed.
- `getView`, external tables and table functions, and virtual tables (`information_schema.*`).
- `catalog`: [the catalog](./catalog), with function metadata and the engine's help for building plans.

`smaltdb/language` also has `describeTableDef(def, source?)`, a table definition described as the catalog will
describe the table it makes, and `comparisonRule(a, b)`: for two operands' types and [meaning
fields](../plan/meaning-fields), the collation a comparison of them uses and the conversion (`affinity_numeric`,
`affinity_text`) to apply to each side first, as the engine reads `carries` and `affinity`.

## Statements the engine keeps

`query` and `run` keep a language's statements as they keep SQL's, so a statement that comes again is not bound
again ([ADR 0042](../../adr/0042-graph-writes.md), section 4). A statement is found in three ways:

- **By its text.** The same text in the same language is parsed and bound once. Each language has its own
  `statementCacheSize` texts.
- **By its shape.** A language may take the values written in a statement out of it and give the statement a `shape`,
  `{ hash, values, same(other) }`. `values` are the values taken out: the plan the statement binds to reads them as
  the parameters after the statement's own, `param(paramCount)` on. `hash` is a number that statements of one shape
  share, and `same(other)` says whether another statement of the language with that hash has this shape. The engine
  binds the first statement of a shape. A later one is parsed, which is where its shape comes from, and not bound: it
  runs what the first bound to, with its own values. What the shape of a statement is, is the language's to say;
  statements of one shape must bind to the same plan, and have as many parameters and as many values taken out
  (`SMALT_MISUSE` otherwise). A database keeps four times `statementCacheSize` shapes, the oldest going first;
  statements already made for a shape that has gone still run.
- **By the variant of its values.** A statement may bind differently for different values: a language that compares
  a parameter as a value of its kind binds a comparison with a text and one with a number differently. Such a
  statement has `variant(params)`, a key that is the same for values it binds the same for. The engine calls
  `bind(ctx, params)` once for each key and runs what it gave for every run whose values have that key (16 keys a
  statement, the oldest going first). A statement without `variant` is bound once, without values.

A statement of a shape may have variants too: what is kept for the shape is bound once for each key.

A prepared statement (`db.prepare(text, { language })`) is found by its shape as well, and binds by its values'
variant when it runs. What it says of itself (`columns`, `readonly`) is what the variant it ran last says, and what
`bind(ctx)` gives without values where there is none: before its first run, and after the schema changes until it
runs again. A variant is bound with the values of the run that needs it, and again after the schema changes with the
values of the run then at hand.

A language whose syntax is `find <table> <id>`, with the id taken out:

```ts
import { Database, plan as p, registerLanguage, type LanguageStatement, type SmaltLanguage } from 'smaltdb/engine';
import '@smaltworks/smaltql/register';

function statement(text: string): LanguageStatement & { table: string } {
  const [, table, id] = text.split(' ');
  return {
    text,
    table,
    paramCount: 0,
    paramNames: new Map(),
    // The id is the first parameter after the statement's own, of which it has none.
    shape: { hash: table.length, values: [Number(id)], same: (other) => (other as { table?: string }).table === table },
    bind: (ctx) => ({
      kind: 'query',
      plan: p.filter(p.scan(ctx.table(table)!.name, [0, 1]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.param(0, 'int')], 'bool')),
      columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }],
    }),
  };
}
const tiny: SmaltLanguage = { name: 'tiny', plans: 'data', parseOne: statement, parse: (text) => [statement(text)] };
registerLanguage(tiny);

const db = Database.openMemory();
db.exec("CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO fruit(name) VALUES ('apple'), ('pear')");
console.log(db.query('find fruit 2', undefined, { language: 'tiny' }).rows); // [[2, 'pear']], bound
console.log(db.query('find fruit 1', undefined, { language: 'tiny' }).rows); // [[1, 'apple']], not bound again
```

## Views

A view stays in its language: `bindView` binds it where it is read. A view made since
[ADR 0027](../../adr/0027-view-interfaces.md) keeps its interface, the columns it gave when it was made, and the
engine refuses schema changes that would break it ([view interfaces](./schema#view-interfaces)). A plan reads a view
as it reads a table, with `scan` naming it: the engine binds the view with its language when
it compiles the plan (again after the schema changes), and the columns `scan` lists are the view's. A view has no
rowid (`-1`).

- A language that reads a view by binding its text itself (as SQL does) gets the view's `interface` from `getView`.
  When `getView` also gives `reshaped`, the view's query no longer gives exactly its interface: a column's type
  changed losslessly, or a view over `*` gained a column. The language then reads only the interface's columns, each
  converted to the interface's type with `conversion(now, interface)` from `smaltdb/language` (a call to its `fn`).
- SQL reads views written in SQL only, since it reads a view by parsing its text. A view in another language is read by
  plans, or through a materialized view, whose rows the engine fills by binding it with its language.
- The plan `bindView` returns for a materialized view must be in the shape the planner reads: a projection over the
  query's core, as SQL builds it (see [plan shapes](../plan/shapes)). Views read by `scan` are rearranged as plans
  given to `preparePlan` are.

An example: a language whose whole syntax is `table.column`, meaning that column of that table. It parses no
statements and edits no text: it provides views alone.

```ts
import { Collation, Database, plan as p, registerLanguage, type SmaltLanguage } from 'smaltdb/engine';
import '@smaltworks/smaltql/register';

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
(`import { open } from '@smaltworks/smaltql'`).
