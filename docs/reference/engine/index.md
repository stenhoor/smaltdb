# The engine

smaltdb's engine stores data and runs **plans**: trees of relational operations, given as plain data. It reads no
query language. A language turns its own text into plans: SQL is one ([smaltql](https://github.com/stenhoor/smaltql)),
and a dataframe library or an application can build plans directly. This section describes the engine from that side:
for code that builds plans, and for people writing a language.

::: warning Experimental
The plan format and the language interface are experimental (`plan.PLAN_FORMAT_VERSION` is `1`). They may change in
any release until a second language besides SQL has proven them ([ADR 0014](../../adr/0014-shared-plan-layer.md),
[ADR 0015](../../adr/0015-smaltql.md)).
:::

## The parts

| Part | What it is |
|---|---|
| **Engine** | Storage, transactions, the catalog, the planner and execution. It plans and runs plans, and keeps each object's definition as language-neutral data. |
| **Plans** | A query or a write as data: [operations and expressions](./plans) with columns referenced by position, explicit types and collations, and named functions. The engine [validates](./running#validation) every plan before it plans it. |
| **Languages** | Turn source text into plans, and bind the views and stored objects written in them. A language [registers](./languages) with the engine; engine code never imports one. |
| **Plugins** | Add file formats, data sources and table functions ([ADR 0012](../../adr/0012-plugins.md), [writing plugins](../api/plugins)). |
| **Workers** | In a page, the engine runs in a Web Worker. A worker entry registers the languages and installs the plugins it needs with [`defineWorker`](./languages#workers). |

## Entry points

| Import | Use |
|---|---|
| `smaltdb/engine` | The synchronous engine for Node or a worker of your own: `Database`, the `plan` namespace (builders, validator, codec), `registerLanguage`. |
| `smaltdb/plan` | The plan format alone (types, builders, codec), for code that builds plans without the engine, such as a page that sends them to a worker. |
| `smaltdb` | The client for pages: `open()` and an asynchronous `Database` whose engine runs in a worker. It runs plans with [`queryPlan`](https://stenhoor.github.io/smaltql/reference/api/client#queryplan). |
| `smaltdb/worker-runtime` | `defineWorker({ languages, plugins })`: an engine worker entry. |
| `smaltdb/language` | What a language reaches in the engine (the language interface, plan types, values, conversions, functions, catalog lookups). |

`smaltdb/engine`, `smaltdb/worker-runtime` and `smaltdb/language` share one engine: a language registered through one
is the one the others use.

## A first plan

A table, three rows and a query, all as plans:

```ts
import { Database, plan as p } from 'smaltdb/engine';

const db = Database.openMemory();

// CREATE TABLE fruit(id INTEGER PRIMARY KEY, name TEXT, qty INT)
const column = (name: string, type: 'INTEGER' | 'TEXT'): p.ColumnDef => ({ name, declaredType: type, type, notNull: false, collation: 'binary' });
db.preparePlan({
  kind: 'schema',
  op: {
    op: 'createTable',
    temp: false,
    ifNotExists: false,
    source: { language: 'plan', text: 'fruit(id, name, qty)' },
    table: {
      name: 'fruit',
      storage: 'row',
      columns: [column('id', 'INTEGER'), column('name', 'TEXT'), column('qty', 'INTEGER')],
      keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }] }],
      checks: [],
      foreignKeys: [],
    },
  },
}).run();

// INSERT INTO fruit(name, qty) VALUES ('apple', 3), ('pear', 5), ('plum', 7)
const rows = p.values([[p.lit('apple'), p.lit(3)], [p.lit('pear'), p.lit(5)], [p.lit('plum'), p.lit(7)]]);
db.queryPlan({ kind: 'write', plan: p.append('fruit', rows, [1, 2]) });

// SELECT name FROM fruit WHERE qty > ? ORDER BY qty DESC
const qty = p.col(0, 2, 'int');
const query = p.project(p.sort(p.filter(p.scan('fruit', [0, 1, 2]), p.call('cmp_gt', [qty, p.param(0, 'int')], 'int')), [p.desc(qty)]), [p.col(0, 1, 'text')]);
console.log(db.queryPlan({ kind: 'query', plan: query, columns: [{ name: 'name', type: 'text' }] }, [4]).rows); // [['plum'], ['pear']]
```

- [The plan format](./plans): every operation and expression, types, collations and functions.
- [Running plans](./running): building them, running them in-process and through the client, validation, parameters,
  writes, and other statements.
- [Schema definitions](./schema): tables, indexes, views and the rest, as data.
- [Writing a language](./languages): the language interface, registration and workers.
