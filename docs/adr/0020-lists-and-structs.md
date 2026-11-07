# ADR 0020: Lists and structs

- **Status:** accepted with the owner's decisions of 2026-11-07 (at the end: each as recommended); implemented, steps
  1–6: smaltdb #161, #163, #165, #166, smaltdb-parquet #8, smaltql #25, smaltdf #22
- **Date:** 2026-11-07
- **Builds on:** [ADR 0016](0016-plan-api-for-every-language.md) section 3 (types), item 4 and section 4 (`explode`);
  [ADR 0018](0018-bool-and-nan.md) and [ADR 0019](0019-dates-and-times.md) (the pattern: a static type over values the
  engine already has, a storage type, results converted at the boundary)

## Context

ADR 0016 section 3 lists `list` and `struct` as the last group of types, then `explode`. This record proposes them.
The engine was surveyed for it on `main` (`01ba9e0`).

**What exists today.**
- **Values** are `null`, numbers, bigints, text and `Uint8Array` blobs (`values.ts`, `SqlValue`). Records, index keys,
  columnar chunks, the plan codec and the worker protocol handle exactly these.
- **The index-key encoding** (`storage/key-codec.ts`, format 2, ADR 0006) turns values into bytes whose byte order is
  SQLite's value order. Each component is prefix-free and starts with a tag that is never `0x00`.
