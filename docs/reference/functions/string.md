# String functions

Functions that build, measure, search and format text. The concatenation operator `||` and pattern matching with `LIKE` and `GLOB` are operators, documented in [Expressions](../sql/expressions).

Unless stated otherwise, a NULL argument gives a NULL result, and numbers are converted to text the way `CAST(x AS TEXT)` converts them. Lengths and positions count characters (Unicode code points), not bytes or UTF-16 units.

## Measuring text

### length {#length}

```
length(X)
```

For text, the number of characters. For a blob, the number of bytes. For a number, the length of its text form. NULL gives NULL.

```sql
SELECT length('héllo') AS a, length('😀') AS b, length(x'010203') AS c, length(12.50) AS d, length(NULL) AS e;
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 5 | 1 | 3 | 4 | NULL |

`12.50` is the REAL 12.5, whose text form `12.5` has four characters.

### octet_length {#octet_length}

```
octet_length(X)
```

The number of bytes in the UTF-8 encoding of `X` (for a blob, its size). NULL gives NULL.

```sql
SELECT octet_length('héllo') AS a, octet_length('😀') AS b, octet_length(123) AS c;
```

| a | b | c |
| --- | --- | --- |
| 6 | 4 | 3 |

## Case

### lower {#lower}

```
lower(X)
```

`X` as text with the ASCII letters `A`–`Z` changed to lower case. Other characters are unchanged, as in SQLite without the ICU extension.

### upper {#upper}

```
upper(X)
```

`X` as text with the ASCII letters `a`–`z` changed to upper case. Other characters are unchanged.

```sql
SELECT lower('Hello World') AS a, upper('Hello World') AS b, lower('ÉCOLE') AS c, upper('straße') AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| hello world | HELLO WORLD | École | STRAßE |

For case-insensitive comparison of ASCII text, `COLLATE NOCASE` is usually a better fit; see [Expressions](../sql/expressions).

## Substrings

### substr {#substr}

```
substr(X, START)
substr(X, START, LENGTH)
substring(X, START)
substring(X, START, LENGTH)
```

`substring` is another name for `substr`. Returns the part of `X` that begins at character `START` (the first character is 1) and is `LENGTH` characters long, or runs to the end when `LENGTH` is omitted.

- A negative `START` counts from the end: `-1` is the last character.
- A negative `LENGTH` takes the `|LENGTH|` characters *before* `START`.
- `START` 0 behaves like 1 but the result is one character shorter.
- For a blob, positions and lengths count bytes and the result is a blob. Anything else is treated as text and the result is text.
- If any argument is NULL, the result is NULL.

```sql
SELECT substr('hello', 2, 3) AS a, substr('hello', -3) AS b, substr('hello', 4, -2) AS c, substr('hello', 0, 2) AS d, substring('hello', 10) AS e;
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| ell | llo | el | h | |

```sql
SELECT substr(x'01020304', 2, 2) AS a, substr(12345, 2, 2) AS b, typeof(substr(12345, 2, 2)) AS c;
```

| a | b | c |
| --- | --- | --- |
| x'0203' | 23 | text |

### instr {#instr}

```
instr(X, Y)
```

The position (1-based, in characters) of the first occurrence of `Y` in `X`, or 0 when `Y` does not occur. An empty `Y` gives 1. If either argument is a blob, both are compared as bytes and the position counts bytes. NULL in either argument gives NULL.

```sql
SELECT instr('héllo', 'l') AS a, instr('hello', 'z') AS b, instr(x'010203', x'03') AS c, instr(12345, 34) AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| 3 | 0 | 3 | 3 |

## Trimming and replacing

### trim {#trim}

```
trim(X)
trim(X, CHARS)
```

Removes characters from both ends of `X`. Without `CHARS`, it removes spaces (only the space character, not tabs or newlines). With `CHARS`, it removes any character that appears in `CHARS`. NULL in either argument gives NULL.

### ltrim {#ltrim}

```
ltrim(X)
ltrim(X, CHARS)
```

Like `trim`, but only from the start of `X`.

### rtrim {#rtrim}

```
rtrim(X)
rtrim(X, CHARS)
```

Like `trim`, but only from the end of `X`.

```sql
SELECT '[' || trim('  a b  ') || ']' AS a, '[' || ltrim('  a b  ') || ']' AS b, '[' || rtrim('  a b  ') || ']' AS c, trim('xxhixx', 'x') AS d, trim('abcba', 'ab') AS e;
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| [a b] | [a b  ] | [  a b] | hi | c |

::: warning Differs from SQLite
A REAL argument without a fractional part is converted to text without the `.0` before trimming: `trim(12.0, '1')` is `'2'` in smaltdb and `'2.0'` in SQLite.
:::

### replace {#replace}

```
replace(X, Y, Z)
```

`X` with every occurrence of `Y` replaced by `Z`. Occurrences are found from left to right and do not overlap. If `Y` is empty, `X` is returned unchanged. If any argument is NULL, the result is NULL.

```sql
SELECT replace('hello', 'l', 'L') AS a, replace('aaa', 'aa', 'b') AS b, replace('abc', '', 'x') AS c, replace(123, 2, 9) AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| heLLo | ba | abc | 193 |

## Concatenation

### concat {#concat}

```
concat(X, …)
```

Concatenates the text form of all its arguments, skipping NULLs. It takes at least one argument and never returns NULL: `concat(NULL)` is the empty string. The `||` operator, by contrast, returns NULL if either side is NULL.

```sql
SELECT concat('a', NULL, 1, 2.5) AS a, concat(NULL) AS b, 'a' || NULL AS c;
```

| a | b | c |
| --- | --- | --- |
| a12.5 | | NULL |

