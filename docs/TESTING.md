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

## Running the tests (M0)

| Command | What it runs |
|---|---|
| `npm test` | Unit, property, and model-based tests in Node (Vitest + fast-check) against `MemoryVfs` |
| `BTREE_SEEDS=200 npm test -- btree` | Longer B+tree stress run: 200 seeds × 6,000 random operations, with reopen-from-storage checks |
| `npm run typecheck` | `tsc --noEmit` over `src`, `test`, and `bench` |
| `npm run test:browser` | OPFS integration test in a real browser (Playwright). `BROWSERS=chromium,firefox,webkit` picks the browsers |
| `npm run bench` | Storage micro-benchmarks in Node |
| `npm run bench:browser [-- --engines smaltdb,sqlite --rows 100000 --save]` | Engine comparison in a browser. `--save` writes `bench/results/<date>-<browser>.json` |

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
