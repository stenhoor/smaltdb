# Index engine work: in-memory mode, compact keys, B-tree housekeeping

Runs: Chromium 153, 5 reps each. Medians are shown. A verdict is given only when the min–max ranges
do not overlap. All engines returned identical results in every run.

- **CPU-only** (smaltdb `:memory:` vs SQLite `:memory:`):
  - before: `bench/results/2026-11-01-chromium-2eb08b9-cpu.json`;
  - after: `bench/results/2026-11-01-chromium-859fa58-cpu.json`.
- **OPFS** (smaltdb vs the faster of SQLite WAL / TRUNCATE):
  - before: `bench/results/2026-11-01-chromium-9f1f951.json`;
  - after: `bench/results/2026-11-01-chromium-859fa58.json`.

## What changed

1. **In-memory database mode** (ADR 0006): no file, WAL or page checksums. Rollback uses undo
   images held in reusable slabs. The browser bench has `smaltdb-mem` / `sqlite-mem` for a CPU-only
   view.
2. **Compact index keys** (format 2, ADR 0006): numbers take 2–4 bytes instead of 11, plus a
   rowid suffix with a length byte. 200k-row indexes: `a(b)` 766 → 397 pages, `a(d,c)`
   1,040 → 455, `a(lower(e))` 636 → 478.
3. **CREATE INDEX** packs entries into one buffer and sorts them with a native numeric sort on
   (4-byte prefix, position). It then builds the B-tree bottom-up (`BTree.bulkLoadKeys`) instead of
   inserting key by key.
4. **UPDATE** skips indexes whose columns did not change and reuses encoders instead of copying
   keys.

## CPU-only (in memory, both engines)

| Workload | smaltdb before | smaltdb after | SQLite | After vs SQLite |
|---|---|---|---|---|
| CREATE INDEX, 1 column | 145 ms | 78 ms | 40 ms | 0.51× slower |
| CREATE INDEX, 2 columns | 185 ms | 81 ms | 81 ms | no clear difference |
| CREATE INDEX on `lower(e)` | 280 ms | 151 ms | 66 ms | 0.44× slower |
| Equality lookups ×10k | 94 ms | 70 ms | 79 ms | 1.12× faster |
| Range lookups ×1k | 730 ms | 688 ms | 508 ms | 0.74× slower |
| Composite lookups ×1k | 39.5 ms | 29.0 ms | 31.0 ms | no clear difference |
| Expression lookups ×1k | 122 ms | 121 ms | 180 ms | 1.49× faster |
| UPDATE indexed column, 10k rows | 93 ms | 85 ms | 28.5 ms | 0.33× slower |
| DELETE 10k rows | 54 ms | 46.5 ms | 25.6 ms | 0.55× slower |
| Bulk insert 100k, 3 indexes | 579 ms | 479 ms | 685 ms | 1.43× faster |

## OPFS (smaltdb vs best crash-safe SQLite)

| Workload | smaltdb before | smaltdb after | Best SQLite | After vs SQLite |
|---|---|---|---|---|
| CREATE INDEX, 1 column | 196 ms | 92 ms | 180 ms | 1.96× faster |
| CREATE INDEX, 2 columns | 279 ms | 130 ms | 284 ms | 2.18× faster |
| CREATE INDEX on `lower(e)` | 338 ms | 179 ms | 216 ms | 1.21× faster |
| Equality lookups ×10k | 88.8 ms | 69.9 ms | 84.6 ms | 1.21× faster |
| Range lookups ×1k | 696 ms | 721 ms | 514 ms | 0.71× slower |
| Composite lookups ×1k | 38.8 ms | 29.3 ms | 30.1 ms | no clear difference |
| Expression lookups ×1k | 118 ms | 112 ms | 179 ms | 1.60× faster |
| UPDATE indexed column, 10k rows | 236 ms | 229 ms | 1,325 ms | 5.8× faster |
| DELETE 10k rows | 197 ms | 168 ms | 668 ms | 4.0× faster |
| Bulk insert 100k, 3 indexes | 756 ms | 607 ms | 1,105 ms | 1.82× faster |
| Load join tables (612k rows, 2 indexes) | 1,959 ms | 1,415 ms | 2,495 ms | faster |

The non-index workloads (OLTP, analytic, joins) are unchanged within run-to-run noise.

## Longer than SQLite, CPU-only

- **UPDATE (3×) and DELETE (1.8×).** The cost is spread across several places:
  - UPDATE runs in two passes: collect rowids, then re-read each row by rowid;
  - every index and table operation searches down from the root;
  - fully packed pages are compacted on insert after a delete (no free-space list in pages);
  - undo images are copied for each modified page.

  Candidates: a leaf-position hint for consecutive operations on the same leaf; a one-pass UPDATE
  for statements that cannot see their own changes; free-space lists in pages.
