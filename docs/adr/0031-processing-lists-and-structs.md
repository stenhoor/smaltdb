# ADR 0031: Processing lists and structs

- **Status:** accepted with the owner's decisions of 2026-11-13 (at the end): decision 1 takes the alternative, a new
  expression kind (section 4); the others as recommended
- **Progress:** done (2026-11-13). Steps 1 and 3–5 in smaltdb (#221, #222, #224, #223, with `explode` of several
  columns in #225); steps 2 and 6 in smaltdf (smaltdf#29–#32); step 7 in smaltql (smaltql#71); step 8 (#226, and this
  record). SQL syntax for element expressions is smaltql's to record (owner's decision 5)
- **Date:** 2026-11-12
- **Builds on:** [ADR 0020](0020-lists-and-structs.md) (the types, their values and first operations, `explode`);
  [ADR 0022](0022-sql-for-the-new-engine-features.md) (SQL's `ARRAY[…]`, `unnest`, `array_agg`);
  [ADR 0016](0016-plan-api-for-every-language.md) (operations in the plan layer, for every language)

## Context

ADR 0020 gave the engine lists and structs: a value is its elements' index-key bytes under a static type, with 16
functions (`list_of`, `struct_of`, `list_len`, `list_get`, `list_contains`, `list_slice`, `list_concat`, `list_join`,
`list_sort`, `list_unique`, `list_reverse`, `list_sum`, `list_mean`, `list_min`, `list_max`, `struct_field`), the
`implode` aggregate and the `explode` operation. smaltdf exposes them as 16 `list` methods, `struct.field`, `explode`,
`implode` and `unnest`. smaltql exposes them as `ARRAY[…]`, `unnest` and `array_agg` (ADR 0022).

This record asks what a dataframe language needs beyond that, and how the engine should provide it. It was written
from a review of Polars 2.1.0's `list` and `struct` namespaces, against smaltdb `main` (`52438ab`).

### What Polars has that smaltdf doesn't

Polars 2.1.0 has 44 `list` methods and 7 `struct` methods. The ones smaltdf lacks fall into four kinds:

| Kind | Methods |
| --- | --- |
| Building and changing structs and lists | `pl.struct(…)`, `pl.concat_list(…)`, `struct.with_fields`, `struct.rename_fields`, `struct.drop`, `struct.eval` (choose fields), `struct.json_encode`, `list.to_struct` |
| Statistics of one list | `median`, `std`, `var`, `n_unique`, `arg_min`, `arg_max`, `count_matches`, `all`, `any` |
| Changing one list | `drop_nulls`, `shift`, `diff`, `gather`, `gather_every`, `sample`, `item`; set operations `set_union`, `set_intersection`, `set_difference`, `set_symmetric_difference`; options `sort(nulls_last)`, `join(ignore_nulls)`, `contains(nulls_equal)`, `get(null_on_oob)` |
| Expressions over elements | `list.eval(expr)`, `list.filter(pred)`, `list.agg(expr)`, with `pl.element()` standing for each element |

Polars also has `to_array` and `to_map`, which need fixed-width array and map types; ADR 0020 decided against both.

### Can explode, process and implode stand in for them?

In expressive power, mostly: with a row number and each element's position, a list function is an `explode`, a
grouping or filter on the elements, an ordered `implode` and a join back. Three things say it can't stand in:

- **Correctness at the edges.** Empty and null lists (`[]`, `null` and `[null]` come back the same unless tracked), the
  elements' order, row identity, and several list columns per row all need bookkeeping a user would write each time.
- **Where it can be used.** The round trip changes the frame: a join, a group and an explode. A list function is an
  expression, usable in a filter, a sort or join key, an aggregate, a window, and inside other lists and structs.
- **Structs.** `explode` doesn't apply to them, and nothing can build or change one: `struct_of` exists in the engine,
  but no language reaches it except through data that already has structs.

### What it costs

Measured in Node 22, in process, on smaltdb `main` (`52438ab`), through smaltdf frames with this checkout installed
(`fetch-packed.mjs --local`), one run each. The table has `N` rows of `id` and `v`, a `list<int>` of 10 elements on six rows in seven and empty on the
rest. Times are wall-clock for `collect`, plan building included.

| Query | N = 2,000 | N = 100,000 |
| --- | --- | --- |
| `sum(list_sum(v))` | 11 ms | 42 ms |
| `explode(v)`, count | 37 ms | 793 ms |
| explode, group by `id`, sum, left-join back, sum | 42 ms | 803 ms |
| rows where `list_contains(v, 5)`, count | 4 ms | 42 ms |
| rows with an element 5, as a semi join against explode, filter and distinct | 22,792 ms | not finished in 5 min |
| the same as an inner join | 13 ms | |
| a semi join against a filtered, distinct copy of the table (no lists) | 511 ms | |

Three findings:

1. **A list function is about 19 times faster than the round trip** at 100,000 rows, and the round trip's cost is
   almost all `explode`.
2. **`explode` is a recursive iteration** (`exec/plan-normalize.ts`, `explodeRows`). Each round copies every row that
   still has elements, reads each list's length again, and a sort of all elements restores the order.
3. **A semi or anti join against anything but a base table is re-run once per left row.** `semiJoin` rewrites it as an
   `exists` subquery, and the planner decorrelates only subqueries over base tables (`planner.ts`, `decorrelatePlan`);
   otherwise the subquery's plan runs again for each outer row. Against an `explode`, every left row explodes the whole
   table again. This is a defect, and it isn't specific to lists: the plain semi join above grows the same way.

## Proposal

### 1. Semi and anti joins against any input (a fix)

A semi or anti join whose right side isn't a base table runs its right side once: the planner materializes it into a
hash table on the join keys, as it does for a decorrelated subquery, and probes it per left row. The `exists` form stays
for the subqueries that need it (correlations other than equality). This is a fix with no change to the plan language.

### 2. `list_elements`: a list's elements as rows

A built-in table function, `list_elements(list)`, gives one row per element of a list value: the element and its
position (from 0). It is a `source` of kind `function`, so its argument may read the left input's row (a lateral source,
as table functions already can).

