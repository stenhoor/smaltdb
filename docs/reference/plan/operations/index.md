---
description: 'The operations of a plan: what each reads, and the columns it gives.'
---

# Operations

A plan is a tree of operations. Each reads the rows of its inputs (other operations, a table, or none) and gives rows
of its own. An operation is a JSON object whose `op` names it.

```railroad
plan
op-meaning
```

Rules every operation follows:

- **Columns are positions.** An operation's output is a list of columns, and the expressions of the operation above
  read them by position: column `index` of input `input` ([`col`](../expressions/col)). Each operation's page gives
  its output columns.
- **Inputs are numbered.** A [`join`](./join) has two inputs, 0 (the left) and 1 (the right); every other operation
  with an input has one, 0.
- **Rows come in no promised order,** except where an operation keeps or makes one: [order](../order).
- **Every operation may carry** `origin`, plain data the engine gives back on its errors, and `decorrelate: false`
  ([meaning fields](../meaning-fields)).

## Reading {#reading}

- [`scan`](./scan): The rows of a table, a materialized view or a view: the columns it lists, by position.
- [`values`](./values): Rows given in the plan: expressions over no columns, or columns of data.
- [`source`](./source): The rows of a table function, a virtual table or an external table.
- [`relationships`](./relationships): The relationships of a property graph as one relation, at either end.

## Rows and columns {#rows-and-columns}

- [`filter`](./filter): The rows of its input for which a condition is true.
- [`project`](./project): One column for each of its expressions, over each row of its input.
- [`sort`](./sort): Its input's rows ordered by its keys; rows with equal keys keep their order.
- [`limit`](./limit): At most `count` of its input's rows, after skipping `offset`, from the start or the end.
- [`sample`](./sample): Rows drawn at random from its input, fixed by a seed.
- [`distinct`](./distinct): One row of each set of rows that are equal, by every column or by some.

## Combining {#combining}

- [`join`](./join): The rows of two inputs combined: inner, outer, cross, semi, anti and as-of joins.
- [`setop`](./setop): The union, intersection or difference of two inputs' rows.

## Aggregating {#aggregating}

- [`aggregate`](./aggregate): One row for each group of its input's rows, with aggregate functions over the group.
- [`window`](./window): Its input's rows, each with window functions computed over its partition and frame.

## Reshaping {#reshaping}

- [`pivot`](./pivot): Values of a column turned into columns: one row per group, aggregates per value.
- [`unpivot`](./unpivot): Columns turned into rows: one row per input row and column, with the column's name.
- [`explode`](./explode): One row for each element of a list column.

## Graphs and recursion {#graphs-and-recursion}

- [`paths`](./paths): The paths through a graph from each input row's node, along relationship tables.
- [`iterate`](./iterate): A recursive query: its first rows, then each step's over the step before, until a step gives none.
- [`working`](./working): Inside an `iterate`, the previous step's rows; inside a `graphMerge`, the rows being matched.

## Writing {#writing}

- [`append`](./append): Appends its input's rows to a table, or one row of defaults; handles conflicts.
- [`update`](./update): Sets columns of the table rows its input names by rowid.
- [`delete`](./delete): Deletes the table rows its input names by rowid.

## Writing a property graph {#graph-writes}

- [`graphCreate`](./graphCreate): Makes nodes and relationships of a property graph for each of its input's rows.
- [`graphSet`](./graphSet): Sets properties and labels of the nodes and relationships each row names.
- [`graphDelete`](./graphDelete): Deletes the nodes, relationships and paths each row names.
- [`graphMerge`](./graphMerge): For each row, what a plan finds in the graph, or what it makes when it finds nothing.
- [`eager`](./eager): Its input's rows, all read before the first is passed on.

The rules these share, and the order a plan that writes a graph runs in, are on
[writing a property graph](../graph-writes).
