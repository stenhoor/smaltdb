---
description: 'General functions: NULL handling, choice, least and greatest, storage classes, hints, errors and randomness.'
---

# General functions

Functions of values of any type. Most give their value back without converting it, so a call states the type its
value has: `int` for integers, `num` for integers and reals mixed, or `any`. Unlike most functions, the NULL handlers
([`coalesce`](./coalesce), [`ifnull`](./ifnull), [`nullif`](./nullif)), the choice ([`iif`](./iif)) and
[`typeof`](./typeof) don't simply give NULL for a NULL argument: each page says what they do. `coalesce`, `ifnull` and
`iif` evaluate only the arguments they need, so an error in one they skip isn't raised. Comparisons of text (`nullif`,
`min`, `max`) use the collation the first argument [carries](../../meaning-fields#carries-and-affinity), else
`binary`. None raises an error, except [`raise_error`](./raise_error), whose purpose it is.

## Functions {#functions}

- [`coalesce`](./coalesce): The first of its arguments that isn't NULL.
- [`ifnull`](./ifnull): The first argument, or the second when the first is NULL.
- [`nullif`](./nullif): NULL when its two arguments are equal, else the first.
- [`if`, `iif`](./iif): The value after the first true condition, else the last argument or NULL.
- [`min`](./min): The least of two or more values, or NULL when any is NULL.
- [`max`](./max): The greatest of two or more values, or NULL when any is NULL.
- [`typeof`](./typeof): SQLite's storage class of a value: integer, real, text, blob or null.
- [`likely`](./likely): `X`, unchanged: a hint that it is usually true.
- [`unlikely`](./unlikely): `X`, unchanged: a hint that it is usually false.
- [`likelihood`](./likelihood): `X`, unchanged: a hint of how often it is true.
- [`raise_error`](./raise_error): Fails the statement with a message and an error code, when a row reaches it.
- [`random`](./random): A random 64-bit integer, a new one each time it is evaluated.
- [`random_at`](./random_at): A number in [0, 1) fixed by a seed and an index: the same arguments always give the same value.
- [`randomblob`](./randomblob): A blob of N random bytes.
