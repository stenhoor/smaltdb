# ADR 0038: A map type

- **Status:** accepted in principle (owner, 2026-11-17: "a general map type" for every language, with text keys).
  Sections 1–5 are the proposed design, settled in the pull requests of the steps that build it. Step 1 is done
  (the type, the encoding, `MAP` storage, results and values in).
- **Date:** 2026-11-17
- **Amends:** [ADR 0020](0020-lists-and-structs.md), decision 5, which chose `list<struct<key K, value V>>` instead of a
  map type. Maps stored that way stay valid.
- **Builds on:** ADR 0020 (lists and structs: a static type over encoded bytes, storage types in format 4),
  [ADR 0016](0016-plan-api-for-every-language.md) (plan types and operations named by behaviour),
  [ADR 0031](0031-processing-lists-and-structs.md) (functions of one list, `each`)
- **Needed by:** [ADR 0033](0033-property-graphs-and-history.md), decision 15: a property graph's catch-all column for
  properties that aren't declared is a `map<text, any>`

## Context

ADR 0020 decided (owner, 2026-11-07, decision 5) that a map is a `list<struct<key K, value V>>`, as Arrow and Parquet
store one, with no map type. ADR 0033 first followed it for the property graph's catch-all column. In the interview of
2026-11-17 the owner chose a general map type instead, for every language, with text keys.

Cypher needs maps directly. Property maps are `{name: 'Ada', born: 1815}`, `SET n += {…}` merges maps and `n.name` reads
a key. smaltdf (Polars' structs), smaltts and SQL's JSON functions, if smaltql adds them, read the same values.

## Decision

### 1. Values: encoded bytes under a static type

A map follows ADR 0020's pattern. Its run-time value is a blob holding its entries, **sorted by key** (the key's UTF-8
bytes, BINARY), each key appearing once. Each entry is encoded as index-key components: the key as text, then the
value.

- **Equality and order come free.** Equal maps have equal bytes, so grouping, `DISTINCT`, joins, hashing and index keys
  work unchanged. Maps order entry by entry, by key then value.
- **Values** are any engine value, NULL included, and nested lists, structs and maps.
- **No new run-time value kind and no new record tag.** Records, columnar chunks, the protocol and code generation see
  a blob, as they do for lists and structs.

### 2. Types

- A plan type `map<text, V>`, written as text like `list<T>` (`map<text, any>`, `map<text, int>`). Keys are text only
  (owner, 2026-11-17).
- A `MAP` storage type beside `LIST` and `STRUCT`, with the full type in the column's definition. It joins format 4,
  which is unreleased (`docs/STORAGE_FORMAT.md`). After release, an older engine that meets a `MAP` column is refused by
  ADR 0033 step 0's required-features check.

### 3. Results and values in

| Who | Gets |
|---|---|
| The engine and client | Plain JS objects, values converted as their types are |
| SQL (smaltql) | JSON object text, as lists and structs are JSON text there (ADR 0020 section 6) |
| smaltdf, smaltts | Plain objects, with `map` methods in their own APIs |
| smaltcy | Cypher maps |

Values from columns and parameters take plain objects where the type is a map, and encode them in key order.

### 4. Operations

Named by behaviour, as the engine's are:
- **Build:** `map_of(k1, v1, k2, v2, …)` (a repeated key: the last wins), `map_from_entries(list<struct<key, value>>)`.
- **Read:** `map_get(m, key)` (a missing key is NULL), `map_contains_key`, `map_len`, `map_keys` (`list<text>`, in key
  order), `map_values`, `map_entries` (`list<struct<key text, value V>>`, which converts to ADR 0020's form).
- **Change:** `map_merge(a, b)` (b's entries win: Cypher's `SET n += map`), `map_remove(m, keys)`.
- **Casts:** `cast_text` gives JSON object text.
- **Indexes:** an expression index on `map_get(props, 'key')` indexes one key, using the expression indexes that exist.

A NULL value under a key is kept: the map `{a: null}` has one entry. Cypher's rule that setting a property to null
removes it is the compiler's job in smaltcy, not the type's.

### 5. Compatibility

- **ADR 0020's maps stay valid.** A `list<struct<key, value>>` keeps working, and converts with `map_from_entries` and
  `map_entries`. Parquet maps stay lists of structs until a later change maps text-keyed ones to `map<text, V>` in
  `@smaltdb/parquet`.
- **Nothing changes for tables without map columns.** Existing types, comparisons, sort orders and results are as
  before.
- **Plans:** a new type form and new operations, added the way ADR 0020's were, with no `PLAN_FORMAT_VERSION` change.

## Steps

One pull request each:

1. The engine: the `map<text, V>` type, the encoding, the `MAP` storage type, results and values in.
2. The operations of section 4.
3. smaltql: map columns as JSON text, and building maps where SQL can.
4. smaltdf: `map` methods and comparison tests.
5. `@smaltdb/parquet`: text-keyed Parquet maps as `map<text, V>` (optional).

## Consequences

- Graph properties, JSON objects and dataframe maps have one type in every language.
- The type follows ADR 0020's pattern, so the cost is in functions and conversions, not in storage, records or the
  executor.
- Two ways to hold a map exist (`map<text, V>`, and ADR 0020's lists of structs), with conversions between them.
