---
description: 'Text with the first match of a regular expression replaced.'
---

# regex_replace

```ebnf
regex_replace ::= '"fn": "regex_replace"' ', "args": [' TEXT ',' PATTERN ',' REPLACEMENT (',' FLAGS)? ']'
```

`TEXT` with the first match of `PATTERN` replaced by `REPLACEMENT`. In `REPLACEMENT`, `$1` to `$99` stand for the
groups of the match, `$<name>` for a named group, `$&` for the whole match, and `$$` for a `$`, as in JavaScript's
`String.prototype.replace`.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. |
| `PATTERN` | `text` | The regular expression. |
| `REPLACEMENT` | `text` | What goes in place of the match. |
| `FLAGS` | `text` | Optional: the flags, among `i`, `m` and `s`. |

## Returns

`text`. NULL when `TEXT`, `PATTERN` or `REPLACEMENT` is NULL. `TEXT` as it is when the pattern doesn't match.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `PATTERN` is not a valid regular expression, or `FLAGS` has a letter other than `i`, `m` and `s`, or one twice. |

## Notes

- `PATTERN` is a JavaScript regular expression in Unicode mode: `.` matches a whole code point (an emoji too), `\p{L}`
  matches a letter, and an escape that means nothing (`\-` outside a set) is an error.
- `FLAGS` is text of the letters `i` (ignore case), `m` (`^` and `$` match at line breaks too) and `s` (`.` matches a
  line break too), in any order, each at most once. NULL or the empty text means none.
- [`regex_replace_all`](./regex_replace_all) replaces every match.
- A pattern or flags that are wrong fail when a row reaches the call, not when the plan is compiled.
- The text is taken as its text when it is a number; a real that is a whole number is written without `.0` (`3`, where
  [`concat`](./concat) writes `3.0`).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "regex_replace", "args": [
        {"k": "lit", "value": "a-b-c", "type": "text"},
        {"k": "lit", "value": "-", "type": "text"},
        {"k": "lit", "value": "+", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "regex_replace", "args": [
        {"k": "lit", "value": "John Smith", "type": "text"},
        {"k": "lit", "value": "(\\w+) (\\w+)", "type": "text"},
        {"k": "lit", "value": "$2, $1", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "regex_replace", "args": [
        {"k": "lit", "value": "abc", "type": "text"},
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": "[$&]", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "regex_replace", "args": [
        {"k": "lit", "value": "aBAb", "type": "text"},
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": "_", "type": "text"},
        {"k": "lit", "value": "i", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "regex_replace", "args": [
        {"k": "lit", "value": "abc", "type": "text"},
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "first"}, {"name": "groups"}, {"name": "whole"}, {"name": "ignore_case"}, {"name": "null"}]
}
```

| first | groups | whole | ignore_case | null |
|---|---|---|---|---|
| a+b-c | Smith, John | a[b]c | a_Ab | NULL |

A flag other than `i`, `m` and `s` is an error:

<!-- docs:error SMALT_ERROR -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[
      {"k": "call", "fn": "regex_replace", "args": [
        {"k": "lit", "value": "abc", "type": "text"},
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": "x", "type": "text"},
        {"k": "lit", "value": "g", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "bad_flags"}]
}
```

## Demo

Each fruit's name with its first vowel in brackets:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1]},
    "exprs": [
      {"k": "call", "fn": "regex_replace", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "[aeiou]", "type": "text"},
        {"k": "lit", "value": "($&)", "type": "text"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| (a)pple |
| p(e)ar |
| pl(u)m |
| ch(e)rry |
| l(i)me |

## See also

- [`regex_replace_all`](./regex_replace_all), [`replace`](./replace), [`regex_find`](./regex_find)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
