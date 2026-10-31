# Open Questions

Each question records the decision needed, the current proposal, and its status.
Resolved questions move to an ADR in [adr/](adr/).

| ID | Question | Current proposal | Status |
|---|---|---|---|
| Q-1 | Primary workload: OLTP (app state, point reads/writes), analytics (large scans/aggregates), or mixed? Expected data sizes? | Mixed; row store first, columnar later | open |
| Q-2 | Storage layout: row B+tree, columnar, or hybrid? | Hybrid: row B+tree default + opt-in columnar tables | open |
| Q-3 | Must the file format be SQLite-compatible (open existing `.sqlite` files)? | No (own format, optimized); offer import/export | open |
| Q-4 | Can we require cross-origin isolation (COOP/COEP) for SharedArrayBuffer-based parallelism? | Optional: "basic" mode without, "parallel" mode with | open |
| Q-5 | Type system: SQLite dynamic affinity vs. strict typing? | STRICT by default, LOOSE opt-in | open |
| Q-6 | Must multiple tabs share one database concurrently? | Yes, via leader election | open |
| Q-7 | Materialized view refresh semantics needed for v1? | Manual + CONCURRENTLY in v1; incremental later | open |
| Q-8 | Triggers, foreign-key enforcement in v1? | FKs yes; triggers later | open |
| Q-9 | Can we rely on `new Function` (CSP `unsafe-eval`) for expression JIT? | Use when allowed; interpreter fallback | open |
| Q-10 | ATTACH multiple databases? | Later | open |
| Q-11 | Import/export formats (CSV, JSON, Parquet, Arrow, SQLite)? | CSV + JSON + SQL dump in v1 | open |
| Q-12 | Optional modules (JSON, FTS, geo)? | JSON core, FTS later | open |
| Q-13 | JS user-defined functions? | Yes, as source strings | open |
| Q-14 | Isolation level: snapshot vs. serializable? | Snapshot | open |
| Q-15 | Reactive/live queries (change notifications to UI)? | Table-level change events | open |
| Q-16 | Language & build: TypeScript, pure JS, or allow WASM for hot paths? | TypeScript, no WASM | open |
| Q-17 | Browser support matrix; Node/Deno support? | Last 2 versions of Chrome/Edge/Firefox/Safari; Node for tests | open |
| Q-18 | License? | Apache-2.0 or MIT | open |
| Q-19 | Encryption at rest? | Not in v1 | open |
