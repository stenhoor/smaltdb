---
description: 'Building plans in TypeScript: the plan namespace of smaltdb/plan and smaltdb/engine.'
---

# Builders

`smaltdb/plan` has a builder for most kinds of operation and expression; `smaltdb/engine` exports the same as its
`plan` namespace.
Each makes the JSON object these pages describe, filling in the usual values (`binary` collations, ascending keys,
NULLs first, `depth` 0). They check nothing: the engine validates every plan it is given, built or written by hand.
`smaltdb/plan` is the plan format alone, for code that builds plans without the engine, such as a page that sends
them to a worker.

| | Builders |
|---|---|
| Expressions | `col(input, index, type, collation?, depth?)`, `lit(value, type?)`, `value(v)`, `param(index, type?)`, `call(fn, args, type, collation?)`, `cast(fn, arg, to)`, `and(...)`, `or(...)`, `not(x)`, `isNull(x)`, `isNotNull(x)`, `typed(logic, 'bool' \| 'int')`, `caseWhen(whens, type, otherwise?)`, `scalar(plan, type, collation?)`, `exists(plan)`, `inPlan(probe, plan, collation?)`, `listMap(list, body)`, `listFilter(list, predicate)`, `listAgg(list, aggs, body)`, `element(type, depth?)`, `elementPosition(depth?)`, `aggResult(index, type, depth?)` |
| Sort keys, aggregates | `asc(expr, options?)`, `desc(expr, options?)`, `agg(fn, args, type, options?)` |
| Queries | `scan(table, columns, options?)`, `values(rows, types?)`, `fromColumns(columns, types)`, `filter`, `project`, `sort`, `limit(input, count, offset?, options?)`, `join(kind, left, right, on?, options?)`, `asofJoin(left, right, leftKey, rightKey, options?)`, `aggregate(input, keys, aggs, options?)`, `distinct(input, width, collations?, options?)`, `sample(input, { count } or { fraction }, options?)`, `pivot(input, keys, on, values, aggs, options?)`, `unpivot(input, keep, columns, names, type?)`, `explode(input, column, type, options?)`, `paths(input, start, edges, options?)`, `relationships(graph, direction?, options?)`, `setop(kind, left, right, width)` |
| Windows | `window(input, calls, options?)` (`partition`, `collations`, `order`, `frame`; the frame defaults to the partition's rows up to the current row and its peers), `windowCall(fn, args, type, options?)`, `frame(unit, start, end, exclude?)` with `unboundedPreceding`, `preceding(n)`, `currentRow`, `following(n)`, `unboundedFollowing` |
| Sources and recursion | `source(kind, name, args, types, options?)`, `iterate(id, name, init, steps, options?)`, `working(id, types)` |
| Writes | `append(table, input, columns, options?)`, `update(table, input, rowid, sets, options?)`, `remove(table, input, rowid, options?)` (a `delete`) |
| Graph writes | `graphCreate(graph, input, nodes, relationships?, tables?)`, `graphSet(graph, input, items, tables?)`, `graphDelete(graph, input, targets, options?)`, `graphMerge(graph, id, input, match, make)`, `eager(input)` |
| JSON | `planToJSON(plan)`, `planFromJSON(text)` ([values in JSON](./values)), `encodePlan(plan)`, `decodePlan(e)` (for `postMessage`) |
| Types | `conversion(from, to)`, `isLossless(from, to)` ([conversions](./conversions)), `isPlanTypeName(t)`, `parseNested(t)` ([types](./types)) |

`lit(value)` without a type takes it from the value: a safe integer is `int`, another number `real`, a string `text`.
`values(rows)` without types takes them from the first row's literals.

## Example

The plan on the [overview](./), built:

```ts
import * as p from 'smaltdb/plan';

const qty = p.col(0, 2, 'int');
const inStock = p.filter(p.scan('fruit', [1, 3, 4]), p.call('cmp_gt', [qty, p.lit(0)], 'bool'));
const query = p.sort(p.project(inStock, [p.col(0, 0, 'text'), p.col(0, 1, 'real')]), [p.desc(p.col(0, 1, 'real'))]);
const stmt: p.PlanStatementInput = { kind: 'query', plan: query, columns: [{ name: 'name' }, { name: 'price' }] };

// As JSON text, and back.
const again = p.planFromJSON(p.planToJSON(query));
```

A join and an aggregate:

```ts
import { plan as p } from 'smaltdb/engine';

// The fruit with the number of each ordered, by name.
const joined = p.join('inner', p.scan('fruit', [0, 1]), p.scan('orders', [1, 2]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.col(1, 0, 'int')], 'bool'));
// The join's output: fruit.id, fruit.name, orders.fruit, orders.n
const totals = p.aggregate(joined, [p.col(0, 1, 'text')], [p.agg('sum', [p.col(0, 3, 'int')], 'int'), p.agg('count', [], 'int', { star: true })]);
```

## See also

- [Running plans](../engine/running): `preparePlan` and `queryPlan`, in process and through the client
- [The engine API](../api/engine)