- **Nested Parquet columns** (lists, structs, maps) are JSON text (`@smaltdb/parquet`). SQL has no JSON functions yet
  (smaltql lists SQLite's as not available), so SQL can show them, compare them as text and `LIKE` them, no more.
- **smaltdf** has no nested types and no `explode`; its reference defers them to this step.

**What a dataframe language needs.** Polars has:
- `List(inner)`: a variable-length list of one type, nested to any depth;
- `Array(inner, n)`: fixed length (rarer);
- `Struct(fields)`: named fields, each of its own type;
- the `list` functions (`len`, `get`, `contains`, `sum`, `join`, `sort`, `unique`, `eval`), the `struct` functions
  (`field`, `rename_fields`), `implode` (a group's values as a list), and `explode` / `unnest` on frames.
- Lists compare and sort element by element; structs field by field.

**The pattern of ADRs 0018 and 0019.** A type the engine knows statically, whose run-time values are values it already
handles, needs nothing new in operations, keys, records, columnar chunks or the protocol. Results turn values into
what the type means at the boundary.

## Proposal

### 1. Values: encoded bytes under a static type

A list or struct value is a **blob** at run time: its elements (a struct's fields, in their declared order) encoded
as index-key components, one after another (`encodeKey`).

| Value | Bytes |
|---|---|
| `[1, 2]` | number(1) number(2) |
| `[]` | no bytes |
| `[1, null]` | number(1) null |
| `{a: 1, b: 'x'}` | number(1) text('x') |
| `[[1], []]` | blob(number(1)) blob(): a nested value is a blob component, escaped as blobs are (`00` → `00 FF`, end `00 00`) |

- **Order and equality come free.** Components are prefix-free, so the byte order of these blobs is element-by-element
  order with a shorter list first (`[1] < [1, 2] < [2]`), which is Polars' order. Equal values have equal bytes, so grouping, `unique`, joins on
  lists, hash tables and index keys work unchanged.
- **The type says what the bytes are.** `list<int>` and `struct<a int, b text>` are plan types. A value read without its
  type (in an `any` column) is a blob.
- **Elements** are any engine value, NULL included, and nested lists and structs. Text inside a list is compared by
  its bytes (BINARY); a collation applies to text values, not to text in lists.

### 2. Types

- **Plan types** gain two parameterized forms, written as text so plans stay JSON and the simple types stay strings:
  `list<T>` and `struct<name T, …>`, nested to any depth (`list<struct<x real, y real>>`). The plan validator parses
  and checks them. The codegen and planner keep treating them as blobs, so nothing else in them changes.
- **Storage types** `LIST` and `STRUCT`, kept as blobs, with the full type in the column's definition. They join format
  4, which is still unreleased.
- **The catalog** gives a column's full type (`list<int>`).

### 3. Results

| Who | Gets |
|---|---|
| The engine and client, by default | JS arrays and plain objects, elements converted as their types are (a `date` element as its text, a `bool` as `true` / `false`) |
| smaltdf `collect` | the same |
| SQL (smaltql) | JSON text (`[1,2]`, `{"a":1,"b":"x"}`), what SQL sees of Parquet's nested columns today |

- **Wire:** results travel as the blobs; the client converts them from the column types, as it does dates.
- **Values in:** values from columns (ADR 0016 step 10) and parameters take JS arrays and plain objects where the
  type is a list or struct, and encode them.

### 4. Operations

Named by behaviour, as the engine's operations are (ADR 0016 section 1):

- **Build:** `list_of(a, b, …)`, `struct_of(a, b, …)` (the struct's names come from the call's type).
- **Lists:** `list_len`, `list_get` (from 0; negative from the end; out of range is NULL), `list_contains`,
  `list_slice`, `list_concat`, `list_join` (text), `list_sort`, `list_unique`, `list_reverse`, and the reductions
  `list_sum`, `list_min`, `list_max`, `list_mean`.
- **Structs:** `struct_field(value, index)` (the language resolves names to indexes from the type).
- **Aggregate:** `implode`: a group's values as a list, in the group's order (ADR 0016 section 2).
- **Plan operation `explode`:** one row per element of a list column, the row's other columns repeated. As Polars
  2's `explode`, an empty list gives no row and a NULL list one row with NULL, with options for the other choices
  (`emptyAsNull`, `keepNulls`). Optionally with the element's position.
- **Unnest** needs no operation: it is a projection of `struct_field`s, which a language writes.
- **Casts:** `cast_text` of a list or struct gives its JSON text.

### 5. Data in

- **Parquet:** nested columns become `list` and `struct` columns (a `map` becomes a `list<struct<key K, value V>>`, as
  in Arrow). Their SQL text stays the JSON it is today.
- **JSON** (`@smaltdb/io`): arrays and objects stay JSON text unless a column is declared as a list or struct.

### 6. SQL (smaltql)

SQL has no list type. smaltql reads a list or struct column as its JSON text (`cast_text`), as ADR 0019 does for dates:
results and text functions see what they see today, and SQLite's JSON functions, if smaltql adds them, would work on it. Comparisons of a list column with a list column
stay on the values.

### 7. smaltdf

- **Types:** `list<T>` and `struct<…>` columns; `frame({ tags: [['a'], ['b', 'c']] })` makes a `list<text>`.
- **Expressions:** `col(…).list.len()` and the rest of section 4, `col(…).struct.field(name)`, `implode()`.
- **Frames:** `explode(columns)` and `unnest(column)`.
- **Polars:** the comparison tests gain the `list` and `struct` functions and `explode`.

## Order of work

One PR each, after this ADR:

1. The types: plan types, the encoding, storage types (format 4), results and values in.
2. The operations: building, the `list_*` and `struct_field` operations, `implode`.
3. `explode`.
4. Parquet gives `list` and `struct` columns (`stenhoor/smaltdb-parquet`).
5. smaltql: list and struct columns as JSON text.
6. smaltdf: the types, `list` / `struct` methods, `explode`, `unnest`, and the comparison tests.

## Owner's decisions (2026-11-07)

Each as recommended. The questions as they were put, with the recommendation taken:

1. **Representation.**
   - **Recommendation:** encoded bytes under a static type (section 1). Order, equality, hashing, keys, records, the
     columnar store and the protocol need nothing new.
   - **Alternative:** a new run-time value kind (JS arrays and objects) in `SqlValue`. Results need no decoding, but
     comparison, hashing, records, keys, columnar chunks, codegen and the protocol all change, and every operation
     must handle it.
2. **Type syntax.**
   - **Recommendation:** text forms (`list<int>`, `struct<a int, b text>`), parsed where needed, so plan types stay
     strings and JSON.
   - **Alternative:** object types (`{ list: 'int' }`). Clearer to build, but every `type === 'int'` check in the
     engine and the languages would have to handle objects.
3. **What SQL sees.**
   - **Recommendation:** JSON text, as SQL sees Parquet's nested columns today.
   - **Alternative:** blobs. Exact, but unreadable, and Parquet's nested columns would stop reading as text in SQL.
4. **Fixed-length arrays (Polars `Array`).**
   - **Recommendation:** not now: a `list` serves, and a fixed length can be added as a check later.
   - **Alternative:** an `array<T, n>` type now.
5. **Maps.**
   - **Recommendation:** a map is a `list<struct<key K, value V>>`, as Arrow and Parquet store it, with no map type.
   - **Alternative:** a `map<K, V>` type with key lookup.
