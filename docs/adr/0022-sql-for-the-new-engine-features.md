# ADR 0022: SQL for the new engine features

- **Status:** done: accepted with the owner's decisions of 2026-11-10 (#181, #182); steps 1–8 in stenhoor/smaltql#33,
  #34, #35, #36, #37, #38, #39, #40, #41, #42, #43, #44, #45, #46, #47, with the engine's #183, #184 and #185. Differences
  from the proposal are under "Done" at the end
- **Date:** 2026-11-09
- **Builds on:** [ADR 0015](0015-smaltql.md) (smaltql), [ADR 0016](0016-plan-api-for-every-language.md) (the plan API
  and its operations), [ADR 0018](0018-bool-and-nan.md), [ADR 0019](0019-dates-and-times.md) and
  [ADR 0020](0020-lists-and-structs.md) (the types, and what SQL sees of them)

## Context

ADRs 0016 and 0018–0020 gave the engine what smaltdf needs: `bool` and NaN, four temporal types, lists and structs,
about 50 new operations, and the plan operations `pivot`, `unpivot`, `sample`, `explode`, as-of joins, `distinct` with
`on` / `keep`, `first` / `last` with a key and `ignoreNulls` windows. Each record asked one thing of SQL: read the new
values as SQLite would (dates as text, lists and structs as JSON text, truth values as 0 / 1). smaltql did that for
**columns** (stenhoor/smaltql#18, #19 and #25), and nothing more.

The engine and smaltql were surveyed for this record at smaltdb `dca732d` and smaltql `0d99440`, with queries run
against smaltql's pinned build.

**SQL reaches 54 engine functions by accident.** smaltql's binder (`src/frontend/functions.ts`) hides the functions the
catalog marks as operations (`cmp_eq`, `add_checked`, …), and calls any other. The new temporal, list, regex and float
functions aren't marked, so SQL can call them, undocumented: `year`, `make_date`, `to_zone`, `list_of`, `list_get`,
`regex_match`, `div_float`, `implode`, `first`, `sum_float` and the rest.

**Values those functions compute skip SQL's conversions,** because smaltql converts where a column is read, not where a
value's type is temporal, list or struct:

| Query | Result | SQL should give |
|---|---|---|
| `strftime('%Y', make_date(2026,1,1))` | `-4657`: the day count read as a Julian day | `2026` |
| `date(make_date(2026,1,1), '+1 month')` | `-4657-12-25` | `2026-02-01` |
| `parse_datetime('2026-11-07 10:00:00') > '2026-01-01'` | `0` | `1` |
| `typeof(make_date(2026,11,7))` | `integer` | `text` |
| `list_of(1,2) \|\| 'x'` | the list's encoded bytes as text | `[1,2]x` |
| `length(list_of(1,2))` | `4` | `5` |
| `list_of(1,2)` | a JS array | JSON text `[1,2]` |
| `regex_match('abc','b')` | `true` | `1` |

**SQL has no syntax for the new plan operations,** and none for what Postgres and DuckDB users reach for with the new
types. Each of these is a syntax error or `no such function` today: `x REGEXP p` (parsed; no `regexp` function),
`EXTRACT`, `date_trunc`, `DATE '…'`, `INTERVAL`, `ARRAY[…]`, `array_agg`, `unnest`, `PIVOT`, `ASOF JOIN`,
`TABLESAMPLE`, `DISTINCT ON`, `IGNORE NULLS`.

## Proposal

### 1. Rules

1. **SQLite first, then Postgres, then DuckDB.** Where SQLite has a spelling (`REGEXP`, `strftime`), SQL uses it.
   Otherwise Postgres's. DuckDB's where Postgres has none (`PIVOT`, `ASOF JOIN`, `arg_min`, `strptime`): it is the
   closest analytic dialect to the engine, and follows Postgres itself.
2. **SQL's values stay SQLite's.** Dates are text, lists and structs JSON text, truth values 0 / 1, whether a value
   comes from a column or a call (ADR 0018 decision 4, ADR 0019 §6, ADR 0020 §6).
3. **One name per meaning.** An engine name that means what SQL already spells another way (`div_float` for `/`,
   `round_half_even` for `round`, `sum_float` for `sum`) is hidden from SQL. One that SQL gets no other way
   (`to_zone`) stays, documented as a smaltdb extension.
4. **Nothing changes what valid SQLite means.** `x[i]` is out: `[1]` quotes an identifier, so `SELECT x [1]` is `x`
   aliased `1`. `CAST(x AS DATE)` keeps NUMERIC affinity, and `DATE` columns stay NUMERIC (ADR 0019 decision 4).
5. **Text in, typed inside.** A temporal function given SQL's date text casts it first (`year('2026-11-07')` is
   `2026`), as comparisons already do.

