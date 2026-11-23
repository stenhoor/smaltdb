---
description: 'The expressions of a plan: typed values over the columns of an operation''s inputs.'
---

# Expressions

An expression computes a value for each row an operation reads. It is a JSON object whose `k` names its kind. Every
expression has a static [type](../types), stated on it or given by its kind, and a value may always be NULL.

```railroad
expr
expr-meaning
```

Rules every expression follows:

- **Columns are positions** ([`col`](./col)): an expression reads the columns of the operation that holds it, never
  names.
- **Nothing is implicit.** A conversion is a [`cast`](./cast) or a [`call`](./call), and every comparison names its
  [collation](../collations) or takes the one an operand [carries](../meaning-fields).
- **Truth values are 1, 0 and NULL.** A condition is true when it is a number other than 0: a filter keeps a row whose
  condition is true, and drops it when it is 0, NULL or text that isn't a number. Logic is three-valued.
- **Every expression may carry** the [meaning fields](../meaning-fields): `carries`, `affinity`, `inline` and
  `origin`.

## Values {#values}

- [`col`](./col): Column `index` of input `input` of the operation that holds the expression, or of one around it.
- [`lit`](./lit): A constant value, with its type.
- [`param`](./param): A parameter of the statement, by position from 0.

## Functions and conversions {#functions}

- [`call`](./call): A call of a function by name: a scalar function, or one of the engine's operations.
- [`cast`](./cast): A conversion of a value to a type, by the conversion the plan names.

## Logic {#logic}

- [`and`](./and): Whether every argument is true, in three-valued logic.
- [`or`](./or): Whether any argument is true, in three-valued logic.
- [`not`](./not): The opposite of a truth value; NULL stays NULL.
- [`isNull`](./isNull): Whether a value is NULL, or with `not` whether it isn't; never NULL.
- [`case`](./case): The value of the first branch whose condition is true, else the `else` value.

## Nested plans {#nested-plans}

- [`subquery`](./subquery): A nested plan's first value, or whether it has a row.
- [`inSubquery`](./inSubquery): Whether a value is among a nested plan's values: 1, 0 or NULL.

## Lists {#lists}

- [`each`](./each): An expression over each element of a list: a new list, the elements that pass, or aggregates.
- [`element`](./element): Inside an `each`, the element, or its position.
- [`eachAgg`](./eachAgg): Inside an `each` of mode `agg`, the result of one of its aggregates.