### concat_ws {#concat_ws}

```
concat_ws(SEP, X, …)
```

Concatenates the non-NULL arguments after the first, with `SEP` between them. If `SEP` is NULL, the result is NULL. It takes at least two arguments.

```sql
SELECT concat_ws('-', '2024', '03', NULL, '15') AS a, concat_ws(', ', NULL) AS b, concat_ws(NULL, 'a', 'b') AS c;
```

| a | b | c |
| --- | --- | --- |
| 2024-03-15 | | NULL |

## Characters and code points

### char {#char}

```
char(X, …)
```

Returns a string made of the characters whose Unicode code points are the arguments. Arguments are converted to integers. With no arguments, the result is the empty string.

```sql
SELECT char(72, 105) AS a, char(128512) AS b, char() AS c;
```

| a | b | c |
| --- | --- | --- |
| Hi | 😀 | |

::: warning Differs from SQLite
NULL arguments are skipped (SQLite treats them as code point 0), and a negative code point gives U+0000 (SQLite gives U+FFFD).
:::

### unicode {#unicode}

```
unicode(X)
```

The Unicode code point of the first character of `X` (as text). An empty string or NULL gives NULL.

```sql
SELECT unicode('A') AS a, unicode('é') AS b, unicode('😀') AS c, unicode('') AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| 65 | 233 | 128512 | NULL |

## Hex and SQL literals

### hex {#hex}

```
hex(X)
```

The bytes of `X` as upper-case hexadecimal. A blob is encoded as is; anything else is first converted to text and its UTF-8 bytes are encoded, so `hex(255)` is the hex of the text `'255'`. NULL gives the empty string, not NULL.

```sql
SELECT hex(x'0aff') AS a, hex('abc') AS b, hex(255) AS c, hex('é') AS d, hex(NULL) AS e;
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 0AFF | 616263 | 323535 | C3A9 | |

smaltdb has no `unhex()` function; use a blob literal (`x'0aff'`) instead.

### quote {#quote}

```
quote(X)
```

`X` as an SQL literal: text in single quotes with embedded quotes doubled, blobs as `X'…'`, NULL as the text `NULL`, and numbers in a form that reads back as the same value (a REAL keeps a decimal point or exponent).

```sql
SELECT quote('it''s') AS a, quote(x'0aff') AS b, quote(NULL) AS c, quote(42) AS d, quote(1.0) AS e, quote(1e100) AS f;
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| 'it''s' | X'0AFF' | NULL | 42 | 1.0 | 1.0e+100 |

The `NULL` in column `c` is the four-letter text `'NULL'`, not an SQL NULL.

## Formatting

### printf {#printf}

```
printf(FORMAT, ARG, …)
format(FORMAT, ARG, …)
```

`format` is another name for `printf`. Returns `FORMAT` with each `%` conversion replaced by the next argument, formatted as in C `printf`. If `FORMAT` is NULL, the result is NULL. A missing argument counts as NULL (0 for numbers, empty for strings); extra arguments are ignored.

A conversion is `%[flags][width][.precision]type`. `width` and `precision` may be `*` to take them from the next argument. Length modifiers (`l`, `ll`, `h`) are accepted and ignored.

| Type | Output |
| --- | --- |
| `d`, `i` | Signed integer. |
| `u` | Integer (see the note below). |
| `f` | Fixed-point decimal; precision is the digits after the point (default 6). |
| `e`, `E` | Exponent form, e.g. `1.23e+03`. |
| `g`, `G` | `%e` or `%f`, whichever is shorter; precision is significant digits. |
| `x`, `X`, `o` | Hexadecimal (lower or upper case) or octal, of the value as an unsigned 64-bit integer. |
| `c` | The first character of the argument's text. |
| `s`, `z` | The argument as text; precision limits the number of characters. NULL gives an empty string. |
| `q` | The text with single quotes doubled. NULL gives `(NULL)`. |
| `Q` | Like `q`, wrapped in single quotes. NULL gives `NULL` without quotes. |
| `w` | The text with double quotes doubled (for identifiers). NULL gives `(NULL)`. |
| `%` | A literal `%`. |

| Flag | Effect |
| --- | --- |
| `-` | Left-align within the width. |
| `+` | Always print a sign for numbers. |
| space | Print a space in place of a `+` sign. |
| `0` | Pad numbers with zeros to the width. |
| `,` | Thousands separators for `%d` / `%i` / `%u`. |
| `#` | For `%g` / `%G`, keep trailing zeros. |
| `!` | Accepted and ignored. |

```sql
SELECT printf('%d|%5d|%-5d|%05d|%+d|%,d', 42, 42, 42, 42, 42, 1234567) AS ints;
```

| ints |
| --- |
| 42\|   42\|42   \|00042\|+42\|1,234,567 |

```sql
SELECT printf('%.2f', 3.14159) AS a, printf('%e', 31415.9) AS b, printf('%g', 0.0001) AS c, printf('%x', 255) AS d, printf('%.3s', 'hello') AS e;
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 3.14 | 3.141590e+04 | 0.0001 | ff | hel |

`%q` and `%Q` build SQL text safely:

```sql
SELECT printf('SELECT * FROM t WHERE name = %Q', 'O''Brien') AS sql;
```

| sql |
| --- |
| SELECT * FROM t WHERE name = 'O''Brien' |

::: warning Differs from SQLite
- `%g` and `%G` keep trailing zeros in exponent form: `printf('%g', 1000000)` is `'1.00000e+06'` (SQLite: `'1e+06'`).
- `%u` prints negative numbers with a minus sign (SQLite prints them as unsigned 64-bit values).
- An unknown conversion such as `%y` is copied to the output (SQLite stops formatting there).
:::
