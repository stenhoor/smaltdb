# sqllogictest pass rate

- Runner: `npm run slt` ([test/slt/run.ts](../../test/slt/run.ts)); `-- --save` writes `bench/results/slt-<date>.json`.
- Corpus: [SQLite's sqllogictest](https://sqlite.org/sqllogictest) (public domain), read from a GitHub mirror and
  cached in `.cache/slt` on first use.
- The runner behaves like SQLite's own driver. It skips records marked `skipif sqlite` or `onlyif <other>`, prints
  values for I/R/T result types the same way, supports `nosort` / `rowsort` / `valuesort`, and hashes results with
  MD5 above the hash threshold.

## Subset tracked (25 files, 122,334 records)

The files are select1–5, nine `evidence/` files, the first file of each `random/` family (aggregates, expr, groupby, select),
and the first file of each `index/` family (between, commute, delete, in, orderby, orderby_nosort, random).

| Date | Passed | Rate | Notes |
|---|---|---|---|
| 2026-11-01 (first run) | 122,254 / 122,334 | 99.93% | `x IN table` shorthand missing (72), TEMP views (4), driver formatting of huge REALs (3), one corpus quirk |
| 2026-11-01 (after fixes) | 122,333 / 122,334 | **≈100%** (99.999%) | 1 remaining: see below |

The fixes were the `x IN table` / `x IN schema.table` / `x IN f(args)` shorthand, `CREATE TEMP VIEW`, and, in the
runner only, the reference driver's `%.3f`, which keeps 16 significant digits for magnitudes of 1e16 and above.

**Remaining failure.** `evidence/slt_lang_aggfunc.test` line 480 expects `SELECT sum(x)` over values that
overflow int64 to return no row. SQLite raises "integer overflow", and so does smaltdb; the expected output is an
artifact of how the reference results were recorded.

**Not yet tracked.** The full corpus is about 5.9M records in roughly 600 files. This subset covers each family's
first file; adding more files is a one-line change in `FILES`. Every file in the subset runs against smaltdb's
STRICT-by-default tables without a typing failure ("strict" column: 0), because the corpus mostly inserts
integers and text that convert losslessly.