- **`explode` becomes a lateral join** of its input with `list_elements` of its column (left for `keepNulls`, with
  `emptyAsNull` as one null element). It decodes each list once and keeps the input's order without a sort. The
  recursive rewrite goes.
- **SQL's `unnest`** (ADR 0022) compiles to the same, with no change smaltql can see.

### 3. Functions of one list or struct

New functions in `exec/nested-ops.ts`, each reading one value in one pass, with the null rules of ADR 0020 (a null list
gives null; null elements count as elements, and the numeric functions skip them):

| Group | Functions |
| --- | --- |
| Statistics | `list_median`, `list_std`, `list_var` (with `ddof`), `list_n_unique`, `list_arg_min`, `list_arg_max`, `list_count_matches`, `list_all`, `list_any` |
| Changing | `list_drop_nulls`, `list_shift`, `list_diff`, `list_gather`, `list_gather_every`, `list_sample`, `list_item` |
| Sets | `list_union`, `list_intersect`, `list_except`, `list_symmetric_except`: each element once, in first-appearance order |
| Options of existing functions | `list_sort` nulls last; `list_join` keeping nulls; `list_contains` with null not equal to null; `list_get` failing out of range |
| Structs | none: `struct_of` and `struct_field` build every struct change (section 5) |

### 4. Expressions over elements: a new expression kind

