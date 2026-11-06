# ADR 0016: The plan API for every language: what smaltdf needs that SQL never asked for

- **Status:** accepted (#102; owner's decisions below, 2026-11-06)
- **Date:** 2026-11-06
- **Builds on:** [ADR 0014](0014-shared-plan-layer.md) (shared plan layer), [ADR 0015](0015-smaltql.md) (smaltql and
  the language API)

## Context

ADR 0015 made the engine language-free: SQL is smaltql's, and every language reaches the engine through the plan
format and the language interface. Its "What smaltdf needs" section lists what a second language requires. This
record checks the API on `main` (`0b36f33`, after #100 and #101) against that list. The checking was done twice: by
reading the code, then by running each doubtful point against the engine, in process and through the client with no
language registered.

The API already gives a non-SQL language a lot:
- **Operations:** relational operations, writes, recursion and windows.
- **Validation and transport:** a validator and a codec; `preparePlan` / `queryPlan` in process, on the client and for
  plugins; and `defineWorker`.
- **Statements beyond queries:** schema, transaction and setting statements as plan data.
- **Results:** prepared plan statements that stream and report `changes` / `lastInsertRowid`; the math, statistics
  and window functions.

What is missing falls into the groups below.

### What is missing or wrong

**Meaning and operations**

| # | Finding | Evidence |
| --- | --- | --- |
| 1 | **The optimizer and code generation recognise operations by their SQL names.** Hash joins, index and rowid lookups, zone maps, range offsets, selectivity, the count fast path and materialized-view matching look for `sql.eq`, `sql.lt` …, `sql.in_list`, `sql.add` / `sql.sub`. Code generation inlines only `sql.*` arithmetic and comparisons. An operation under any other name is planned as an opaque predicate and compiled by the slower closure compiler. | `exec/planner.ts` (`PROBE_OPS`, about 25 uses of `sql.*` names), `exec/codegen.ts`, `exec/plan-mv-match.ts`, `exec/plan-morsel.ts` |
| 2 | **No operations for meanings other than SQLite's.** The arithmetic, comparison and conversion functions are `sql.*` (ADR 0015 step 2's renaming by behaviour has not happened). Missing: float division (`sql.div` of 7 and 2 is 3, and nothing else divides), floor division and floor modulo, rounding half to even, Unicode case mapping (`lower` / `upper` are ASCII-only), regular expressions. | `exec/sql-functions.ts`, `exec/functions.ts` |
| 3 | **Part of an expression's meaning lives beside the plan.** SQL's affinity, collation source and an "opaque" marker are symbol-keyed properties set with `setMeta`; a "flattened" marker on a plan switches decorrelation off. The codec writes them as `$sql` / `$flattened` fields, but the plan types and builders have no place for them, and only `smaltdb/language` can set them. So two plans that look the same can plan differently, and a non-SQL builder can't say what SQL can. | `exec/sql-meta.ts`, `plan/codec.ts`, 30 uses in `exec/` |

**Types and order**

| # | Finding | Evidence |
| --- | --- | --- |
| 4 | **Types:** a plan's types are the engine's static types (`int`, `real`, `num`, `text`, `blob`, `null`, `any`). There is no boolean, date, time, list or struct. NaN is handled inconsistently: a NaN literal passes through, while `0.0 / 0.0`, math functions and conversions give NULL. | `plan/types.ts`; probe: `lit(NaN)` gives NaN, `sql.div(0.0, 0.0)` gives NULL |
| 5 | **Row order is not part of the contract.** Nothing says whether `filter`, `project`, `join`, `aggregate`, `distinct` or `window` keep their input's order, or whether `sort` is stable (QUERY_ENGINE.md mentions a stable in-memory sort; spilled sorts and the plan docs say nothing). A dataframe language is ordered: it needs these guarantees, or a way to ask for them. | `plan/ops.ts`, docs |

**Operations, data and definitions**

| # | Finding | Evidence |
| --- | --- | --- |
| 6 | **Operations ADR 0015 lists for smaltdf don't exist:** order-aware `first` / `last` aggregates, rows from the end (`tail`), de-duplication keeping the first or last row, pivot / unpivot, as-of join, explode (needs lists), sample, and ignoring NULLs in `lag` / `lead` / `first_value` / `last_value`. The format has `window`, `iterate` and `source`, but the builders don't. | `plan/ops.ts`, `plan/build.ts`, `exec/window.ts` |
| 7 | **JavaScript data:** the only inline source is `values`, one literal expression per cell. There is no columnar source of typed arrays (ADR 0015 §9). | `plan/ops.ts` |
| 8 | **Stored definitions need source text in a registered language.** `createTable`, `createIndex`, `createView`, `createConnection`, `createExternalTable` and `alterTable` all take a `Source` (a language and text). Views are bound from that text by the language's `bindView`, and ALTER TABLE asks the source's language to edit the text (probe: renaming a column of a table created with source language `df` fails, "ALTER TABLE needs the df language"). The language interface is text-in (`parse(source: string)`, `viewReferences`, `sourceEditor`), so a language without text can't define views or keep its tables alterable. | `plan/schema.ts`, `plan/language.ts` |

**Catalog, results and validation**

| # | Finding | Evidence |
| --- | --- | --- |
| 9 | **No catalog API.** A language that builds plans outside the worker can't read tables, columns and their plan types, keys or collations: <ul><li>`BindContext` exists only inside the worker and returns the engine's `TableSchema`, storage fields included;</li><li>a `source` over `information_schema.columns` crashes the planner (`TypeError: … reading 'reg'`);</li><li>`pragma_table_info` works but gives declared types only, under the names `column1`…;</li><li>mapping declared types to plan types is an engine internal (`staticTypeOfStorage`).</li></ul> | probes |
| 10 | **No function metadata.** ADR 0015 §3 promised the registry's metadata through `BindContext` (arity, argument and result types, determinism, kind). `BindContext.funcCtx` is a runtime context, and smaltql reads the raw `scalarFunctions` / `aggregateFunctions` maps instead. | `plan/bind-context.ts`, smaltql's imports |
| 11 | **Results lack types and conveniences.** Columnar results and prepared plan statements carry column names only, with no types. `queryPlan` on a write returns no counts (a prepared write's `run()` does). There's no `db.streamPlan` (`preparePlan(…).stream()` works). | `client/index.ts`; probes |
| 12 | **The validator doesn't cover everything it's given.** <ul><li>Schema operations aren't validated: a `createTable` with no columns, a column `type` that isn't a storage type (`'int'`), and an unregistered source language are all accepted, and an invalid column type fails only at the first insert.</li><li>A `source` whose `types` don't match its width is accepted: too few types silently drop columns, and the `information_schema` case crashes.</li></ul> | probes |

**Errors and the language boundary**

| # | Finding | Evidence |
| --- | --- | --- |
| 13 | **No provenance.** ADR 0015 §9's optional `origin` on plan nodes doesn't exist, so an error can't name the language construct that caused it. Errors carry a code and a message only; the structured details ADR 0015 §9 promised (constraint, table, column) don't exist. | `plan/*.ts`, `errors.ts` |
| 14 | **The language boundary is the engine's internals.** smaltql imports about 45 symbols through `smaltdb/language`, among them: <ul><li>the raw function registries;</li><li>the expression compilers (`compileBoundExpr`, `compilePlanExpr`);</li><li>the metadata setters (`setMeta`, `withMeta`, `markFlattened`);</li><li>type-mapping helpers.</li></ul> ADR 0015 §3 says smaltql uses only the language interface and the public plan API. What it needs beyond them is what any language needs, so it belongs in that API, documented and versioned. | smaltql's build (`fca25f9`) |

Corrected on the second pass (not gaps):
- The client's `transaction()` works with no language registered.
- Plans can stream, through a prepared plan statement.
- The codec keeps the hidden metadata of finding 3: what's missing is a way to express it in a plan, not a way to
  serialize it.

## Decision

The plan API becomes complete enough that a language needs nothing else: whatever smaltql or smaltdf needs is in the
plan format, the language interface or the catalog API, documented and versioned. Each section below is additive
unless it says otherwise.

### 1. Operations are named by behaviour, and the engine knows what each one is

This finishes ADR 0015 step 2's renaming.

- **Behaviour names, not language names.** The registry names each function by what it does. `sql.*` names stay as
  aliases until smaltql has moved to the new names, then go. A first naming scheme, for the owner to settle:

  | Area | Names |
  | --- | --- |
  | Division | `div_trunc` (today's `sql.div` on integers), `div_float`, `div_floor` |
  | Modulo | `mod_trunc` (`sql.mod`), `mod_floor` |
  | Rounding | `round_half_away` (`round`), `round_half_even` |
  | Comparison | `cmp_eq` / `cmp_lt` … with SQLite's storage-class order and affinity (`sql.eq` …), and `eq_strict` / `lt_strict` …, which compare values of one type only |

- **Each function declares its traits:** equality, order comparison (and its flip), null-propagating, monotonic in an
  argument, a constant offset (`a + k`), inlinable (with its inline form), deterministic.
- **The planner and code generation read traits, never names.** `PROBE_OPS`, the equi-join test, zone maps, range
  offsets, selectivity, materialized-view matching and inlining all key on traits. A language that uses `eq_strict`
  gets the same hash joins, index lookups and fused scans as one that uses `cmp_eq`.
- **New operations smaltdf needs, each with its traits:**
  - `div_float`, `div_floor`, `mod_floor`, `round_half_even`;
  - floating-point arithmetic and math that keep NaN (section 3);
  - Unicode `lower` / `upper` (ASCII-only stays available);
  - length in code points;
  - regular-expression match, find and replace, with JavaScript `RegExp` semantics.

  The engine implements and inlines them; no language brings its own (ADR 0015 decision 6).

### 2. A plan says everything about its meaning

- **SQL's affinity conversions are explicit nodes,** as `sql.affinity_*` calls already are where the binder inserts
  them.
- **Collation source becomes an attribute of comparisons and sorts:** explicit, from a column, or none.
- **"Opaque" goes.** Code generation either handles those forms itself, or the plan says so with an explicit
  `inline: false` on the node.
- **"Flattened" becomes `decorrelate: false`** on the operation.

With that, `setMeta`, `withMeta` and `markFlattened` leave `smaltdb/language`, and the codec's `$sql` / `$flattened`
fields go (a plan format change: `PLAN_FORMAT_VERSION` 1).

### 3. Types

Each type gets its own short ADR before it lands (ADR 0015 §9). This record sets the order and the rules:

1. **`bool`:** a plan type and a storage type. Comparisons and logic return `bool`. Results carry `true` / `false`
   (SQL keeps returning 0 / 1 by converting where it needs to).
2. **NaN as a value:** `real` holds NaN, distinct from NULL. Float operations named for it keep NaN; SQL's operations
   keep turning it into NULL, as SQLite does. A NaN literal and a NaN result behave the same way.
3. **`date`, `time` and `datetime`** (with its unit), and `duration`.
4. **`list` and `struct`,** then `explode`.

Storage and the worker protocol carry each new type, which is a file-format change. The first such change is
grouped with the next planned format change, so the format changes once.

### 4. Order is part of the contract

- **Guaranteed always:**
  - `sort` is stable, in memory and when it spills;
  - `filter`, `project` and `limit` keep their input's order, and so does a `window` without its own ORDER BY;
  - `semi` and `anti` joins keep the left input's order.
- **On request,** because guaranteeing it costs:
  - `join` with `ordered: true` keeps the left input's order (and for matches, the right input's);
  - `aggregate` and `distinct` with `ordered: 'first'` give groups in order of their first row.

  Without the flag, order is undefined and the planner is free to choose.
- **New order-aware operations:** `first` / `last` aggregates (by input order, or by an order key), `limit` from the
  end (`fromEnd: true`), and `distinct` keeping the first or last row of each group (`keep: 'first' | 'last'`).

### 5. New operations

All additive, each in its own PR, with the builders that go with them:

- **`values` from columns:** typed arrays or value arrays per column, with a schema. Data crosses the worker
  boundary as transferable buffers, as results do.
- **`unpivot`.**
- **`pivot`** with its values given in the plan. Dynamic pivot is a two-step operation, done by the language.
- **`join` of kind `asof`,** with an order key, a direction and an optional tolerance.
- **`sample`:** a count or a fraction, with or without replacement, and a seed.
- **`ignoreNulls` on navigation window functions.**
- **`explode`,** with lists (section 3).
- **Builders for every operation in the format:** `window`, `iterate`, `source` and the new ones.

### 6. Definitions without source text

- **`source` becomes optional** on every schema operation. When it is absent, the engine stores the definition alone,
  shows a neutral description in its place, and ALTER TABLE changes the definition without asking any language.
- **The language interface splits by capability:**
  - **binding text:** `parse`, `parseOne`;
  - **stored objects:** `bindView`, `viewReferences`, `viewDefinition`, `sourceEditor`.

  A language provides what it uses. smaltdf provides the stored-object part over its own serialized form: a view's
  source is smaltdf's JSON description of the frame, bound late by name like SQL's views. That keeps ADR 0015's
  decision not to store bound plans.
- **Registration:** a language registers under its name for the objects it created. Reading one of those objects
  without it keeps ADR 0015 §6's error.

### 7. A catalog API, the same for every language

- **The logical catalog, everywhere:** `db.catalog` in process, on the client and in `MethodContext`. It lists tables
  (columns with plan type, storage type, declared type, collation, nullability and rowid alias; keys; storage),
  views, materialized views, external tables, functions and settings.
- **`BindContext` is the same catalog,** with neutral table descriptions instead of `TableSchema`.
- **Function metadata** for every registered function: name, kind (scalar, aggregate, window), arity, argument and
  result types, determinism and traits (section 1).
- **Type mapping as documented functions:** declared type to storage type, plan type and affinity. These are today's
  `storageTypeFor`, `staticTypeOfStorage` and `affinityOfStorage`.
- **Engine help for binding:** constant evaluation of an expression over constants and parameters, the one use of
  `compileBoundExpr` a language has. The compilers themselves leave `smaltdb/language`.

### 8. Results

- **Typed results:** columnar results and prepared statements carry each column's plan type.
- **Write results:** `queryPlan` on a write returns `{ changes, lastInsertRowid }` as well as any RETURNING rows.
- **`db.streamPlan`** beside `stream`.

### 9. The validator checks everything it is given

- **Schema operations:**
  - storage types from the enum;
  - at least one column, and unique column names;
  - keys, indexes and foreign keys that name real columns;
  - a registered source language, or none.
- **Sources:** `types` must match the source's width.
- **A planner crash on a valid plan is a bug:** tests generate plans across the format and check that every
  failure is a `SMALT_PLAN` error or a correct result.

### 10. Errors that say where they came from

- **Provenance:** plan nodes take an optional `origin`, opaque to the engine, defined by the language. A SQL text
  span and a smaltdf call site are both examples.
- **Structured errors:** an error carries the `origin` of the node it arose in, and its code, constraint, table and
  column as fields. Each language words them for its users; SQLite's wording is smaltql's.

## Order of work

Each step is its own PR, with the gates of ADR 0015 §10:
- planning-cost benchmarks;
- `test/perf-invariants.test.ts`;
- the plan-shape and generated-code corpora;
- smaltql's suites against each engine change.

1. This ADR.
2. **Validator completeness and the planner crash** (section 9). These are bug fixes with no format change.
3. **Traits** (section 1): the planner and code generation read traits, and `sql.*` functions declare theirs. No
   plan shape or result changes, which the plan-shape corpus checks.
4. **Behaviour names** with `sql.*` as aliases, then the new operations of section 1.
5. **Meaning in the plan** (section 2): `PLAN_FORMAT_VERSION` 1, and smaltql moves off `setMeta`.
6. **Catalog API and function metadata** (section 7); smaltql moves off the raw registries.
7. **Results** (section 8) and **errors** (section 10).
8. **Order** (section 4) and the order-aware operations.
9. **Definitions without source text** (section 6).
10. **New operations** (section 5), in the order smaltdf needs them.
11. **Types** (section 3): `bool` and NaN first, then dates and times, then lists, structs and `explode`, each after
    its own ADR.

smaltdf builds on each step as it lands. ADR 0015 step 10 (smaltdf on plans) can start after step 6 with what then
exists.

## Owner's decisions (2026-11-06)

1. **Names:** behaviour names, as section 1 proposes (`div_trunc`, `div_float`, `div_floor`, `mod_trunc`, `mod_floor`,
   `round_half_away`, `round_half_even`, `cmp_eq` …, `eq_strict` …), with the `sql.*` names as aliases until smaltql
   has moved.
2. **Order:** the cheap guarantees always, the costly ones on request, as section 4 proposes.
3. **Views from smaltdf:** stored as smaltdf's own serialized source and bound late by name (section 6).
4. **Types and the file format:** `bool` is grouped with the next file-format change (section 3).
5. **Priority:** the order of work as written.

## Alternatives considered

- **smaltdf uses `sql.*` functions as they are.** It works today, but smaltdf would get SQLite's results (integer
  division, NaN as NULL), against ADR 0015 §7: each language maps its syntax to the operation it means.
- **The optimizer special-cases each language's names.** Every new operation would mean planner changes, and
  languages would be unequal. Traits give one rule.
- **smaltdf keeps a private engine copy or emulates operations.** Rejected by ADR 0015 decision 6 and the owner's
  direction: the engine owns every implementation.
- **Store bound plans for views written in smaltdf.** Rejected again for the reason in ADR 0015: stored plans go stale
  when tables change.

## Consequences

- **Languages are equal in fact as well as in name:** every optimization, type and operation is reachable from plan
  data alone, and smaltql and smaltdf use the same documented surface.
- **`smaltdb/language` shrinks** to the interface, the catalog and documented helpers. The engine's internals stop
  being part of any language's dependencies.
- **Two version bumps:** one plan-format change (section 2), and file-format changes for new types (section 3).
- **More validation work per plan** (schema operations, sources), within the planning-cost budget.
- **smaltdf's spec can rely on order, types and operations** being defined by the engine rather than by convention.
