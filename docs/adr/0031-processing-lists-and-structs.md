# ADR 0031: Processing lists and structs

- **Status:** proposed
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

### 4. Expressions over elements: correlated subqueries over `list_elements`

`list.eval(expr)`, `list.filter(pred)` and `list.agg(expr)` need an expression evaluated per element. Rather than a new
expression kind, each is a correlated scalar subquery over `list_elements` of the outer row's list, which the plan
language already has:

| Method | Plan |
| --- | --- |
| `list.eval(e)` | `(implode(e) over list_elements(v), ordered by position)` |
| `list.filter(p)` | `(implode(element) over list_elements(v) where p, ordered by position)` |
| `list.agg(a)` | `(a over list_elements(v))` |

The element is the subquery's column 0 (its position, column 1); the outer row is depth 1. Everything an expression can
do works on elements: functions, `case`, aggregates, even a window over the elements.

The engine's part: a correlated subquery over `list_elements` is **not decorrelated**. It runs per outer row, which here
is what's wanted: each run decodes one list. The work is making that per-row run cheap: the subquery's plan compiled once,
`list_elements` reading the outer value without copying it, and `implode` writing the result directly. A benchmark gates
it (Order of work, step 5): `list.eval(element() * 10)` within 3 times `list_sum` on the table above. If it doesn't
reach that, a fused native form of the three shapes above is the fallback, with no change to the plan language.

### 5. smaltdf

- **Building:** `struct({ name: expr, … })` and `concatList(expr, …)` (`struct_of`, `list_of`).
- **Struct methods**, as compositions of `struct_field` and `struct_of`: `struct.withFields`, `struct.renameFields`,
  `struct.drop`, `struct.select` (Polars' `struct.eval`) and `struct.jsonEncode` (`cast_text`). `list.toStruct(fields)`
  is `list_get` per field.
- **The functions of section 3** as `list` methods, with Polars' names in camel case.
- **`element()`**, and `list.eval`, `list.filter` and `list.agg` as in section 4.
- **`explode` of several list columns**, zipped (Polars' `explode([a, b])`): a lateral join with `list_elements` of
  each, matched on position.
- Each method has its reference page, grammar rule and Polars comparison case (smaltdf's documentation standard).

### 6. SQL

smaltql exposes section 3's functions under its own names, and decides in its own record whether SQL gets an element
syntax (lambdas, as `list_transform(v, x -> x * 10)`) or keeps to correlated subqueries over `unnest`, which work as soon
as sections 2 and 4 are in: `SELECT (SELECT array_agg(x * 10) FROM unnest(t.v) AS u(x)) FROM t`.

## Order of work

One PR each, unless the size says more. Sizes: S is one PR, M two or three.

| Step | Repository | What | Size | After |
| --- | --- | --- | --- | --- |
| 1 | smaltdb | Semi and anti joins against any input: the right side once, hashed (section 1), with the measurements above as a test | S | |
| 2 | smaltdf | Building and changing structs and lists (section 5, first two items), and the Polars comparison case for `list.get` out of range | S | |
| 3 | smaltdb | `list_elements`; `explode` as a lateral join on it; the recursive rewrite removed; a benchmark in `bench/` | M | 1 |
| 4 | smaltdb | The functions of section 3 | M | |
| 5 | smaltdb | Correlated subqueries over `list_elements` run per row, cheaply; the benchmark gate of section 4 | M | 3 |
| 6 | smaltdf | The methods for step 4; `element()`, `list.eval`, `list.filter`, `list.agg`; `explode` of several columns | M | 4, 5 |
| 7 | smaltql | Section 3's functions in SQL, and its own record on element syntax | M | 4 |
| 8 | smaltdb, smaltdf | The roadmap and status pages; this record's status | S | 6 |

Steps 1, 2 and 4 can run side by side: none depends on another.

## Open points for the owner

1. **How expressions over elements run.**
   - **Recommendation:** correlated subqueries over `list_elements` (section 4). Nothing new in the plan language, and
     every expression works on elements, aggregates and windows included. Risk: per-row overhead, which the step 5
     benchmark gates, with a native fallback.
   - **Alternative:** a new expression kind (`{ k: 'each', list, body }`, with an `element` reference) compiled into the
     expression evaluator. Fastest, but a plan-language change every language and the codec must learn, and aggregates
     over elements would need their own path.
2. **`explode` on `list_elements`.**
   - **Recommendation:** yes (section 2): one path for `explode`, SQL's `unnest` and section 4.
   - **Alternative:** keep the rewrite and make it cheaper (no sort, no length re-read). Smaller change, but two ways
     to reach elements.
3. **`list.get` out of range.** Polars 2.1 fails by default (`null_on_oob=False`); smaltdf gives null, and its
   comparison test hides the difference by passing `null_on_oob=True`.
   - **Recommendation:** keep null (ragged lists make out-of-range normal data), and list the difference in smaltdf's
     "Compared with Polars".
   - **Alternative:** fail by default, as owner's decision E fails on overflow, with `nullOnOob` to get null.
4. **The set functions' order.** Polars doesn't promise one.
   - **Recommendation:** first-appearance order, left list then right, as `list_unique` already does: results are
     stable and testable.
   - **Alternative:** sorted.

## Consequences

- smaltdf can build and change structs, process lists in place, and run any expression on elements, with the cost of one
  list decode per row instead of an explode, a group and a join.
- Semi and anti joins stop being quadratic for every language, lists or not.
- `explode` and SQL's `unnest` get faster and lose the recursive rewrite.
- The plan language gains one table function and the functions of section 3, and nothing else, unless open point 1's
  alternative is chosen.