`list.eval(expr)`, `list.filter(pred)` and `list.agg(expr)` evaluate an expression per element. The plan language gets
one new expression kind, `each`, and a reference inside it, `element` (owner's decision 1):

```ts
{ k: 'each', list: PlanExpr, mode: 'map', body: PlanExpr, type }                         // list.eval: a list
{ k: 'each', list: PlanExpr, mode: 'filter', body: PlanExpr, type }                      // list.filter: a list
{ k: 'each', list: PlanExpr, mode: 'agg', aggs: AggCall[], body: PlanExpr, type }        // list.agg: one value
{ k: 'element', part: 'value' | 'position', depth: number, type }                        // in a body
{ k: 'eachAgg', index: number, depth: number, type }                                     // an agg's result, in an 'agg' body
```

- **`map`** gives a list of `body` for each element, in order: `list<typeOf(body)>`. **`filter`** keeps the elements
  for which `body` (a `bool`) is true, in order. **`agg`** runs `aggs` (the aggregate operation's own `AggCall`s, any of
  the engine's aggregates) over the elements, then `body` over their results: `list.agg(element().sum().div(len()))`.
  A null list gives null in every mode; an empty list gives `[]`, `[]`, and the aggregates of no rows.
- **What a body reads** (owner's decision 1a): the element and its position (`element`), and the enclosing row's
  columns (`col`), so `list.filter(element().gt(col('threshold')))` works.
- **Nesting** (decision 1c): a body may contain `each` of its own. `element` with `depth` 0 is the innermost list's
  element, `depth` 1 the next one out, and so on.
- **Running it:** `exec/expr.ts` and `codegen.ts` compile a body once; at run time `each` decodes the list once (with the
  `elements()` cache of `nested-ops.ts`), binds each element to the body's register and evaluates it. `agg` feeds the
  elements to the aggregates' step functions, as the aggregate operator does. There is no subquery and no per-row plan.
- **Everywhere an expression goes:** the validator, the plan codec (`print.ts`, the plan JSON), types (`output.ts`),
  `smaltdb/plan`'s builders and the catalog's description of expressions learn `each`, `element` and `eachAgg`. A
  language that never builds them is unaffected.

`list_elements` (section 2) stays: it is `explode`'s and `unnest`'s source, and SQL's correlated subqueries over
`unnest` keep working for element work in the meantime.

### 5. smaltdf

- **Building:** `struct({ name: expr, … })` and `concatList(expr, …)` (`struct_of`, `list_of`).
- **Struct methods**, as compositions of `struct_field` and `struct_of`: `struct.withFields`, `struct.renameFields`,
  `struct.drop`, `struct.select` (Polars' `struct.eval`) and `struct.jsonEncode` (`cast_text`). `list.toStruct(fields)`
  is `list_get` per field.
- **The functions of section 3** as `list` methods, with Polars' names in camel case.
- **`element()`** (with `element().position()`), and `list.eval`, `list.filter` and `list.agg` as in section 4; `col` in a
  body reads the row.
- **`explode` of several list columns**, zipped (Polars' `explode([a, b])`): a lateral join with `list_elements` of
  each, matched on position.
- Each method has its reference page, grammar rule and Polars comparison case (smaltdf's documentation standard).

### 6. SQL

smaltql exposes section 3's functions under its own names now. Whether SQL gets syntax for element expressions (lambdas,
as `list_transform(v, x -> x * 10)`) it decides in its own record, later (owner's decision 5). Until then,
correlated subqueries over `unnest` do element work: `SELECT (SELECT array_agg(x * 10) FROM unnest(t.v) AS u(x)) FROM t`.

## Order of work

One PR each, unless the size says more. Sizes: S is one PR, M two or three.

| Step | Repository | What | Size | After |
| --- | --- | --- | --- | --- |
| 1 | smaltdb | Semi and anti joins against any input: the right side once, hashed (section 1), with the measurements above as a test | S | |
| 2 | smaltdf | Building and changing structs and lists (section 5, first two items), and the Polars comparison case for `list.get` out of range | S | |
| 3 | smaltdb | `list_elements`; `explode` as a lateral join on it; the recursive rewrite removed; a benchmark in `bench/` | M | 1 |
| 4 | smaltdb | The functions of section 3 | M | |
| 5 | smaltdb | `each`, `element` and `eachAgg` (section 4): plan types, validator, codec, builders, the closure compiler and codegen; a benchmark in `bench/` against `list_sum` | M | |
| 6 | smaltdf | The methods for step 4; `element()`, `list.eval`, `list.filter`, `list.agg`; `explode` of several columns | M | 3, 4, 5 |
| 7 | smaltql | Section 3's functions in SQL | M | 4 |
| 8 | smaltdb, smaltdf | The roadmap and status pages; this record's status | S | 6 |

Steps 1, 2, 4 and 5 can run side by side: none depends on another. Step 1 goes first (owner's decision 6).

## Owner's decisions (2026-11-13)

The questions as they were put, with what was decided:

1. **How expressions over elements run.**
   - **Decided: a new expression kind** (section 4), the alternative. Fastest, and nothing runs per row as a plan.
   - **Recommended, not taken:** correlated subqueries over `list_elements`, with nothing new in the plan language.
   - Follow-ups, each as recommended:
     - **(a) What a body reads:** the element, its position and the enclosing row's columns, not the element only.
     - **(b) `list.agg`:** any of the engine's aggregates over the elements, not only the `list_*` functions.
     - **(c) Nesting:** bodies nest; `element` refers to the innermost list, with an explicit `depth` for outer ones.
2. **`explode` on `list_elements`:** yes, as recommended (section 2). One path for `explode` and SQL's `unnest`; the
   recursive rewrite goes.
3. **`list.get` out of range:** null, as recommended, with the difference from Polars 2.1 (which fails unless
   `null_on_oob=True`) in smaltdf's "Compared with Polars".
4. **The set functions' order:** first appearance, left list then right, as recommended.
5. **SQL syntax for element expressions:** later, in smaltql's own record, as recommended.
6. **Where to start:** step 1, the semi and anti join fix.
7. **Tracking:** ADR 0031 gets a row in smalt-brand's WORK.md.

## Consequences

- smaltdf can build and change structs, process lists in place, and run any expression or aggregate on elements, with
  the cost of one list decode per row instead of an explode, a group and a join.
- Semi and anti joins stop being quadratic for every language, lists or not.
- `explode` and SQL's `unnest` get faster and lose the recursive rewrite.
- The plan language gains one table function, the functions of section 3, and three expression kinds (`each`,
  `element`, `eachAgg`): every place that reads plan expressions learns them, and a language that doesn't build them
  is unaffected.
