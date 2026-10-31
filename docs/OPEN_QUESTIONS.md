# Open Questions

Each question records the decision needed, the current answer, and its status.
Decisions from the first design interview (2026-10-31) are recorded in
[adr/0001-initial-design-decisions.md](adr/0001-initial-design-decisions.md).

| ID | Question | Decision / proposal | Status |
|---|---|---|---|
| Q-1 | Primary workload & data size | **Mixed** (OLTP + reporting); design for databases **up to ~1 GB** (~10M rows) | decided |
| Q-2 | Storage layout | **Hybrid**: row B+tree by default, opt-in columnar tables (post-v1 milestone) | decided |
| Q-3 | SQLite file-format compatibility | **No**, own optimized format. No SQLite import in v1 | decided |
| Q-4 | Require cross-origin isolation? | **Optional**: basic mode everywhere, parallel reader pool when `crossOriginIsolated` | decided |
| Q-5 | Type system | **STRICT by default**, SQLite-style affinity via opt-in `LOOSE` tables | decided |
| Q-6 | Multi-tab sharing | **Yes**: Web Locks leader election + failover | decided |
| Q-7 | MV refresh in v1 | **Manual full refresh + `CONCURRENTLY`**. Incremental / on-commit deferred | decided |
| Q-8 | Triggers | **Deferred** (future extension). FK enforcement stays in v1 scope (proposal) | decided |
| Q-9 | Runtime codegen (`new Function`) | **Yes, with automatic fallback** to closures under strict CSP | decided |
| Q-10 | ATTACH multiple databases | Proposal: post-v1 | open |
| Q-11 | Import/export formats | **CSV and JSON/NDJSON** in v1. SQL dump, SQLite import, Parquet/Arrow later | decided |
| Q-12 | Optional modules (JSON, FTS, …) | **None in v1**. JSON functions are a planned future module | decided |
| Q-13 | JS user-defined functions | **Deferred** (future extension) | decided |
| Q-14 | Isolation level | Proposal: snapshot isolation (single writer). Serializable later if needed | open |
| Q-15 | Live queries / change notifications | **Deferred** (future extension) | decided |
| Q-16 | Language | **TypeScript, no WASM** | decided |
| Q-17 | Runtime support | **Chromium, Firefox, Safari/iOS** (current + previous stable). Node is used for unit tests only, not a supported target | decided |
| Q-18 | License | **MIT** | decided |
| Q-19 | Encryption at rest | **Not in v1**. Reserve header/page bytes so it can be added later | decided |
| Q-20 | Default durability | **Full sync** (flush on every commit, with group commit) | decided |

## Remaining questions for the next round

- Q-10 ATTACH, Q-14 isolation level.
- Minimum browser versions, given the OPFS / sync access handle baselines (Safari ≥ 17?).
- Package distribution: a single ESM package that spawns its own worker vs. user-provided worker URLs (bundler friendliness).
- Default result row shape in the API (objects vs. arrays vs. columnar batches).
- Collations beyond `BINARY`/`NOCASE`/`RTRIM` (ICU-like locale collation via `Intl.Collator`?).
