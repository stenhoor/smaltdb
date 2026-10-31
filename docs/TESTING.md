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
