# ADR 0018: `bool` and NaN

- **Status:** accepted (#142), with the owner's decisions of 2026-11-07 (below)
- **Date:** 2026-11-07
- **Builds on:** [ADR 0016](0016-plan-api-for-every-language.md) section 3 (types) and step 11, owner's decision 4
  (`bool` goes with a file-format change)

## Context

ADR 0016 section 3 orders the new types: `bool` and NaN first, then dates and times, then lists and structs. Each
gets its own record before it lands. This one covers the first two. The engine was surveyed for it on `main`
(`2d0b0cc`).

**`bool` does not exist anywhere yet.**
- Plan types are `int`, `real`, `num`, `text`, `blob`, `null` and `any` (`exec/convert.ts`).
- Every comparison and logic operation is typed `int` and returns 0 / 1: `cmp_eq` … `cmp_is_not`, `truth_not`,
  `like`, `glob`, `in_list`, `regex_match`, and the `and` / `or` / `not` / `isNull` nodes (`typeOf` gives `int`).
- Parameters already accept JS booleans and turn them into 1 / 0.
- smaltdf types its comparisons as `bool` itself and turns 0 / 1 into `true` / `false` when it collects (its
  decision C). A `bool` column it writes reads back as `int`.

**NaN is stored but not kept.**
- A REAL value is written as a raw float64 in row records, in tagged ANY / NUMERIC values, in columnar F64 chunks and
  on the worker protocol, so NaN survives storage today.
- It is lost almost everywhere else:
  - Index keys write NaN as NULL (`storage/key-codec.ts`: "NaN is NULL").
  - Columns of values from JavaScript read NaN as NULL (`ValueColumn`).
  - Parameters turn NaN into NULL.
  - The float operations and aggregates turn a NaN result into NULL: `div_float`, `div_floor`, `mod_floor`, the
    arithmetic, the math functions, `sum`, `total`, `avg` and the statistical aggregates.
- `compareValues` gives 0 for NaN against any number, so NaN is "equal" to everything in sorts.
- Zone maps skip NaN, because they compare with `<` and `>`.
- ADR 0016 recorded the inconsistency: `lit(NaN)` gives NaN, while `div_float(0.0, 0.0)` gives NULL.

**The file format.**
- The published smaltdb 0.8.3 uses format 3.
- Format 4.0 (stored definitions instead of SQL text, ADR 0015 step 7: #88 and step 7b) is on `main` and has never
  been released.
- Owner's decision 4 of ADR 0016 groups `bool` with the next format change. Format 4 is that change while it is
  unreleased.

**SQL's operation names are gone.** The `sql.*` aliases of ADR 0016 section 1 are removed (stenhoor/smaltql#17 and
the smaltdb PR after it). Every language calls the same `cmp_eq`, so what SQL needs from a comparison (0 / 1) can't
come from a separate name.

## Decision

### 1. `bool` is a static type; its values are 0 and 1

`bool` is a plan type and a storage type. While a plan runs, a `bool` value is the number 0 or 1, as now. The engine
knows a value is a `bool` from its static type. It already tracks whether an integral number is REAL the same way
(`exec/convert.ts`).

- **Operations.**
  - Comparisons (`cmp_*`) and the logic nodes (`and`, `or`, `not`, `isNull`) give `bool`.
  - So do `truth_not`, `like`, `glob`, `in_list`, `regex_match` and `inSubquery`.
  - `min`, `max`, `first`, `last` and the navigation window functions of a `bool` give `bool`.
  - `sum` of a `bool` counts the true values (`int`).
- **A language may type a `bool` as `int`.**
  - A `call`'s declared `type` may be `int` where the operation gives `bool`, because the values are the same.
  - The logic nodes take an optional `type` (`bool` by default, or `int`).
  - This is how SQL keeps 0 / 1 at no run-time cost: smaltql declares its comparisons and logic `int`.
  - The validator accepts `bool` or `int` there and nothing else.
- **Predicates.** `filter`, join conditions, `case` and CHECK take `bool`, `int`, `null` or `any`, as they take
  `int` now.
- **Literals.** A `bool` literal is `{ k: 'lit', value: 1, type: 'bool' }`. Literal values stay `SqlValue`, so the
  plan codec doesn't change.
- **Results.** A result column typed `bool` gives `true` / `false` (and `null`):
  - in process, when the engine builds the result rows;
  - through the worker, in the client from the column types the protocol already carries (the wire stays f64).

  A result value can be a `boolean` from here on, in results only.
- **Values from columns.** A column of JS booleans, or a `Uint8Array` given with type `bool`, is a `bool` column.
- **Mixing.** A set operation or `case` that mixes `bool` and `int` gives `int`. Mixing `bool` with anything else
  gives `any`, as other mixed types do now.

**Storage type `BOOLEAN`.**
- A `ColumnDef` may say `type: 'BOOLEAN'`. Its plan type is `bool`.
- Its values are stored as INTEGER values are: fixed int64 in rows, and the integer encodings in columnar chunks and
  index keys.
- Writing into it accepts 0, 1 and NULL; any other value is an error (`SMALT_MISMATCH`).
- A `bool` written to an `ANY` or `NUMERIC` column is stored as an integer and reads back as `int`. A value carries
  no type of its own: this is the cost of the static representation, and is documented.
- smaltql's declared-type mapping (`BOOLEAN` → NUMERIC, as in SQLite) doesn't change. `BOOLEAN` storage is for tables
  defined as plans, such as smaltdf's `createTable`.

### 2. NaN is a value of `real`, in a total order

`real` holds NaN, distinct from NULL. Everything that orders or matches values uses one total order:

- NaN equals NaN, and sorts after every number, including Infinity, and before text.
- Sorts, `distinct`, grouping, joins on equal keys, `in_list`, index keys and the comparisons (`cmp_*`) all follow
  it. NaN rows group together and join each other, and `cmp_eq(NaN, NaN)` is true. Polars behaves the same way, so
  smaltdf matches it.
- `compareNumeric` and `compareValues` implement the order.
- The key codec gives NaN its own tag, after the largest number tag, instead of NULL's.
- Zone maps keep NaN as the maximum, and pruning compares in the same order.

Where NaN is kept:

- **Storage** keeps it, as now, and index keys now keep it too.
- **Values from columns.** NaN in a float array is NaN. NULL comes from the null bitmap (`ValueColumn.nulls`) or a
  null in an array of values.
- **Parameters** keep NaN. A language that wants NULL converts its own parameters. *(Moved to step 6 when step 2
  was done: the engine binds SQL text's parameters itself today, with no language hook, so keeping NaN there before
  smaltql converts would change SQL's results. Step 6 adds the hook and the change together.)*
- **Operations whose behaviour is IEEE keep a NaN result:**
  - `div_float`, `div_floor`, `mod_floor`, and `add_checked` / `sub_checked` / `mul_checked` on reals;
  - `cast_real` / `cast_real_strict` of a NaN;
  - two new aggregates, `sum_float` and `avg_float`, for languages that want NaN to propagate. `sum` and `avg` keep
    SQLite's behaviour.
- **Operations whose behaviour is SQLite's keep turning a NaN result into NULL:**
  - `add`, `sub`, `mul`, `div_trunc`, `mod_trunc`;
  - the math functions;
  - `sum`, `total`, `avg` and the statistical aggregates.

  These are the names SQL calls, so SQL's results don't change for SQL's own data.
- **NaN read by SQL.** A NaN another language stored can reach a SQL query. How SQL shows it is smaltql's decision;
  the engine does not turn it into NULL behind a language's back. The recommendation is NULL at smaltql's result
  boundary, as SQLite would have stored it.

### 3. Format 4 carries both

The format stays 4.0, and both changes join it before 0.9.0:
- the `BOOLEAN` storage type in stored definitions;
- NaN's key tag;
- zone maps that order NaN.

For users, the format changes once, from 3 to 4. `docs/STORAGE_FORMAT.md` is brought up to date, including §9, which
still says format 3.

## Order of work

One PR each:

1. This ADR.
2. **NaN in storage and order:** the total order (`compareNumeric`, `compareValues`, the comparison operations), the
   key codec's NaN tag, zone maps, `ValueColumn`, and STORAGE_FORMAT.md.
3. **NaN in operations:** the IEEE operations keep NaN, plus `sum_float` / `avg_float`, with tests that SQL's
   operations still give NULL.
4. **`bool` in plans:** the plan type, typing of operations and logic nodes, the `int` declaration, literals, the
   validator, results as `true` / `false` in process and through the client, and values from columns.
5. **`BOOLEAN` storage:** the storage type, stored definitions, coercion on write, the catalog, and the docs
   (`plans.md`, `schema.md`, `catalog.md`).
6. **smaltql:** declares its comparisons and logic `int` (then the engine's defaults become `bool`: the catalog's result
   for comparisons and logic, and a logic node without `type`; until then they are `int`, so SQL is unchanged), converts NaN parameters and results to NULL (through a
   language hook for parameters the engine binds, which this step adds), and updates its pin. sqllogictest stays at its pass rate.
7. **smaltdf:** `bool` from the engine (its own 0 / 1 conversion goes), `BOOLEAN` in `createTable`, NaN from `div`,
   and the Polars comparison table updated (`0 / 0` stops differing).

The gates of ADR 0015 §10 apply to every step: the planning-cost benchmarks, `test/perf-invariants.test.ts`, the
plan-shape and generated-code corpora, and smaltql's suites.

## Owner's decisions (2026-11-07)

1. **Format:** `bool` and NaN join format 4, which is unreleased, so users see one format change.
2. **`bool`:** a static type with 0 / 1 values at run time, as section 1 describes.
3. **NaN:** a total order: NaN equals NaN and sorts after every number.
4. **SQL's names:** the `sql.*` operation names are removed, not kept for SQL's 0 / 1. SQL types what it needs
   through the declared `int` (section 1).

## Alternatives considered

- **`bool` as JS booleans at run time.**
  - The values would describe themselves, so a `bool` in an ANY column would stay a `bool`.
  - Every operation, the key codec, record tags, columnar encodings and the protocol would have to handle a sixth
    kind of value. Hot paths would gain checks.
  - Rejected for cost (decision 2).
- **Separate operations for SQL's 0 / 1** (keeping `sql.eq` typed `int`). This would keep two names for one
  operation, which decision 4 rules out. The declared `int` gives SQL the same at no cost.
- **IEEE NaN** (equal to nothing).
  - NaN rows would never group or join.
  - Sorting would need a rule anyway.
  - It would differ from Polars, the reference smaltdf compares itself with.
  - Rejected (decision 3).
- **A format 5 for the types.** Rejected: users would see two format changes, 3 → 4 → 5, in one release (decision 1).

## Consequences

- smaltdf's types come from the engine, and its 0 / 1 conversion goes. A `bool` column it writes reads back as
  `bool`. `0 / 0` is NaN, as smaltdf's reference has promised since decision C.
- SQL is unchanged: smaltql declares `int`, and its NaN handling is its own.
- The public result type gains `boolean` (results only). Clients that check `typeof value === 'number'` on comparison
  columns now see booleans where a plan typed them `bool`. SQL results are unaffected.
- Dates and times (ADR 0016 section 3, item 3) come next, with their own record.
