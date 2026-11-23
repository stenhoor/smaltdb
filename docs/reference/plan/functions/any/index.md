---
description: 'Functions of values under any: a value''s type, and its truth value, list or map read back.'
---

# Values under any functions

A value under `any` keeps its type ([ADR 0039](../../../../adr/0039-typed-values-under-any.md)): a `bool`, list,
struct or map that becomes an element of a `list<any>` or a value of a `map<text, any>` (from `list_of` or `map_of`
of mixed types, or a `map<text, any>` column) is a typed value, never equal to the integer `1` or to a blob. These
functions read such a value: its type, and the value back as its own type. They take one argument of any value and
raise no errors; a value that isn't of the kind asked for gives NULL. Give them a value typed `any`: a value whose
type the plan knows (an expression typed `bool` or `list<int>`) reaches them as the engine holds that type, an
integer or a blob, and isn't read as a typed value.

## Functions {#functions}

- [`any_type`](./any_type): The type of a value under `any`, as text.
- [`any_bool`](./any_bool): A value under `any` as a `bool` when it is one, else NULL.
- [`any_list`](./any_list): A list under `any` as a `list<any>`, else NULL.
- [`any_map`](./any_map): A map under `any`, or a struct by field name, as a `map<text, any>`, else NULL.
