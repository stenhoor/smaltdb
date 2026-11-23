---
description: 'Addition to division, in SQLite''s meaning and checked, floor and float forms; bit operations.'
---

# Arithmetic functions

The engine's arithmetic ([ADR 0016](../../../../adr/0016-plan-api-for-every-language.md)), in the meanings languages
give it. A language picks the one its syntax means: SQL's `+` is `add` and its `/` is `div_trunc`; a language that
checks its integers adds with `add_checked`; smaltdf divides with `div_float`.

- **NULL in, NULL out.** Each gives NULL when an operand is NULL.
- **Types.** Two integers give an `int`, a `real` operand a `real`; where the types aren't known ahead (`num`, `any`),
  declare on the call the type the value has. Integers are 64-bit, exact (`bigint` past 2^53).
- **SQLite's meaning.** `add`, `sub`, `mul`, `div_trunc`, `mod_trunc` and `neg` are SQLite's: an integer that overflows
  becomes a real, text and blobs convert to the number they begin with, division by zero is NULL, and a NaN result is
  NULL.
- **Other meanings.** `add_checked`, `sub_checked` and `mul_checked` make integer overflow (`SMALT_RANGE`) and text
  (`SMALT_MISMATCH`) errors, and keep NaN. `div_float`, `div_floor` and `mod_floor` keep NaN too
  ([ADR 0018](../../../../adr/0018-bool-and-nan.md)).
- **Bits.** `bit_and`, `bit_or`, `bit_not`, `shift_left` and `shift_right` work on 64-bit integers, converting other
  values as `cast_integer` does.

## Dates and times {#dates-and-times}

A `date`, `datetime`, `time` or `duration` is an integer while a plan runs (days, or µs), and `add`, `sub`, `mul`,
`div_trunc` and their checked forms work on those integers, with these result types
([ADR 0019](../../../../adr/0019-dates-and-times.md)):

| Operands | Result |
|---|---|
| `datetime - datetime`, `time - time`, `duration ± duration` | `duration` |
| `date - date` | `duration`: the days between them, as µs |
| `datetime ± duration`, `duration + datetime` | `datetime` |
| `duration * int`, `int * duration`, `duration / int` | `duration` |

Other operands count as integers: `date + int` is an `int`, a day count. Declare the result type on the call. To move a
date or time by calendar units, use [`offset_by`](../temporal/offset_by).

## Functions {#functions}

- [`add`](./add): The sum of two numbers, in SQLite's meaning: an integer that overflows becomes a real.
- [`sub`](./sub): The difference of two numbers, in SQLite's meaning: an integer that overflows becomes a real.
- [`mul`](./mul): The product of two numbers, in SQLite's meaning: an integer that overflows becomes a real.
- [`div_trunc`](./div_trunc): Division in SQLite's meaning: two integers divide truncating toward zero, and division by zero is NULL.
- [`mod_trunc`](./mod_trunc): The remainder of division in SQLite's meaning, with the sign of the dividend; by zero is NULL.
- [`neg`](./neg): A number negated, in SQLite's meaning: text converts, and the least integer becomes a real.
- [`add_checked`](./add_checked): The sum of two numbers, where integer overflow and text are errors, and reals are IEEE 754.
- [`sub_checked`](./sub_checked): The difference of two numbers, where integer overflow and text are errors, and reals are IEEE 754.
- [`mul_checked`](./mul_checked): The product of two numbers, where integer overflow and text are errors, and reals are IEEE 754.
- [`div_float`](./div_float): Division as floats always, IEEE 754: by zero gives Infinity or NaN.
- [`div_floor`](./div_floor): Division rounded toward negative infinity: an integer for two integers; by zero is NULL.
- [`mod_floor`](./mod_floor): The remainder of division rounded toward negative infinity, with the sign of the divisor; by zero is NULL.
- [`bit_and`](./bit_and): The bitwise AND of two 64-bit integers.
- [`bit_or`](./bit_or): The bitwise OR of two 64-bit integers.
- [`bit_not`](./bit_not): The bitwise complement of a 64-bit integer.
- [`shift_left`](./shift_left): A 64-bit integer shifted left by a number of bits.
- [`shift_right`](./shift_right): A 64-bit integer shifted right by a number of bits, keeping its sign.
