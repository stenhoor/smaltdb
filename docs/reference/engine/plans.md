# The plan format

A plan is a tree of **operations** (`PlanOp`), each reading the rows of its inputs and producing rows, with
**expressions** (`PlanExpr`) over those rows. Plans are plain, immutable data: no closures and no names to resolve.
They are serializable as JSON (see [the codec](./running#plans-as-json)), and the types are exported from `smaltdb/plan`
and `smaltdb/engine` (`plan.PlanOp`, `plan.PlanExpr`, …).

Three rules run through the format:

- **Columns are positions.** An expression reads column `index` of input `input` of the operation that owns it
  (`col(0, 2, …)`), never a name. Each operation's output columns are defined below.
- **Nothing is implicit.** Every value has a static type, every comparison, sort and grouping names its collation, and
  every conversion is an explicit cast or function call. Behaviour that differs between languages lives in the
  engine's operations, named for what they do (below): a language picks the ones that give its meaning.
- **NULL is three-valued.** Predicates are integers: 1 true, 0 false, NULL unknown. A filter keeps the rows where its
  predicate is 1.

## Types and collations

| `PlanType` | Values |
|---|---|
| `int` | 64-bit integers: JavaScript numbers within ±(2^53 − 1), `bigint` beyond |
| `real` | 64-bit floating point |
| `num` | `int` or `real`, not known until run time |
| `text` | strings |
| `blob` | `Uint8Array` |
| `null` | only NULL |
| `any` | not known until run time |

A type is what the engine knows of a value ahead of time, used to pick specialized code: a value may always be NULL.

| `CollationName` | Text compares |
|---|---|
| `binary` | by bytes (UTF-8) |
| `nocase` | ignoring the case of ASCII letters |
| `rtrim` | ignoring trailing spaces |

## Operations

Each operation's output columns, in order:

| Operation | Fields | Output |
|---|---|---|
| `scan` | `table`, `columns` (table column indexes, -1 the rowid), `db?` (`main` / `temp`), `indexedBy?` | the listed columns. `table` may name a view: its query, bound by its language when the plan is compiled ([views](./languages#views)) |
| `values` | `rows` (expressions over no columns), `types`, `columns?` (the values as data: see below) | one column per value |
| `source` | `kind` (`function` / `virtual` / `external`), `name`, `schema?`, `args`, `named?`, `types` | the source's columns (a table function, `information_schema.*`, an external table) |
| `filter` | `input`, `pred` | its input's |
| `project` | `input`, `exprs` | one column per expression |
| `sort` | `input`, `keys` | its input's |
| `limit` | `input`, `count`, `offset?`, `fromEnd?` (`true`) | its input's |
| `sample` | `input`, `count?` or `fraction?`, `replace`, `seed` | its input's |
| `pivot` | `input`, `keys`, `on`, `collation`, `values`, `aggs`, `ordered?` | its keys, then one column per value and aggregate call (value by value) |
| `unpivot` | `input`, `keep` (columns kept), `columns` (columns that become rows), `names` (one per column), `type` (of the values) | the kept columns, then each row's column name (`text`), then its value |
| `distinct` | `input`, `collations` (one per column), `ordered?` (`'first'`), `on?`, `keep?` (`'first'` / `'last'`) | its input's |
| `join` | `kind`, `inputs` (left, right), `on?`, `ordered?` (`true`), `asof?` (kind `asof`) | the left input's, then the right's (`semi` / `anti`: the left's only) |
| `aggregate` | `input`, `keys`, `aggs`, `carry`, `ordered?` (`'first'`) | its keys, then one per aggregate call, then the carried columns |
| `window` | `input`, `partition`, `order`, `frame`, `calls` | its input's, then one per window call |
| `setop` | `kind` (`union` / `unionAll` / `intersect` / `except`), `inputs`, `collations` | the first input's |
| `iterate` | `id`, `name`, `init`, `steps`, `distinct`, `collations`, `order?`, `limit?`, `offset?` | `init`'s: its rows, then each step's until a step gives none (a recursive query) |
| `working` | `id`, `types` | inside an `iterate` with the same `id`: the previous step's rows |
| `append` | `table`, `db`, `input` (null: one row of defaults), `columns`, `upserts`, `onConflict?`, `returning?` | the RETURNING rows |
| `update` | `table`, `db`, `input`, `rowid`, `sets`, `from`, `onConflict?`, `returning?` | the RETURNING rows |
| `delete` | `table`, `db`, `input`, `rowid`, `returning?` | the RETURNING rows |

**Joins.** `kind` is `inner`, `left`, `right`, `full`, `cross`, `semi` (left rows with a match), `anti` (left rows
without one) or `asof`. The condition reads input 0 (the left side) and input 1 (the right side).

**As-of joins.** A join of kind `asof` gives each left row, in left order, the right row whose key is nearest its own,
or NULLs when none is. `asof` is `{ left, right, direction, tolerance? }`: the left row's key (over input 0), the right
row's (over input 1), and `direction`: `backward` takes the largest right key at or below the left's, `forward` the
smallest at or above, `nearest` the closest (ties to the smaller key). `tolerance`, an expression over no columns, is
the largest distance allowed. `on` limits the candidates (for example, the same symbol). The engine runs it as a join
under these conditions, ranked per left row: with an equality in `on` it uses that to find candidates; without one,
it compares every pair of rows.

**Order.** These operations keep an order, whatever plan the engine picks:

- `sort` is stable: rows with equal keys keep their input order, also as a top-N under a `limit` and when the sort
  spills to disk.
- `filter`, `project` and `limit` keep their input's order, and so does a `window` without its own `order`.
  Such a window also takes its rows in that order: its ranking and navigation calls (`row_number`, `lag`, …) and a
  `ROWS` frame number, look back over and accumulate the rows as its input gives them, in each partition.
- `semi` and `anti` joins keep the left input's order.
- A `setop` of kind `unionAll` gives its first input's rows, in their order, then its second's.

Other operations keep an order when the plan asks, since keeping it costs time:

- A `join` with `ordered: true` gives the left input's order, and for each left row its matches in the right input's
  order. A left join's unmatched left rows keep their place; a right or full join's unmatched right rows come last, in
  the right input's order.
- An `aggregate` or a `distinct` with `ordered: 'first'` gives its groups in the order of each group's first row.

Without these, the order of other operations' output is not defined, and the engine is free to choose it.

These operations are defined by order:

- `first` and `last` aggregates give the value of a group's first or last row: `first(value)` by input order,
  `first(value, key)` at the row with the smallest key (`last`: the largest), skipping rows whose key is NULL, with
  ties by input order. A third argument is a second key.
- A `limit` with `fromEnd: true` counts from the end: the last `count` rows before the last `offset` rows, in input
  order. A negative `count` takes every row, as it does from the start.
- A `distinct` with `on` (column indexes) treats rows as duplicates when those columns are equal, by their
  collations, and keeps one row of each set: the first by input order, or the last with `keep: 'last'`. `keep` without
  `on` compares every column. The kept rows come in input order, or with `ordered: 'first'` in the order of each set's
  first row.

**Values from columns.** `values` may give its rows as data instead of expressions: `columns`, one per type, all of
one length, with `rows` empty. A column is a typed array (`Float64Array`, `Float32Array`, `Int32Array`, `Int16Array`,
`Int8Array`, `Uint32Array`, `Uint16Array`, `Uint8Array`, or `BigInt64Array` for integers beyond 2^53), an array of values, or either as
`{ data, nulls }` with a null bitmap (bit `i % 8` of byte `i >> 3` set when value `i` is NULL, as results carry them). NaN in a float
array is NaN, a value of `real` that sorts after every number ([ADR 0018](../../adr/0018-bool-and-nan.md)). The engine reads the values where they are. In JSON a typed array is `{"$typed": "f64", "data":
[…]}`; through the client it crosses to the worker as binary data beside the plan's JSON (see [running
plans](./running#through-the-client)).

```ts
import { plan as p } from 'smaltdb/engine';

const fruit = p.fromColumns([new Int32Array([1, 2, 3]), ['apple', 'pear', 'plum'], new Float64Array([1.5, 0.5, 2])], ['int', 'text', 'real']);
```

**Sample.** A `sample` draws rows at random, fixed by its integer `seed`: `count` rows, or a `fraction` of the input's
(expressions over no columns; exactly one of them). Without `replace`, it takes that many distinct rows (all of them
when there are fewer) and keeps their input order. With `replace`, it makes that many draws, each any row, and gives
the rows in the order drawn.

**Pivot.** A `pivot` turns values of `on` into columns: one row per group of `keys` (as `aggregate` groups), then for
each of `values`, in order, each of `aggs` over the group's rows whose `on` equals that value by `collation` (a NULL
value matches NULL). The values are given in the plan: a dynamic pivot reads them first, then builds the plan.

**Unpivot.** An `unpivot` turns columns into rows: each input row gives one row per column in `columns`, in input
order and then the columns' order, holding the `keep` columns, the column's name from `names`, and its value. NULL
values give rows too.

**Sort keys** (`SortKey`) are `{ expr, desc, nullsFirst, collation }`.

**Aggregates.** `keys` are `{ expr, collation }`. Each call (`AggCall`) is
`{ fn, args, star, distinct, filter?, collation, type }`: `fn` names an aggregate function (`count`, `sum`, `avg`,
`min`, `max`, `first`, `last`, `group_concat`, `total`, and the [others](https://stenhoor.github.io/smaltql/reference/functions/aggregate)); `star` is `count(*)`. `carry` passes
input columns through, taken from one row of each group (SQL's bare columns). With no keys, an aggregate gives one row,
also over no input rows.

**Windows.** A `window` operation computes the calls of one window: `partition` (`{ expr, collation }`), `order` (sort
keys) and `frame` (`{ unit: 'ROWS' | 'RANGE' | 'GROUPS', start, end, exclude }`, each bound
`{ kind, offset? }` with `kind` `unboundedPreceding`, `preceding`, `currentRow`, `following` or `unboundedFollowing`).
A call (`WindowCall`) is a ranking function (`row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`),
a navigation function (`lag`, `lead`, `first_value`, `last_value`, `nth_value`) or an aggregate over the frame. A
navigation call with `ignoreNulls: true` counts only rows whose value is not NULL: `lag(x, 2)` is the second earlier
non-NULL `x` (its default when there is none), and `first_value`, `last_value` and `nth_value` skip NULLs in the
frame.

**Writes.** `append` assigns its input's columns to the table's `columns` (-1 the rowid; the others take their
defaults). `update` and `delete` take the target rows from `input`, the rowid in its column `rowid`; `update`'s `sets`
assign `{ column, value }` with `value` over the input row. `returning` expressions read each written row: the table's
columns, then its rowid. `onConflict` (`rollback`, `abort`, `fail`, `ignore`, `replace`) overrides each constraint's
own action; `upserts` handle conflicts of an `append` (`{ target, update? }`, `target` an index of the table, -1 its
integer primary key, `null` any).

## Expressions

| Kind | Fields | Value |
|---|---|---|
| `col` | `input`, `index`, `depth`, `type`, `collation` | column `index` of input `input`; `depth` d > 0 reads the input of the operation d dependent evaluations out (a correlated reference) |
| `lit` | `value`, `type` | a constant |
| `param` | `index`, `type` | positional parameter `index` (0-based) |
| `call` | `fn`, `args`, `type`, `collation?` | a function; `collation` is the rule a comparison-like function compares text by |
| `cast` | `fn`, `to`, `arg` | a conversion, `fn` naming it (`cast_integer`, …) |
| `and`, `or` | `args` | three-valued logic |
| `not` | `arg` | three-valued NOT |
| `isNull` | `arg`, `not` | 1 when `arg` is NULL (`not`: when it is not), never NULL |
| `case` | `whens` (`{ when, then }`), `else`, `type` | the `then` of the first `when` that is 1, else `else` |
| `subquery` | `mode` (`scalar` / `exists`), `plan`, `type`, `collation` | the first column of the nested plan's first row (NULL if none), or whether it has a row |
| `inSubquery` | `probe`, `plan`, `collation` | whether `probe` is in the nested plan's single column: 1, 0, or NULL |

**Meaning fields.** Any expression may also say how it takes part in comparisons and code generation, and any
operation whether decorrelation applies to it. They are optional; a language that states every collation and
conversion on its calls needs none of them.

| Field | On | Meaning |
|---|---|---|
| `carries` | expressions | `{ collation, from }`: the collation the value brings to a comparison it is an operand of, and where it came from, `explicit` (stated on the value) or `column` (a column's). An explicit one wins over a column's, the left operand over the right; with none, comparisons use `binary`. |
| `affinity` | expressions | `INTEGER`, `REAL`, `NUMERIC`, `TEXT` or `BLOB`: the conversion a comparison applies to the other operand (SQLite's column affinity). `TEXT` turns a number on the other side into text; a numeric affinity turns numeric text into a number. |
| `inline` | expressions | `false`: code generation leaves this expression whole to the general evaluator. Results are the same either way. |
| `decorrelate` | operations | `false`: the planner does not rewrite correlated subqueries of this operation into joins. Results are the same either way. |
| `origin` | expressions and operations | Where the node came from in the language that built the plan (a SQL text span, a call site): plain data the engine never reads. An error that arises in an expression carries the origin of the innermost node around it that has one; an error while a write runs (a constraint failure) carries the write's. See [error fields](../api/errors). |

## Functions

A `call` names a registered function. The validator checks it exists and accepts that many arguments.

**Named functions** are the engine's built-in scalar functions, the same names and behaviour as in the
[functions reference](https://stenhoor.github.io/smaltql/reference/functions/): `upper`, `abs`, `round`, `substr`, `coalesce`, `json_extract`, `date`, …, and
any a plugin registers.

**Operations** are the engine's own arithmetic, comparisons and conversions, named for what they do
([ADR 0016](../../adr/0016-plan-api-for-every-language.md)). The planner and code generation recognise them by the
traits they declare (a comparison, a constant offset, an inline form), not by their names.

| Operation | Arguments | Meaning |
|---|---|---|
| `cmp_eq`, `cmp_ne`, `cmp_lt`, `cmp_le`, `cmp_gt`, `cmp_ge` | 2 | Comparison in SQLite's storage-class order (NULL < numbers < text < blobs); NULL if either side is NULL. Text compares by the call's `collation`. |
| `cmp_is`, `cmp_is_not` | 2 | Comparison where NULL equals NULL; never NULL |
| `add`, `sub`, `mul` | 2 | Arithmetic; integer overflow becomes REAL, text converts by its numeric prefix |
| `div_trunc` | 2 | Division: two integers divide truncating toward zero, a REAL operand gives REAL division; division by zero is NULL |
| `mod_trunc` | 2 | Remainder with the sign of the dividend; by zero is NULL |
| `neg` | 1 | Negation |
| `bit_and`, `bit_or`, `shift_left`, `shift_right`, `bit_not` | 2 (`bit_not`: 1) | Bit operations on 64-bit integers |
| `truth_not` | 1 | Truth-value NOT of any value |
| `text_concat` | 2 | Text concatenation; NULL if either side is NULL |
| `like`, `glob` | 2 or 3 | `value`, `pattern`, optional escape character |
| `in_list` | 2 or more | Whether the first argument equals one of the others: 1, 0 or NULL |
| `cast_integer`, `cast_real`, `cast_text`, `cast_blob`, `cast_numeric` | 1 | SQLite's CAST |
| `affinity_numeric`, `affinity_text` | 1 | The conversion SQLite applies to a comparison operand of that affinity |
| `current_date`, `current_time`, `current_timestamp` | 0 | The statement's date and time as text |

**Operations for other meanings** are named functions for the meanings other languages give their syntax: a language
picks the one it means. smaltdf, for example, divides with `div_float` where SQL divides with `div_trunc`.

| Function | Arguments | Meaning |
|---|---|---|
| `div_float` | 2 | Division as floats always (`7 / 2 = 3.5`). A non-zero value divided by zero is `Infinity` or `-Infinity`; `0 / 0` is NULL, until NaN is a value |
| `div_floor` | 2 | Division rounded toward negative infinity (`-7, 2` gives `-4`): an integer for two integers, else REAL. Division by zero is NULL |
| `mod_floor` | 2 | The remainder of `div_floor`, with the sign of the divisor (`-7, 2` gives `1`). By zero is NULL |
| `round_half_even` | 1 or 2 | `x` rounded to `digits` places (default 0) with halves to even, decided on the exact binary value (`0.125` gives `0.12`, `2.675` gives `2.67`). REAL |
| `round_half_away` | 1 or 2 | The same with halves away from zero: `round` |
| `add_checked`, `sub_checked`, `mul_checked` | 2 | As `add`, `sub` and `mul`, except that an integer result outside the 64-bit range is an error (`SMALT_RANGE`) rather than a REAL, and a text operand is an error (`SMALT_MISMATCH`) rather than converted |
| `cast_integer_strict` | 1 | An integer: integers as they are, reals truncated toward zero when the result fits, text only when all of it is an integer in range. Anything else is an error (`SMALT_MISMATCH`, or `SMALT_RANGE` out of range), where `cast_integer` gives 0 or saturates. A `cast` node or a call |
| `cast_real_strict` | 1 | A real: numbers, and text only when all of it is a number. Anything else is an error (`SMALT_MISMATCH`) |
| `random_at` | 2 | A value in [0, 1) fixed by an integer `seed` and `index`: the same arguments always give the same value (`sample` ranks rows by it) |
| `lower_unicode`, `upper_unicode` | 1 | Case mapping of every script (`straße` gives `STRASSE`); `lower` and `upper` map ASCII only |
| `regex_match` | 2 or 3 | Whether `text` matches `pattern`: 1, 0 or NULL |
| `regex_find` | 2 or 3 | The first match of `pattern` in `text`, or NULL |
| `regex_replace`, `regex_replace_all` | 3 or 4 | `text` with the first match, or every match, of `pattern` replaced by `replacement` (`$1`, `$&`) |

Patterns are JavaScript regular expressions in Unicode mode; the optional last argument gives flags among `i`, `m` and
`s`. `length` counts code points. These operations are not inlined by code generation yet, nor are the checked and
strict ones.

**Aggregate and window functions** are named the same way (`sum`, `rank`, …) in `AggCall` and `WindowCall`.

## Builders

The `plan` namespace has a builder for most kinds, filling in the usual values (BINARY collation, ascending keys,
NULLs first). They check nothing: the engine validates every plan it is given, built or written by hand.

| | Builders |
|---|---|
| Expressions | `col(input, index, type, collation?, depth?)`, `lit(value, type?)`, `value(v)`, `param(index, type?)`, `call(fn, args, type, collation?)`, `cast(fn, arg, to)`, `and(...)`, `or(...)`, `not(x)`, `isNull(x)`, `isNotNull(x)`, `caseWhen(whens, type, otherwise?)`, `scalar(plan, type, collation?)`, `exists(plan)`, `inPlan(probe, plan, collation?)` |
| Sort keys, aggregates | `asc(expr, options?)`, `desc(expr, options?)`, `agg(fn, args, type, options?)` |
| Queries | `scan(table, columns, options?)`, `values(rows, types?)`, `fromColumns(columns, types)`, `filter`, `project`, `sort`, `limit(input, count, offset?, options?)`, `join(kind, left, right, on?, options?)`, `asofJoin(left, right, leftKey, rightKey, options?)`, `aggregate(input, keys, aggs, options?)`, `distinct(input, width, collations?, options?)`, `sample(input, { count } or { fraction }, options?)`, `pivot(input, keys, on, values, aggs, options?)`, `unpivot(input, keep, columns, names, type?)`, `setop(kind, left, right, width)` |
| Windows | `window(input, calls, options?)` (`partition`, `collations`, `order`, `frame`; the frame defaults to the partition's rows up to the current row and its peers), `windowCall(fn, args, type, options?)`, `frame(unit, start, end, exclude?)` with `unboundedPreceding`, `preceding(n)`, `currentRow`, `following(n)`, `unboundedFollowing` |
| Sources and recursion | `source(kind, name, args, types, options?)`, `iterate(id, name, init, steps, options?)`, `working(id, types)` |
| Writes | `append(table, input, columns, options?)`, `update(table, input, rowid, sets, options?)`, `remove(table, input, rowid, options?)` |

```ts
import { plan as p } from 'smaltdb/engine';

// SELECT f.name, sum(o.n), count(*) FROM fruit f JOIN orders o ON o.fruit = f.id GROUP BY f.name
const joined = p.join('inner', p.scan('fruit', [0, 1]), p.scan('orders', [1, 2]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.col(1, 0, 'int')], 'int'));
// The join's output: fruit.id, fruit.name, orders.fruit, orders.n
const totals = p.aggregate(joined, [p.col(0, 1, 'text')], [p.agg('sum', [p.col(0, 3, 'int')], 'int'), p.agg('count', [], 'int', { star: true })]);
```

## Plan shapes

Any tree that follows these rules is a valid plan: a sort directly over an aggregate, a filter over a join, a bare scan.
The engine rearranges what it is given into the shape its planner reads (SQL's: LIMIT, ORDER BY, DISTINCT, the
projection, windows, HAVING, the aggregate, WHERE, then the FROM items) without changing its rows. A projection of a
sort keeps the sort's order.
