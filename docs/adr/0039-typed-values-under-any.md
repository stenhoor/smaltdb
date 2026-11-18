# ADR 0039: Typed values under `any`

- **Status:** accepted (owner, 2026-11-18: fix it in smaltdb, rather than in smaltcy or by leaving booleans and lists
  out). Step 1 is done.
- **Date:** 2026-11-18
- **Amends:** [ADR 0038](0038-map-type.md), section 1 ("Values are any engine value … and nested lists, structs and
  maps"), which the engine didn't do under `any`; [ADR 0020](0020-lists-and-structs.md) for `list<any>`.
- **Needed by:** [ADR 0033](0033-property-graphs-and-history.md) step 8: Cypher's properties live in a
  `map<text, any>`, and Cypher properties are often booleans and lists.

## Context

A value whose static type is `any` is a run-time `SqlValue` (`null | number | bigint | string | Uint8Array`,
`engine/values.ts`). A `bool` is an integer 0 or 1 known as `bool` only by its static type (ADR 0018), and a list,
struct or map is bytes known by theirs (ADR 0020, ADR 0038). Under `any` there is no static type, so before this
record:

| Given to a `map<text, any>` | Read back with `map_get` (smaltdb `10fd480`, measured 2026-11-18) |
|---|---|
| `true` | `1` (`typeof` says `integer`) |
| `list_of(1, 2)` | the list's bytes as a blob (`{"0":70,"1":0,"2":71,"3":0}` in a result) |
| a map or struct | its bytes as a blob |

A Cypher property `active: true` would come back as `1`, `true = 1` would hold, and `tags: ['a', 'b']` would be a blob.
ADR 0033 decision 13 keeps Cypher's meanings in smaltcy's compiler, but the compiler can't keep what storage loses, and
JSON in SQL or a dataframe's object column would lose the same.

## Decision

### 1. A typed value

A **typed value** is a `Uint8Array` that carries a type: `class TypedValue extends Uint8Array { type }` in
`engine/values.ts`. Its `type` is `bool` (one byte, 0 or 1) or a list, struct or map type (its bytes). It is part of
`SqlValue` without changing the union: to code that doesn't look for it, it is a blob, so every operator, record, key
and the worker's wire carry it unchanged. The code that must keep its type looks for it:

- **Made** where a `bool` or a nested value goes into an `any` place: `list_of` and `map_of` whose elements are of
  different types (so `any`), `map_merge` of maps of different types, and a JavaScript `true` / `false`, array or
  object given as an element of a `list<any>` or a value of a `map<text, any>` (values in, as `fromColumns` takes
  them). Elements of one type stay plain: `list_of(true, false)` is a `list<bool>`.
- **Kept** by the key codec, records, columnar chunks, comparisons, hashing and `cast_text`.
- **Given** in results as JavaScript: `true` / `false`, or an array or object as its type decodes; through the worker
  it crosses as that JavaScript value.

A top-level parameter stays as it was (a JavaScript `true` is 1): SQL compares `? = 1` and bool columns with it. A
language that wants a parameter's kind kept converts it in its `parameter` hook; `smaltdb/language` exports
`TypedValue`, `typedBool`, `encodeNested`, `typedResult` and `anyResult` for that.

### 2. Encoding

| Where | Form |
|---|---|
| Key component (nested values, index keys) | tag `0xB0`, the type's UTF-8 escaped as text is, `00 00`, the bytes escaped as a blob's are, `00 00`. Sorts after blobs: by type, then by bytes |
| Record, an ANY column | tag `5`, the type's UTF-8, `00`, the bytes |
| Columnar chunk, the tagged encoding | tag `5`, u32 length and the type's UTF-8, u32 length and the bytes |

Plain values encode as before, so existing files, indexes and nested values read unchanged. The tags join format 4,
which is unreleased (`docs/STORAGE_FORMAT.md`).

### 3. Order, equality, grouping

`compareValues` ranks NULL < numbers < text < blobs < typed values, typed values by type name, then by bytes: the order
of the key encoding, so sorts, indexes and `DISTINCT` agree. A typed value never equals a plain value: `true`, `1` and
`x'01'` are three groups. `hashKey` keeps typed values apart from blobs. Where a condition is tested, a typed `bool` is
its truth value. A language whose order differs (Cypher orders booleans before numbers) orders by its own rules in its
compiler, as ADR 0033 decision 13 says.

### 4. Functions

| Function | Gives |
|---|---|
| `any_type(x)` | the type as text: `null`, `int`, `real`, `text`, `blob`, `bool`, or the list, struct or map type |
| `any_bool(x)` | `x` as a `bool` when it is one, else NULL |
| `any_list(x)` | a list as a `list<any>`, its elements typed where their type says, else NULL |
| `any_map(x)` | a map, or a struct by field name, as a `map<text, any>`, else NULL |

These give a typed value back a static type, so the list and map operations, which check their argument's type, take it.

## Options considered

1. **smaltcy encodes booleans and lists itself** (tagged text in the map). SQL and every other language would see the
   encoding. Rejected by the owner.
2. **A new run-time kind** (`{ type, value }` objects). Every `typeof` switch in the engine would need a case;
   operators, code generation and the wire would all change. The `Uint8Array` subclass needs changes only where the
   type must be kept.
3. **A marker byte inside blobs.** Rejected: any byte prefix is also a valid blob.
4. **Typed values everywhere** (every value carries its type). Rejected: it would slow every operator for nothing that
   typed columns need.

## Steps

1. **Done:** the typed value, the encodings, order and hashing, the builders, values in and results (in process and
   through the worker), `cast_text`, the `any_*` functions (`test/typed-any.test.ts`).
2. smaltcy step 8 stores every Cypher property in its `map<text, any>`; smaltql may then name the `any_*` functions.

Not yet typed under `any`: dates, times and durations (they are numbers there, as before), and values a `CASE` or
`coalesce` of mixed types gives. Each can follow the same way when a language needs it.

## Consequences

- Cypher properties, JSON values and dataframe objects keep their kind under `any`, in every language.
- A blob-handling function given a typed value treats it as its bytes (`length`, `hex`); only the code above knows the
  type. Arithmetic on a typed value is arithmetic on a blob, as SQLite's is.
- Files with typed values need format 4's new tags; older pre-release files read unchanged.
