# ADR 0036: User-defined functions from plugins, with predict as the first

- **Status:** accepted, 2026-11-15 (the owner). The points under "Still to decide" are settled during implementation
  (the owner, 2026-11-15), each in the pull request of the step that needs it.
- **Date:** 2026-11-15
- **Builds on:** [ADR 0012](0012-plugins.md) (plugins; section 4 named `addScalarFunction` and `addAggregateFunction`
  and left them out of the first version), [ADR 0013](0013-plugin-api-v1.md) (plugin API version 1: new `PluginHost`
  members are additive), [ADR 0015](0015-smaltql.md) (no language brings its own functions),
  [ADR 0016](0016-plan-api-for-every-language.md) (one plan for every language; functions declare traits; one catalog
  API), [ADR 0020](0020-lists-and-structs.md) (lists and structs)
- **Affects:** smaltml ([its ADR 0024](https://github.com/stenhoor/smaltml/blob/main/docs/adr/0024-smaltml-scope-and-architecture.md),
  "Still to decide", item 6: how `predict()` reaches the query languages); smaltql, smaltdf, smaltts and smaltcy (they
  call the new functions as they call the engine's own, with no change of their own beyond what section 6 says)

## Context

**The ask.** smaltml fits models and predicts in TypeScript, and smaltnb's TypeScript cells can call `predict()`
directly. SQL (smaltql) and Cypher (smaltcy) can't: a query can't call a TypeScript function. The owner (2026-11-15)
weighed two routes:

1. **A predict plugin in the engine:** every language gets it (smaltql, smaltdf, smaltts, smaltcy), but it asks the
   engine to carry machine learning, which the owner isn't keen on.
2. **A predict plugin for smaltql** (and smaltcy later): no ask on the engine, but evaluated outside the plan it can
   only add values to results. It couldn't be used in `WHERE`, a join, an `ORDER BY` or an `INSERT … SELECT`, and every
   language would need its own.

**A third route,** taken here: the engine learns one general thing, user-defined functions registered by plugins, and
knows nothing about machine learning. Predict is a plugin that registers `predict` through it. It reaches every
language, as route 1 does, and keeps machine learning out of the engine, as route 2 does.

**What the engine has today:**

- **A fixed function registry.** Scalar functions (`scalarFunctions`, `exec/functions.ts`) and aggregates
  (`aggregateFunctions`) are built in. Each scalar function compiles to a closure over the row's register file and runs
  once per row; it declares its arity, whether it is deterministic, its result type and its traits (ADR 0016 section 1).
- **One catalog for every language.** The catalog API describes every function (name, kind, arity, deterministic,
  traits, result type; `catalog/logical.ts`), and the languages' binders use it. A function the catalog lists, any
  language can call.
- **The plan already names functions.** A plan calls a function by name; nothing in the plan format is specific to
  built-in functions.
- **The extension was planned.** ADR 0001 required the function registry to be "extensible, so UDFs … can be added
  without format changes". ADR 0012 sketched `addScalarFunction` and `addAggregateFunction` on `PluginHost` and left
  them out of the first version. ADR 0013 allows new `PluginHost` members within API version 1.

**What predict needs that today's functions don't:**

- **Batches.** A model scores a matrix of rows at once: smaltml's predictions are a matrix product (Xw), fast over
  thousands of rows and slow called once per row. A function compiled per row would lose most of that.
- **Setup per call site.** `predict('churn', age, spend)` names a model. The model should be found and loaded once per
  statement, not per row, and its result type (a number, a label, a list of probabilities) depends on the model.
- **Data from the database.** smaltml's registry keeps models as rows of a table in the same database
  (`smaltml_models`: name, version, model kind, document; smaltml's `TableStore`). The function reads its model from
  there.

## Decision

### 1. Plugins register functions: `addScalarFunction` (and later `addAggregateFunction`)

A new `PluginHost` member, additive within plugin API version 1 (ADR 0013 section 2):

```ts
host.addScalarFunction('predict', {
  minArgs: 2,
  maxArgs: null,                     // variadic
  deterministic: true,               // for given arguments and a given database state
  constantArgs: [0],                 // argument 0 (the model's name) must be a constant at the call site
  bind(args, ctx) { ... },           // at planning: checks the call, gives the result type
  prepare(args, ctx) { ... },        // once per statement: loads what it needs (the model)
  batch(columns, n, prepared) { ... } // per batch of rows: argument columns in, result column out
});
```

- **`bind(args, ctx)`** runs when the call is planned. It gets each argument's static type, and the values of the
  constant arguments. It checks the call (the model exists, the number of features matches) and returns the result
  type. Errors here are planning errors, with the call's position, like a wrong built-in call.
- **`prepare(args, ctx)`** runs once per statement execution, with the constant arguments, before the first batch. It
  may read the database through `ctx.query`, in the statement's own snapshot, and returns any value the batches use.
- **`batch(columns, n, prepared)`** runs per batch of rows. It gets one column per argument (typed arrays for numbers,
  value arrays otherwise, as the plan API's `values` takes them, ADR 0016 section 5) and returns one column of `n`
  results. A function may also give a per-row `fn` instead of `batch`, for cheap functions.
- **Names are global and unique.** A plugin can't replace a built-in function or another plugin's: registering a name
  that exists fails at `setup` with `SMALT_MISUSE`, naming both. Plugin functions don't shadow future built-ins: a
  later built-in of the same name is a breaking change, and the release notes say so.
- **Traits:** a plugin function declares none at first. The planner treats it as an opaque, deterministic call: no
  inlining, index use or zone maps. Traits for plugin functions can come later, additively.

### 2. The engine calls them in batches

The planner gathers calls to `batch` functions in a projection or filter into a batched step. That step collects each
call's argument columns over a batch of rows (about a thousand, chosen by the engine), calls `batch` once, and hands
the results back to the row's expression as a column read. The rest of the expression, and every built-in function,
runs as it does today. A call inside a conditional (`CASE`) still runs on every row of the batch; the function must be
safe to call on rows whose result is unused, which `deterministic: true` implies.

Morsel parallelism (ADR 0010, 0021) runs the batched step on each parallel reader, as plugins already run in every
worker (ADR 0012 section 3). Each reader calls `prepare` once per statement.

### 3. Every language sees them through the catalog

The catalog lists plugin functions with the built-in ones: their name, arity, whether deterministic, and `plugin`, the
plugin's name. A language binder calls them by name as it calls built-in functions. A language's own type checker,
such as smaltql's binder or smaltty's checks on smaltdf calls, asks the engine for the result type through `bind`, so
a wrong model name or feature count fails when the statement is checked, before it runs.

### 4. Databases that use a missing plugin function

As for other plugin features (ADR 0012 section 5): opening the database always works. A statement that calls the
function fails with `SMALT_PLUGIN_MISSING`, naming the plugin. A view or materialized view that uses it is kept; reading
it fails the same way, and a materialized view's automatic refresh records the error.

### 5. Errors

A plain `Error` from `bind`, `prepare` or `batch` becomes `SMALT_EXTERNAL` with the function's name; a `SMALT_…` code is
kept; `AbortError` becomes `SMALT_INTERRUPT` (as for plugin formats and sources, ADR 0013). The statement fails;
nothing is written.

### 6. The first function: predict, from a plugin that wraps smaltml

The first user is predict: a plugin that wraps smaltml and registers its predictions as functions.

```sql
-- score in a query
SELECT id, predict('churn', age, spend, tenure) AS risk FROM customers;
-- filter and order by a prediction
SELECT id FROM customers WHERE predict('churn', age, spend, tenure) > 0.8 ORDER BY 1;
-- keep the scores
INSERT INTO scores SELECT id, predict('churn', age, spend, tenure) FROM customers;
-- a class's probabilities, as a list
SELECT id, predict_proba('segment', age, spend) FROM customers;
```

```cypher
MATCH (c:Customer) WHERE predict('churn', c.age, c.spend, c.tenure) > 0.8 RETURN c.name
```

- **Functions:** `predict(model, feature, …)` gives a model's prediction: a `real` for a regressor, a class label
  (`text` or `integer`, the model's classes' type) for a classifier. `predict_proba(model, feature, …)` gives a
  classifier's probabilities as a `list<real>` in the order of its classes (ADR 0020). `model` is `'name'` (its latest
  version) or `'name@3'` (that version).
- **Where models come from:** the database's `smaltml_models` table, as smaltml's `TableStore` writes it. `bind` checks
  the model exists and that the number of features matches it; `prepare` reads its document once per statement, in
  the statement's snapshot, and builds the model with smaltml's `loadModel`.
- **Features are positional,** in the model's feature order. A model saved with feature names (`featureNamesIn`)
  makes `bind` check the count; names in SQL (a struct argument) can come later.
- **Batches run smaltml's `predictSync` and `predictProbaSync`** on a matrix built from the argument columns: the CPU
  path, the same result as smaltml in TypeScript. No GPU and no threads inside the engine (the engine already
  parallelises across readers).
- **Deterministic:** for a given model version and given rows. Saving a new version changes what `'name'` means, as
  inserting a row changes a table: a materialized view over `predict('churn', …)` is refreshed like any view whose
  source changed. To make that happen, `prepare`'s read of `smaltml_models` counts as the statement reading that table.
- **The engine doesn't import smaltml.** The plugin does: it is a smaltdb plugin in its own repository (ADR 0012), and
  smaltml stays a library that knows nothing of the engine's internals. smaltml has no runtime dependencies, so the
  plugin brings only smaltml's own code into the engine worker that loads it.

### 7. Aggregates and table functions

`addAggregateFunction` follows the same shape (a state with `step` over batches, and `final`) when a plugin needs one;
predict doesn't. Table functions already exist for plugins (`addTableFunction`). Neither is built until a plugin needs
it.

## Consequences

- **Every language can predict,** in any expression, from one plugin, and so can any later plugin function: JSON,
  geospatial, text search, or an application's own.
- **The engine gains one general mechanism**, with no machine learning in it: a function registry plugins add to, and a
  batched call step in the planner. It is permanent API (version 1), so its shape is chosen for more than predict.
- **The batched step is new planner and execution work:** gathering calls, columns over batches, and parallel readers.
  It's the part of this record that costs the most, and the part that makes predict fast.
- **Queries can depend on plugins in a new way:** a view's definition can name a plugin function. Section 4 keeps such
  databases openable without the plugin.
- **A model's version matters to a query's result.** Pinning a version (`'churn@3'`) gives repeatable results; the
  latest version changes as models are saved, like any table.
- **smaltml's ADR 0024, item 6** ("how `predict()` reaches the query languages") is answered by this record: through
  a plugin function, for every language.

## Steps

1. This record (accepted 2026-11-15).
2. smaltdb: `addScalarFunction` with per-row `fn` only, in the catalog, with section 4's missing-plugin behaviour,
   tested with a test plugin (`test/plugins.test.ts`) from every language's pin (smaltql at least).
3. smaltdb: `bind`, `prepare` (with `ctx.query` in the statement's snapshot) and `batch`, and the batched step in the
   planner, on the owner and on parallel readers, with benchmarks of a batch function against the same function per
   row.
4. The predict plugin's repository (the owner creates it): `predict` and `predict_proba` over `smaltml_models`, compared
   with smaltml's own predictions bit for bit, from SQL and from smaltdf.
5. Docs: a "Writing plugins" section on functions (smaltdb), the plugin's site, and smaltml's guide page on predicting
   from queries; smaltml's ADR 0024 item 6 marked answered.

## Still to decide

Settled during implementation, in the pull request of the step that needs each one (the owner, 2026-11-15).

1. **The predict plugin's name and repository:** `smaltdb-ml` (a smaltdb plugin, named as smaltdb's are) or
   `smaltml-predict` (named for the library it carries). Either way it is shown as smaltdb's infrastructure plugins are
   (smalt-brand BRAND.md, "Plugins").
2. **Batch size and where the batched step sits:** a fixed batch size, or the engine's morsel size; and whether the
   first version supports `batch` functions inside joins' conditions, or only in projections and filters.
3. **`ctx.query` for functions:** reading the database from inside a statement is new for plugins (plugin methods have
   it, between statements). The engine must read in the statement's snapshot without re-entering the statement's own
   locks; the shape is settled in step 3.
4. **Function traits for plugins:** whether plugin functions may later declare traits (null-propagating, monotonic)
   for the planner's optimisations, and how they are validated.
5. **Security:** a plugin function runs the plugin's code on the database's rows, as plugin formats and sources already
   do. Whether that needs anything beyond the application choosing its plugins (ADR 0012) is for the owner.
