# Testing Strategy

- **Unit tests** for each module (Vitest), run in Node against the in-memory VFS.
- **sqllogictest**: run the SQLite sqllogictest corpus (filtered to the supported subset) and our own `.test` files.
  Differential testing against SQLite (native in Node) checks query results.
- **Browser integration**: Playwright tests that exercise the real OPFS, worker topology, and multi-tab leader failover.
- **Crash/recovery tests**: inject faults in the VFS (torn writes, missing flush, killed worker) and check that
  committed data survives and nothing else does.
- **Fuzzing**: grammar-based SQL fuzzing (SQLancer-style TLP/NoREC oracles for optimizer bugs) and page-level corruption fuzzing.
- **Property tests** for the B+tree, key encoding (order preservation), and record format round trips.
- **Benchmarks** as tests. See [PERFORMANCE.md](PERFORMANCE.md).

## Running the tests

| Command | What it runs |
|---|---|
| `npm test` | Unit, property, and model-based tests in Node (Vitest + fast-check) against `MemoryVfs` |
| `BTREE_SEEDS=200 npm test -- btree` | Longer B+tree stress run: 200 seeds × 6,000 random operations, with reopen-from-storage checks |
| `DIFF_QUERIES=20000 DIFF_DML=3000 npm test -- differential` | Differential testing against SQLite WASM (in Node): random queries and random writes; results and table contents must match |
| `npm run typecheck` | `tsc --noEmit` over `src`, `test`, and `bench` |
| `npm run test:browser` | Builds, then runs the OPFS storage test and the client API test (main thread → engine worker → OPFS) in a real browser (Playwright). `BROWSERS=chromium,firefox,webkit` picks the browsers. WebKit runs with a persistent profile, because Playwright's default (ephemeral) WebKit contexts have no OPFS; `PERSISTENT_CONTEXT=1` uses one for every browser |
| `npm run bench` | Storage micro-benchmarks in Node |
| `npm run bench:browser [-- --reps 5 --engines smaltdb,sqlite-off,… or all --baseline sqlite-off --save]` | Repeated, like-for-like engine comparison in a browser, with cross-engine result checks (see [research/benchmark-methodology.md](research/benchmark-methodology.md)). `--save` writes `bench/results/<date>-<browser>-<commit>.json` |

What M0 covers:
- **Key codec:** property tests check that byte order equals a reference model of SQLite value ordering
  (NULL < numbers < text < blob; int64/real mixing near and beyond 2^53; NOCASE/RTRIM; DESC). Round-trip decoding is also tested.
- **Pager:** init and reopen, rejection of non-smaltdb files, commit and rollback, freelist reuse (including trunk overflow),
  eviction under a tiny cache, checksum corruption detection, and flush policy.
- **B+tree:** seeded random put/delete/get sequences compared against a `Map` model. Each pass checks forward and backward scans,
  `checkIntegrity()`, page accounting (header + tree + freelist = file), no leaked pins, and persistence across reopen.
  Also tested: overflow values, oversized-key rejection, rollback, `destroy()`, and `count()`.
- **Browser (OPFS):** create, insert 50k, commit, reopen, verify; exclusive-lock behaviour (a second sync handle is rejected);
  small-commit latency; and capability detection.

What M2 adds:
- **Crash injection** (`test/crash.test.ts`, `test/crash-vfs.ts`). Every write, truncate, and flush to the database and WAL
  files is logged. Storage is rebuilt at every crash point under three models: prefix, torn last write, and lost unflushed writes.
  Each image is reopened and must pass `integrity_check` and equal a committed state. Run more seeds with
  `CRASH_SEEDS=20 npm test -- crash`. A control test shows the no-WAL mode corrupts.
- **Savepoints:** nested `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`, DDL inside savepoints, and WAL pragmas.
- **Read-ahead:** prefetched pages are served without extra reads, and corruption in a prefetched page is still detected on use.

What M1 adds:
- **Differential testing vs SQLite** (`test/differential.test.ts`). Random typed expressions run through filters, LEFT and inner joins,
  GROUP BY / HAVING / aggregates, IN / EXISTS / scalar subqueries, compound selects, derived tables, and fully ordered
  `LIMIT` / `OFFSET` queries. Results are compared as multisets, or as exact sequences when fully ordered. Random
  INSERT / UPDATE / DELETE statements, including constraint violations and `OR IGNORE` / `OR REPLACE`, are compared table-for-table
  after every statement, ending with `PRAGMA integrity_check`. A default run covers about 3,000 queries and about 1,800 writes; it has
  been run at 15,000 queries and 6,000 writes.
- **Parser tests** (126): precedence, literals, parameters, spans, every statement form, and error messages.
- **Statement savepoints:** model-based tests that interleave statement and transaction commits and rollbacks.
- **Record format:** property tests for round trips and for rowid key ordering.
- **SQL smoke tests:** constraints, transactions, persistence, `EXPLAIN QUERY PLAN`.
