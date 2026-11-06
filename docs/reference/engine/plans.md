# The plan format

A plan is a tree of **operations** (`PlanOp`), each reading the rows of its inputs and producing rows, with
**expressions** (`PlanExpr`) over those rows. Plans are plain, immutable data: no closures and no names to resolve.
They are serializable as JSON (see [the codec](./running#plans-as-json)), and the types are exported from `smaltdb/plan`
and `smaltdb/engine` (`plan.PlanOp`, `plan.PlanExpr`, …).

Three rules run through the format:

- **Columns are positions.** An expression reads column `index` of input `input` of the operation that owns it
  (`col(0, 2, …)`), never a name. Each operation's output columns are defined below.
- **Nothing is implicit.** Every value has a static type, every comparison, sort and grouping names its collation, and
  every conversion is an explicit cast or function call. Behaviour that differs between languages lives in named
  functions (SQL's are the `sql.*` functions below).
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
| `scan` | `table`, `columns` (table column indexes, -1 the rowid), `db?` (`main` / `temp`), `indexedBy?` | the listed columns |
| `values` | `rows` (expressions over no columns), `types` | one column per value |
| `source` | `kind` (`function` / `virtual` / `external`), `name`, `schema?`, `args`, `named?`, `types` | the source's columns (a table function, `information_schema.*`, an external table) |
| `filter` | `input`, `pred` | its input's |
| `project` | `input`, `exprs` | one column per expression |
| `sort` | `input`, `keys` | its input's |
| `limit` | `input`, `count`, `offset?` | its input's |
| `distinct` | `input`, `collations` (one per column) | its input's |
| `join` | `kind`, `inputs` (left, right), `on?` | the left input's, then the right's (`semi` / `anti`: the left's only) |
| `aggregate` | `input`, `keys`, `aggs`, `carry` | its keys, then one per aggregate call, then the carried columns |
| `window` | `input`, `partition`, `order`, `frame`, `calls` | its input's, then one per window call |
| `setop` | `kind` (`union` / `unionAll` / `intersect` / `except`), `inputs`, `collations` | the first input's |
| `iterate` | `id`, `name`, `init`, `steps`, `distinct`, `collations`, `order?`, `limit?`, `offset?` | `init`'s: its rows, then each step's until a step gives none (a recursive query) |
| `working` | `id`, `types` | inside an `iterate` with the same `id`: the previous step's rows |
| `append` | `table`, `db`, `input` (null: one row of defaults), `columns`, `upserts`, `onConflict?`, `returning?` | the RETURNING rows |
| `update` | `table`, `db`, `input`, `rowid`, `sets`, `from`, `onConflict?`, `returning?` | the RETURNING rows |
| `delete` | `table`, `db`, `input`, `rowid`, `returning?` | the RETURNING rows |

**Joins.** `kind` is `inner`, `left`, `right`, `full`, `cross`, `semi` (left rows with a match) or `anti` (left rows
without one). The condition reads input 0 (the left side) and input 1 (the right side).

**Sort keys** (`SortKey`) are `{ expr, desc, nullsFirst, collation }`.

**Aggregates.** `keys` are `{ expr, collation }`. Each call (`AggCall`) is
`{ fn, args, star, distinct, filter?, collation, type }`: `fn` names an aggregate function (`count`, `sum`, `avg`,
`min`, `max`, `group_concat`, `total`, and the [others](https://stenhoor.github.io/smaltql/reference/functions/aggregate)); `star` is `count(*)`. `carry` passes
input columns through, taken from one row of each group (SQL's bare columns). With no keys, an aggregate gives one row,
also over no input rows.

**Windows.** A `window` operation computes the calls of one window: `partition` (`{ expr, collation }`), `order` (sort
keys) and `frame` (`{ unit: 'ROWS' | 'RANGE' | 'GROUPS', start, end, exclude }`, each bound
`{ kind, offset? }` with `kind` `unboundedPreceding`, `preceding`, `currentRow`, `following` or `unboundedFollowing`).
A call (`WindowCall`) is a ranking function (`row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`),
a navigation function (`lag`, `lead`, `first_value`, `last_value`, `nth_value`) or an aggregate over the frame.

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
| `cast` | `fn`, `to`, `arg` | a conversion, `fn` naming it (`sql.cast_integer`, …) |
| `and`, `or` | `args` | three-valued logic |
| `not` | `arg` | three-valued NOT |
| `isNull` | `arg`, `not` | 1 when `arg` is NULL (`not`: when it is not), never NULL |
| `case` | `whens` (`{ when, then }`), `else`, `type` | the `then` of the first `when` that is 1, else `else` |
| `subquery` | `mode` (`scalar` / `exists`), `plan`, `type`, `collation` | the first column of the nested plan's first row (NULL if none), or whether it has a row |
| `inSubquery` | `probe`, `plan`, `collation` | whether `probe` is in the nested plan's single column: 1, 0, or NULL |

## Functions

A `call` names a registered function. The validator checks it exists and accepts that many arguments.

**Named functions** are the engine's built-in scalar functions, the same names and behaviour as in the
[functions reference](https://stenhoor.github.io/smaltql/reference/functions/): `upper`, `abs`, `round`, `substr`, `coalesce`, `json_extract`, `date`, …, and
any a plugin registers.

**`sql.*` functions** give the operations whose meaning languages differ on the meaning SQLite gives them. A language
with other rules uses other functions.

| Function | Arguments | Meaning |
|---|---|---|
| `sql.eq`, `sql.ne`, `sql.lt`, `sql.le`, `sql.gt`, `sql.ge` | 2 | Comparison in SQLite's storage-class order (NULL < numbers < text < blobs); NULL if either side is NULL. Text compares by the call's `collation`. |
| `sql.is`, `sql.is_not` | 2 | Comparison where NULL equals NULL; never NULL |
| `sql.add`, `sql.sub`, `sql.mul`, `sql.div`, `sql.mod` | 2 | Arithmetic: integer overflow becomes REAL, integer division truncates, division by zero is NULL |
| `sql.neg` | 1 | Negation |
| `sql.bitand`, `sql.bitor`, `sql.shl`, `sql.shr`, `sql.bitnot` | 2 (`bitnot`: 1) | Bit operations on 64-bit integers |
| `sql.not` | 1 | Truth-value NOT of any value |
| `sql.concat` | 2 | Text concatenation (`\|\|`) |
| `sql.like`, `sql.glob` | 2 or 3 | `value`, `pattern`, optional escape character |
| `sql.in_list` | 2 or more | Whether the first argument equals one of the others: 1, 0 or NULL |
| `sql.cast_integer`, `sql.cast_real`, `sql.cast_text`, `sql.cast_blob`, `sql.cast_numeric` | 1 | SQLite's CAST |
| `sql.affinity_numeric`, `sql.affinity_text` | 1 | The conversion SQLite applies to a comparison operand of that affinity |

**Aggregate and window functions** are named the same way (`sum`, `rank`, …) in `AggCall` and `WindowCall`.

## Builders

The `plan` namespace has a builder for most kinds, filling in the usual values (BINARY collation, ascending keys,
NULLs first). They check nothing: the engine validates every plan it is given, built or written by hand.

| | Builders |
|---|---|
| Expressions | `col(input, index, type, collation?, depth?)`, `lit(value, type?)`, `value(v)`, `param(index, type?)`, `call(fn, args, type, collation?)`, `cast(fn, arg, to)`, `and(...)`, `or(...)`, `not(x)`, `isNull(x)`, `isNotNull(x)`, `caseWhen(whens, type, otherwise?)`, `scalar(plan, type, collation?)`, `exists(plan)`, `inPlan(probe, plan, collation?)` |
| Sort keys, aggregates | `asc(expr, options?)`, `desc(expr, options?)`, `agg(fn, args, type, options?)` |
| Queries | `scan(table, columns, options?)`, `values(rows, types?)`, `filter`, `project`, `sort`, `limit(input, count, offset?)`, `join(kind, left, right, on?)`, `aggregate(input, keys, aggs, options?)`, `distinct(input, width)`, `setop(kind, left, right, width)` |
| Writes | `append(table, input, columns, options?)`, `update(table, input, rowid, sets, options?)`, `remove(table, input, rowid, options?)` |

`window`, `source`, `iterate` and `working` have no builder yet: write them as objects.

```ts
import { plan as p } from 'smaltdb/engine';

// SELECT f.name, sum(o.n), count(*) FROM fruit f JOIN orders o ON o.fruit = f.id GROUP BY f.name
const joined = p.join('inner', p.scan('fruit', [0, 1]), p.scan('orders', [1, 2]), p.call('sql.eq', [p.col(0, 0, 'int'), p.col(1, 0, 'int')], 'int'));
// The join's output: fruit.id, fruit.name, orders.fruit, orders.n
const totals = p.aggregate(joined, [p.col(0, 1, 'text')], [p.agg('sum', [p.col(0, 3, 'int')], 'int'), p.agg('count', [], 'int', { star: true })]);
```

## Plan shapes

Any tree that follows these rules is a valid plan: a sort directly over an aggregate, a filter over a join, a bare scan.
The engine rearranges what it is given into the shape its planner reads (SQL's: LIMIT, ORDER BY, DISTINCT, the
projection, windows, HAVING, the aggregate, WHERE, then the FROM items) without changing its rows. A projection of a
sort keeps the sort's order.