### 2. Fixes (no new syntax)

- smaltql converts every value whose static type is temporal, list or struct to its text at SQL's boundary: in
  results, and where a SQL function or operator takes it (`||`, `length`, `typeof`, comparisons with text, SQLite's
  date functions).
- A call whose engine type is `bool` is declared `int`.
- The binder calls only the functions on an allow-list of SQL's names, so a new engine function doesn't reach SQL until
  smaltql decides its SQL spelling. The engine names section 3 maps or hides drop out.

### 3. Spellings

| Engine | SQL | From |
|---|---|---|
| `year` … `microsecond`, `weekday`, `day_of_year` | `EXTRACT(field FROM x)`, `date_part('field', x)`; `year(x)` etc. stay, with rule 5 | Postgres; DuckDB |
| `trunc_temporal` | `date_trunc('unit', x)` | Postgres |
| `offset_by` | `x + INTERVAL '1 month'`; `date ± int` moves by days | Postgres |
| `cast_date`, `cast_datetime` | `DATE '…'`, `TIMESTAMP '…'` | SQL standard |
| `parse_date`, `parse_datetime` | `strptime(text, format)` | DuckDB |
| `make_datetime` | also `make_timestamp` | Postgres |
| `round_half_even` | `round_even(x, digits)`; `round` stays SQLite's | DuckDB |
| `current_timestamp` | also `now()` | Postgres |
| `regex_match`, `regex_find`, `regex_replace`, `regex_replace_all` | `x REGEXP p`, `regexp_like`, `regexp_substr`, `regexp_replace` (every match with the `g` flag) | SQLite; Postgres 15 |
| NaN in the total order | `isnan(x)` | DuckDB |
| `first`, `last` with a key | `arg_min(x, key)`, `arg_max(x, key)` | DuckDB |
| navigation windows with `ignoreNulls` | `lag(x) IGNORE NULLS OVER (…)`, and `lead`, `first_value`, `last_value`, `nth_value` | SQL standard |
| `list_of` | `ARRAY[a, b, …]` (`ARRAY` is a keyword only before `[`) | Postgres |
| `list_get`, `list_slice` | `list_extract(x, i)`, `array_slice(x, from, to)`, counting from 1 | DuckDB |
| `list_len`, `list_contains` | `cardinality(x)`, `array_length(x)`, `array_contains(x, v)`, `v = ANY (x)` | Postgres |
| `list_concat`, `list_join`, `list_sort`, `list_unique`, `list_reverse` | `array_cat`, `array_to_string`, `array_sort`, `array_distinct`, `array_reverse` | Postgres; DuckDB |
| `implode` | `array_agg(x)` (`ORDER BY` inside it stays unsupported) | Postgres |
| `struct_field` | `(s).name`, and `(s).*` for every field | Postgres |
| `distinct` with `on` | `SELECT DISTINCT ON (k) … ORDER BY k, …` | Postgres |
| `sample` | `TABLESAMPLE BERNOULLI (p) REPEATABLE (seed)`, `USING SAMPLE n ROWS` | Postgres; DuckDB |
| join kind `asof` | `ASOF JOIN q ON t.k = q.k AND t.ts >= q.ts` | DuckDB |
| `pivot`, `unpivot` | `PIVOT t ON c IN (…) USING agg(v) GROUP BY k`; `UNPIVOT t ON (a, b) INTO NAME n VALUE v` | DuckDB |

