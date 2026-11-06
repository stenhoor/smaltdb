# The catalog

The catalog says what a database holds in plan terms: its tables and their columns as [plan types](./plans#types-and-collations),
collations and positions; its views; the functions a plan can call; and the settings that change what a statement
means ([ADR 0016](../../adr/0016-plan-api-for-every-language.md), section 7). It is the same for every language, and
the same wherever plans are built:

| Where | How |
|---|---|
| In process (`smaltdb/engine`) | `db.catalog`: lookups, plus the engine's help for building plans (below) |
| A plugin method | `ctx.db.catalog` |
| A language binding a statement | `BindContext.catalog` |
| The client (`smaltdb`) | `await db.catalog()`: the catalog as plain data (`CatalogData`), a copy taken when it is called |

The types are exported from `smaltdb/plan` and `smaltdb/engine` (`plan.Catalog`, `plan.CatalogTable`, …).

## Tables and views

`tables()` lists tables, materialized views and external tables; `table(name, schema?)` finds one by name (a TEMP table
first, when it shadows a main one; `schema` picks `main` or `temp`). Each `CatalogTable` has:

| Field | |
|---|---|
| `kind` | `table`, `materializedView` or `external` |
| `name`, `schema` | its name, and `main` or `temp` |
| `columns` | `{ name, type, storageType, declaredType, collation, notNull, rowid, hasDefault }`, in position order: `type` is the plan type of its values, `rowid` marks an integer primary key |
| `keys` | the primary key, then unique constraints, as column positions |
| `indexes` | `{ name, columns, unique, partial }`, `column` -1 for an indexed expression |
| `storage` | `row` or `columnar` |
| `strict` | values must match the column types |

`views()` and `view(name, schema?)` give `{ name, schema, language, text, columns? }`: a view is source text in its
language, bound where it is read.

## Functions

`functions()` lists every function a plan can call, and `function(name, kind?)` finds one. A former `sql.*` name finds
its operation. A name can have one function of each kind: `min` and `max` are a scalar of several arguments and an
aggregate.

| Field | |
|---|---|
| `kind` | `scalar` (in a `call`), `aggregate` (in an aggregate or a window) or `window` (in a window only) |
| `minArgs`, `maxArgs` | how many arguments it takes; `maxArgs` null for any number |
| `deterministic` | the same arguments always give the same result: false for `random()` and for anything that reads the clock or time zone |
| `result` | the result type when nothing is known of the arguments |
| `operation` | set on the engine's own [operations](./plans#functions), with the former names they answer to (`aliases`) |
| `traits` | what the planner and code generation know of it: `compare`, `offset`, `inList`, `pattern`, … |

## Settings

`settings()` gives `{ foreignKeys, workMem, matviewRewrite, parallelAggregates }`: whether foreign keys are enforced,
the memory an operation may use before it spills, whether queries may be answered from materialized views, and whether
aggregates may run in parallel.

## Help for building plans

In process, the catalog also answers what a language needs to know while it builds a plan:

| Method | |
|---|---|
| `resultType(name, args)` | function `name`'s result type for arguments of these plan types (or `{ type, collation }`) |
| `typeOf(expr)` | the type the engine computes for an expression, which can be narrower than the type written on it |
| `constant(expr)` | `{ value }` when the expression depends on nothing but constants, else null |

Declared column types map to storage and plan types by `declaredType(text)` (`storageTypeFor`, `planTypeOfStorage`
and `affinityOfStorage` separately), the same rules the engine applies to `CREATE TABLE`.

```ts
import { Database, plan as p } from 'smaltdb/engine';

const db = Database.openMemory();
db.queryPlan({
  kind: 'schema',
  op: {
    op: 'createTable',
    temp: false,
    ifNotExists: false,
    source: { language: 'plan', text: 'fruit(id, name)' },
    table: {
      name: 'fruit',
      storage: 'row',
      columns: [
        { name: 'id', declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' },
        { name: 'name', declaredType: 'TEXT', type: 'TEXT', notNull: false, collation: 'nocase' },
      ],
      keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }] }],
      checks: [],
      foreignKeys: [],
    },
  },
});

const fruit = db.catalog.table('fruit')!;
console.log(fruit.columns.map((c) => `${c.name}: ${c.type} ${c.collation}`)); // ['id: int binary', 'name: text nocase']
console.log(db.catalog.function('div_float')!.result); // 'real'
console.log(db.catalog.constant(p.call('add', [p.lit(2), p.lit(3)], 'int'))); // { value: 5 }
console.log(p.declaredType('VARCHAR(20)')); // { storageType: 'TEXT', type: 'text', affinity: 'TEXT' }
```