- **Range lookups (0.74×).** Fetching each table row by rowid costs a full descent.
  Candidates: the same leaf hint, or sorting the rowids before fetching for unordered aggregates.
- **Expression CREATE INDEX (0.44×).** Each row is fully decoded and the expression runs through
  the generic evaluator.
- **Table size.** Rows are 2.3× SQLite's because integers take a fixed 8 bytes. This is deferred to
  the columnar milestone, as recommended.
- **Index entry overhead.** Each entry still carries a 7-byte cell header and a 2-byte slot.

## Round 2: sorted rowid fetch, format 3, faster CREATE INDEX

Changes:
1. **Sorted rowid fetch.** An index scan whose row order cannot be observed sorts its rowids in
   batches of 4,096 and walks the table forward.
2. **Format 3** (ADR 0007): varint leaf cell headers (2 bytes for an index entry instead of 7) and
   per-page free-block lists.
3. **CREATE INDEX.** A radix sort on key prefixes, and expression indexes decode only the columns
   they read.

Sizes (200k rows): table 1,427 → 1,307 pages; `a(b)` 397 → 275 (SQLite 263); `a(d, c)` 455 → 332
(SQLite 463); `a(lower(e))` 478 → 355 (SQLite 286).

Runs:
- `bench/results/2026-11-01-chromium-4feec71-cpu.json` (CPU-only);
- `bench/results/2026-11-01-chromium-4feec71.json` (OPFS).

Each is compared with the round-1 runs above.

### CPU-only (both engines in memory)

| Workload | Round 1 | Round 2 | SQLite | Round 2 vs SQLite |
|---|---|---|---|---|
| CREATE INDEX, 1 column | 78 ms | 73 ms | 41 ms | 0.56× slower |
| CREATE INDEX, 2 columns | 81 ms | 60 ms | 81 ms | 1.34× faster |
| CREATE INDEX on `lower(e)` | 151 ms | 120 ms | 69 ms | 0.57× slower |
| Equality lookups ×10k | 70 ms | 73 ms | 78 ms | no clear difference |
| Range lookups ×1k | 688 ms | 495 ms | 534 ms | no clear difference (was 0.74×) |
| Composite lookups ×1k | 29.0 ms | 28.7 ms | 29.6 ms | no clear difference |
| Expression lookups ×1k | 121 ms | 114 ms | 182 ms | 1.60× faster |
| UPDATE indexed column, 10k rows | 85 ms | 73 ms | 28 ms | 0.38× slower |
| DELETE 10k rows | 46.5 ms | 46.8 ms | 26.3 ms | 0.56× slower |
| Bulk insert 100k, 3 indexes | 479 ms | 460 ms | 664 ms | 1.44× faster |

### OPFS (smaltdb vs the faster crash-safe SQLite mode)

| Workload | Round 1 | Round 2 | Best SQLite | Round 2 vs SQLite |
|---|---|---|---|---|
| CREATE INDEX, 1 column | 92 ms | 78 ms | 163 ms | 2.10× faster |
| CREATE INDEX, 2 columns | 130 ms | 102 ms | 302 ms | 2.96× faster |
| CREATE INDEX on `lower(e)` | 179 ms | 139 ms | 196 ms | 1.41× faster |
| Equality lookups ×10k | 70 ms | 74 ms | 78 ms | no clear difference |
| Range lookups ×1k | 721 ms | 484 ms | 520 ms | no clear difference (was 0.71×) |
| Composite lookups ×1k | 29.3 ms | 29.7 ms | 31.1 ms | no clear difference |
| Expression lookups ×1k | 112 ms | 126 ms | 181 ms | 1.44× faster |
| UPDATE indexed column, 10k rows | 229 ms | 213 ms | 1,331 ms | 6.2× faster |
| DELETE 10k rows | 168 ms | 166 ms | 654 ms | 3.9× faster |
| Bulk insert 100k, 3 indexes | 607 ms | 612 ms | 1,118 ms | 1.83× faster |

On OPFS, smaltdb is now at least even with SQLite on every index workload. Non-index workloads are
unchanged within noise.

### Still behind, CPU-only

- **UPDATE (0.38×) and DELETE (0.56×):** two passes, a root-to-leaf search per operation, and
  undo copies of modified pages.
- **1-column and expression CREATE INDEX (about 0.56×):** the cost is now spread across the scan
  loop, the bulk build and the key encoding.