Documented under their engine names, as smaltdb extensions: `make_date`, `make_datetime`, `to_zone`, `from_zone`,
`zone_offset`, `list_sum`, `list_mean`, `list_min`, `list_max`, `lower_unicode`, `upper_unicode`, `first`, `last`.

Not in SQL:
- `AT TIME ZONE`: without a zoned type its direction is ambiguous. `to_zone` and `from_zone` say which.
- Building structs (`struct_of`): SQL has no struct type (ADR 0020 decision 3).
- A dynamic pivot: a plan needs the values, so `PIVOT` takes an `IN` list.
- `div_float`, `div_floor`, `mod_floor`, `round_half_away`, `random_at`, `sum_float`,
  `avg_float`: other languages' meanings (rule 3).
- `limit` from the end: `ORDER BY … DESC LIMIT n` serves.

### 4. Explode and unnest

SQL reaches `explode` through Postgres's `unnest` in `FROM`:

| SQL | `explode` | Empty list | NULL list |
|---|---|---|---|
| `FROM t, unnest(t.tags) AS u(tag)` | `keepNulls: false` | no row | no row |
| `FROM t LEFT JOIN unnest(t.tags) AS u(tag) ON true` | `keepNulls: true`, `emptyAsNull: true` | one row, `tag` NULL | one row, `tag` NULL |
| `… WITH ORDINALITY AS u(tag, pos)` | `position: true`; `pos` is the position + 1 | | |
| `FROM unnest(ARRAY[1, 2])` | over one row of `values` | no row | no row |

- **Binding.** `unnest(expr)` may read the `FROM` items before it. smaltql binds those items, adds `expr` as a column,
  explodes it, and names the element (and position) by the alias list. Rows come in the input's order, then each
  list's. The element has the list's element type, so nested lists and structs reach SQL as JSON text (section 2).
  An `expr` not typed `list<…>` is an error: JSON text in a text column is not a list.
- **Not in SQL:** `unnest(a, b)` over several lists, which `explode` can't do (decision 4); `unnest` in the select
  list (decision 5).

## Order of work

One PR each in `stenhoor/smaltql` unless marked. Every PR keeps `npm run slt` at its pass rate, and its docs examples
run as tests. Sizes count tests and docs: S under 300 lines, M 300–800, L over 800.

| Step | Scope | Size | PRs | After |
|---|---|---|---|---|
| 0 | This ADR, with the owner's decisions | S | 1 (here) | |
| 1 | The fixes (section 2) | M, ~500 | 1 | none: bugs under ADRs 0018–0020 |
| 2 | The extensions page of the functions reference | S, ~250 | 1 | 1 |
| 3 | Dates: `EXTRACT`, `date_part`, `date_trunc`, rule 5, `DATE` / `TIMESTAMP` literals, `INTERVAL`, `date ± int`, `now()`, `make_timestamp`, `strptime` | L, ~900 | 2 | 1 |
| 4 | `REGEXP` and `regexp_*`, `isnan`, `arg_min` / `arg_max`, `IGNORE NULLS` | M, ~450 | 1 | 1 |
| 5 | Lists: `ARRAY[…]`, the `array_*` names, `cardinality`, `= ANY`, `array_agg` | M, ~600 | 1 | 1 |
| 6 | `unnest` (section 4), `(s).name`, `(s).*` | L, ~1,000 | 2 | 5 |
| 7 | `DISTINCT ON`, `TABLESAMPLE` / `USING SAMPLE`, `ASOF JOIN`, `PIVOT` / `UNPIVOT` | L, ~1,800 | 4 | 1 |
| 8 | `cast_time` here, then `TIME '…'` in smaltql | S, ~200 | 2 (here, smaltql) | 3 |

