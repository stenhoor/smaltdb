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
| Q-8 | Triggers / foreign keys | Triggers **deferred**; **foreign-key enforcement in v1** | decided |
| Q-9 | Runtime codegen (`new Function`) | **Yes, with automatic fallback** to closures under strict CSP | decided |
| Q-10 | ATTACH multiple databases | **Post-v1** | decided |
| Q-11 | Import/export formats | **CSV and JSON/NDJSON** in v1. SQL dump, SQLite import, Parquet/Arrow later | decided |
| Q-12 | Optional modules (JSON, FTS, …) | **None in v1**. JSON functions are a planned future module | decided |
| Q-13 | JS user-defined functions | **Deferred** (future extension) | decided |
| Q-14 | Isolation level | **Snapshot isolation**, single writer | decided |
| Q-15 | Live queries / change notifications | **Deferred** (future extension) | decided |
| Q-16 | Language | **TypeScript, no WASM** | decided |
| Q-17 | Runtime support | **Chromium, Firefox, Safari/iOS** (current + previous stable). Node is used for unit tests only, not a supported target | decided |
| Q-18 | License | **MIT** | decided |
| Q-19 | Encryption at rest | **Not in v1**. Reserve header/page bytes so it can be added later | decided |
| Q-20 | Default durability | **Full sync** (flush on every commit, with group commit) | decided |
| Q-21 | Minimum browsers | **Chrome/Edge 108, Firefox 111, Safari 17**. Feature-detected fast paths for newer browsers may come later | decided |
| Q-22 | Worker packaging | **Auto-spawn via `new URL(..., import.meta.url)`, with an override** | decided |
| Q-23 | Default result shape | **Array of objects** built client-side from a **columnar wire format**; `rowMode: 'array' \| 'columnar'` options | decided |
| Q-24 | Collations | **SQLite built-ins** (BINARY, NOCASE, RTRIM) | decided |
| Q-25 | Performance bar | **Beat SQLite WASM on every workload**; competitive with DuckDB-WASM on analytics; PGlite as a baseline | decided |

Second-round decisions: [adr/0002-second-round-decisions.md](adr/0002-second-round-decisions.md).

## Remaining questions

None open. Q-8 (FK enforcement in v1) and Q-10 (ATTACH post-v1) were confirmed on 2026-10-31 when M0 started.
New questions will be added as later milestones raise them.

M1 implementation decisions are recorded in [adr/0003-m1-executor-and-transactions.md](adr/0003-m1-executor-and-transactions.md).
