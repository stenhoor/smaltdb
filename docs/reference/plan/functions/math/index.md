---
description: 'Rounding, powers, logarithms and trigonometry: SQLite''s math functions.'
---

# Math functions

SQLite's math functions, with the same results. The functions of doubles (`sqrt`, `pow`, `exp`, the logarithms, the
trigonometric and hyperbolic functions, `degrees`, `radians`, `mod`, `pi`) take a number, or text that is a number in
full; other text and blobs give NULL. They give a `real`, also for integers. A result with no real value (a domain
error: `sqrt(-1)`, `ln(0)`, `asin(2)`) is NULL, not an error, and a NaN argument gives NULL; infinities stay. `abs`,
`ceil`, `floor` and `trunc` keep an integer an integer; `round` and its two named forms always give a `real` and read
text by its numeric prefix. A NULL argument gives NULL. Angles are in radians.

## Functions {#functions}

- [`abs`](./abs): The absolute value of a number.
- [`sign`](./sign): -1, 0 or 1 for a negative, zero or positive number.
- [`round`](./round): A number rounded to some digits after the decimal point, halves away from zero, as SQLite's round.
- [`round_half_away`](./round_half_away): A number rounded to some digits after the decimal point, with halves away from zero.
- [`round_half_even`](./round_half_even): A number rounded to some digits after the decimal point, with halves to the even digit.
- [`ceil`, `ceiling`](./ceil): The smallest integer not less than a number.
- [`floor`](./floor): The largest integer not greater than a number.
- [`trunc`](./trunc): A number with its fractional part dropped, rounding toward zero.
- [`sqrt`](./sqrt): The square root of a number.
- [`pow`, `power`](./pow): A number raised to a power.
- [`exp`](./exp): e raised to the power of a number.
- [`ln`](./ln): The natural logarithm of a number.
- [`log`](./log): The base-10 logarithm of a number, or with two arguments its logarithm to a base.
- [`log10`](./log10): The base-10 logarithm of a number.
- [`log2`](./log2): The base-2 logarithm of a number.
- [`mod`](./mod): The remainder of one number divided by another, with the sign of the dividend, as a REAL.
- [`pi`](./pi): The number π.
- [`degrees`](./degrees): An angle in radians converted to degrees.
- [`radians`](./radians): An angle in degrees converted to radians.
- [`sin`](./sin): The sine of an angle in radians.
- [`cos`](./cos): The cosine of an angle in radians.
- [`tan`](./tan): The tangent of an angle in radians.
- [`asin`](./asin): The arcsine of a number, in radians.
- [`acos`](./acos): The arccosine of a number, in radians.
- [`atan`](./atan): The arctangent of a number, in radians.
- [`atan2`](./atan2): The angle, in radians, of the point (X, Y) from the positive x axis.
- [`sinh`](./sinh): The hyperbolic sine of a number.
- [`cosh`](./cosh): The hyperbolic cosine of a number.
- [`tanh`](./tanh): The hyperbolic tangent of a number.
- [`asinh`](./asinh): The inverse hyperbolic sine of a number.
- [`acosh`](./acosh): The inverse hyperbolic cosine of a number.
- [`atanh`](./atanh): The inverse hyperbolic tangent of a number.