Steps 2–5 and 7 are independent once step 1 lands. Step 6 carries the most risk: `unnest` is the first `FROM` item
that reads the items before it. SQLite's JSON functions (`json_*`, `->`, `->>`) are a feature of SQLite's own, not of
the engine, and get their own record.

## Owner's decisions (2026-11-10)

1. **A superset of SQLite: settled by the brand.** smalt-brand's `BRAND.md` says smaltql "can grow its own syntax, but
   only by adding to SQL, never by changing what working SQL means", and rule 4 keeps that. The extensions are on by
   default, with no setting.
2. **Engine names: an allow-list.** SQL calls only SQL's names: SQLite's, the spellings of section 3, and the names
   documented as smaltdb extensions. The nine left out were reviewed one by one: `round_half_even` joins, as DuckDB's
   `round_even`; `div_float`, `div_floor`, `mod_floor`, `round_half_away`, `random_at`, `sum_float`, `avg_float` and
   `struct_of` stay out, since SQL spells each meaning another way or has no type for it. An engine name with a SQL
   spelling (`list_len`, `trunc_temporal`) is hidden in favour of the spelling.
3. **Empty and NULL lists in `unnest`:** Postgres's two forms (section 4).
4. **`unnest` is a special case, not general `LATERAL`.** `FROM t, unnest(t.tags)` compiles to the same `explode`
   operation smaltdf's `explode()` builds, with other options, so SQL and smaltdf share one plan. General `LATERAL`
   would be SQL-only (correlated nested plans, with no smaltdf equivalent) and gets its own record if it's wanted.
5. **Neither `unnest(a, b)` nor `unnest` in the select list, for now** (`SMALT_UNSUPPORTED`). Neither language can
   explode several lists (the engine's `explode` takes one column), and the dialects disagree: Polars requires equal
   lengths, Postgres pads with NULLs. A select-list `unnest` has no smaltdf equivalent. If several lists are wanted
   later, the engine's `explode` takes several columns first, for both languages.

## Consequences

- SQL stops leaking the engine's run-time forms, and the functions reference lists everything SQL can call.
- SQL users get the Postgres and DuckDB spellings for what smaltdf already does, over the same plan operations: no new
  engine operations except `cast_time` (step 8).
- smaltql becomes a superset of SQLite, as the brand promises (decision 1). sqllogictest stays at its pass rate,
  since nothing valid in SQLite changes.

## Done (2026-11-10)

Where the work differs from the proposal:

- **No `date ± int`** (step 3). A `DATE` column read by SQL keeps SQLite's text arithmetic (ADR 0019 §6), so `d + 1` is
  `2027`; `+ INTERVAL '1 day'` moves by days.
- **`PIVOT` and `UNPIVOT` take the SQL-standard `FROM`-clause form** (`FROM t PIVOT (sum(v) FOR c IN (…))`,
  `FROM t UNPIVOT (v FOR n IN (a, b))`), which DuckDB also takes, rather than DuckDB's statement form. `UNPIVOT`
  leaves out NULL values unless `INCLUDE NULLS`.
- **The engine:** a language's plans with `sample`, `pivot`, `unpivot`, `explode`, as-of joins, `distinct` with
  `on` / `keep` or a `limit` from the end are rewritten on receipt, as plan statements are (#183); a call's declared
  type stands where its function can't tell its own, for `struct_field` (#184); `cast_time` (#185).
- **Not done:** `(s).*`; DuckDB's `USING SAMPLE`; `INTERVAL` on a `time` (the engine's `offset_by` takes dates and
  date-times); `implode` stays callable from SQL, since `array_agg` compiles to it.
