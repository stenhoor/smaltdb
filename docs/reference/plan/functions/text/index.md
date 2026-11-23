---
description: 'Case, trimming, searching, slicing, formatting, patterns and regular expressions.'
---

# Text functions

The text functions work on text: its case, length, parts, patterns and formatting. They share these rules:

- **Characters are code points.** Lengths, positions and single-character wildcards count Unicode code points, so an
  emoji is one character: [`length`](./length), [`substr`](./substr), [`instr`](./instr), `_` in
  [`like`](./like) and `.` in a regular expression. [`octet_length`](./octet_length) counts UTF-8 bytes.
- **Numbers are taken as their text**, as SQLite writes them: an integer as its digits, a real with at least one
  decimal (`2.0`), and in exponent form when it is large or small (`1.0e+20`). So `length` of the real `100.0`
  is 5. The regular expression functions are the exception: they write a whole real without `.0`.
- **Blobs are bytes.** `length`, `octet_length`, `substr`, `instr`, `contains`, `starts_with` and
  `ends_with` count and compare the bytes of a blob, and compare a text with a blob by its UTF-8 bytes; `hex` and
  `quote` write its bytes. The other functions read a blob's bytes as UTF-8 text.
- **Other types are not converted.** A list, struct, map, date or time is read in its stored form, not as its text:
  convert it first with [`cast_text`](../conversion/cast_text).
- **Case and collations.** Text compares exactly, case-sensitively, whatever the call's `collation`. The exceptions
  are [`like`](./like), which ignores the case of ASCII letters, and the regular expressions with the flag `i`.
  [`upper`](./upper) and [`lower`](./lower) map ASCII letters only; [`upper_unicode`](./upper_unicode) and
  [`lower_unicode`](./lower_unicode) map every script.
- **NULL in, NULL out**, with these exceptions: [`concat`](./concat) and [`concat_ws`](./concat_ws) skip NULL
  values, [`char`](./char) takes NULL as 0, [`hex`](./hex), [`quote`](./quote) and [`zeroblob`](./zeroblob)
  give a value for NULL, and NULL flags of a regular expression mean none.
- **Errors** are few: a `like` or `glob` escape that is not one character, and a regular expression or flags that are
  wrong (`SMALT_ERROR`, when a row reaches the call).

[`text_concat`](./text_concat), [`like`](./like) and [`glob`](./glob) are operations, SQL's `||`, `LIKE` and
`GLOB`; the others are named functions, most with SQLite's behaviour.

## Functions {#functions}

- [`upper`](./upper): Text with its ASCII letters in upper case.
- [`lower`](./lower): Text with its ASCII letters in lower case.
- [`upper_unicode`](./upper_unicode): Text in upper case, in every script.
- [`lower_unicode`](./lower_unicode): Text in lower case, in every script.
- [`length`](./length): The number of characters in a text, or of bytes in a blob.
- [`octet_length`](./octet_length): The number of bytes in a value: a text's UTF-8 bytes, or a blob's.
- [`concat`](./concat): The text of its arguments joined, skipping NULLs.
- [`concat_ws`](./concat_ws): The text of its arguments joined with a separator, skipping NULLs.
- [`text_concat`](./text_concat): Two values joined as text; NULL when either is NULL.
- [`trim`](./trim): Text with given characters, by default spaces, removed from both ends.
- [`ltrim`](./ltrim): Text with given characters, by default spaces, removed from the start.
- [`rtrim`](./rtrim): Text with given characters, by default spaces, removed from the end.
- [`substr`, `substring`](./substr): Part of a text, by character positions, or of a blob, by byte positions.
- [`instr`](./instr): Where a text first occurs in another, counting characters from 1.
- [`contains`](./contains): Whether a text contains another.
- [`starts_with`](./starts_with): Whether a text starts with another.
- [`ends_with`](./ends_with): Whether a text ends with another.
- [`replace`](./replace): Text with every occurrence of one text replaced by another.
- [`split`](./split): A text cut at each occurrence of a separator, as a list of texts.
- [`format`, `printf`](./printf): Text made from a format and values, as SQLite's printf writes it.
- [`char`](./char): Text made of the characters with the given code points.
- [`unicode`](./unicode): The code point of a text's first character.
- [`hex`](./hex): The bytes of a value as upper-case hexadecimal text.
- [`quote`](./quote): A value as a SQL literal: quoted text, a blob literal, a number or NULL.
- [`zeroblob`](./zeroblob): A blob of a given number of zero bytes.
- [`like`](./like): Whether a text matches a LIKE pattern, ignoring the case of ASCII letters.
- [`glob`](./glob): Whether a text matches a GLOB pattern, case-sensitively.
- [`regex_match`](./regex_match): Whether a regular expression matches somewhere in a text.
- [`regex_find`](./regex_find): The first match of a regular expression in a text.
- [`regex_replace`](./regex_replace): Text with the first match of a regular expression replaced.
- [`regex_replace_all`](./regex_replace_all): Text with every match of a regular expression replaced.
