# ADR 0003: M1 executor model, statement journal, and catalog

- **Status:** accepted
- **Date:** 2026-10-31

## Context

M1 had to deliver SQL end to end while hitting the "beat SQLite WASM" bar from ADR 0002. The design docs describe a
vectorized, batch-at-a-time executor. Building that before the planner, catalog, and DML existed would have delayed
correctness work, and differential testing showed the value of getting semantics right first.

## Decisions

1. **Executor (M1): pull-based iterators over a shared register file.** Every statement gets one `SqlValue[]`. Operators
   write column values into fixed registers, and expressions compile to closures that read those registers. Nothing is allocated
   per row in scans, filters, or joins, and correlated subqueries work naturally because inner plans read outer registers.
   Batches appear only at the worker boundary (columnar wire format, ADR 0002). **The vectorized executor stays the
   target** for analytical workloads (M3/M7). It will replace operators incrementally behind the same planner interface.
2. **Static typing of expressions.** JS numbers cannot distinguish `2` from `2.0`, so REAL-ness is tracked statically
   (column types, literals, CAST, arithmetic). That covers SQLite semantics for division, `typeof`, and REAL->TEXT
   conversion. **Known gap:** an integral REAL that flows through an untyped expression (e.g. `coalesce(real_col, int_col)`
   or an `ANY` column) is treated as INTEGER. The differential tests avoid this case. A fix would carry a REAL tag in
   the register file.
3. **Statement journal (savepoint per statement).** The pager snapshots each page on first modification within a
   statement, so a failing statement inside an explicit transaction is undone without losing earlier work. The journal
   is skipped when it cannot matter:
   - in autocommit mode, where a failure rolls back the whole transaction;
   - for single-row `INSERT ... VALUES` without REPLACE on a table without secondary indexes, where every check runs before any write.

   Profiling showed the journal and per-statement object construction dominated bulk inserts. With them removed, inserts dropped from 47 µs to about 2.6 µs per row.
4. **Catalog:** a regular rowid table `smalt_schema(type, name, tbl_name, rootpage, sql)` rooted at the header's catalog
   page. `sqlite_schema` and `sqlite_master` are aliases. The schema is rebuilt by parsing the stored SQL on open. Implicit
   PRIMARY KEY/UNIQUE indexes are named `smalt_autoindex_<table>_<n>` in SQLite's numbering order.
5. **Rowid table keys** use a compact 8-byte sign-flipped big-endian encoding. **Index keys** use the order-preserving
   codec from M0 with the rowid appended as the last component.
6. **UPDATE is two-pass:** collect target rowids, sort them ascending, then for each row re-read its current contents
   and evaluate SET. This matches SQLite exactly, including cascades caused by `OR REPLACE`. The differential DML tests confirmed it.

## Consequences

- Correctness is checked by differential tests against SQLite. These run as unit tests (thousands of random queries
  and writes per run).
- The register/iterator executor is already faster than SQLite WASM on the M0/M1 workloads. Vectorization is now an
  optimization for scans and aggregates, not a prerequisite.

## Amendment (post-M2): expression code generation and integer representation

- Expressions with arithmetic, numeric comparisons or boolean logic are compiled to generated JavaScript when allowed (ADR 0001
  decision 5). The closure compiler remains the fallback and defines the semantics. On a 1M-row scan, `sum(b * 2 + d)` went from
  about 45 ns to about 16 ns of expression cost per row.
- **Integer invariant made explicit:** integers outside ±(2^53-1) are always `bigint`. A JS `number` outside that range is
  therefore a REAL, even when integral. `isIntValue`, `typeof()`, text conversion and generated code all use
  `Number.isSafeInteger`. This fixed int64-overflow results such as `-(-9223372036854775808)` being treated as INTEGER later on.
- Fixed: REAL `%` with an int64 operand beyond 2^53 converted the operand through a double first; it now casts the original value.
- A new differential test checks int64 extremes, the 2^53 boundary, division and modulo by 0 and -1, negative zero, and mixed
  INTEGER/REAL/TEXT/ANY operands against SQLite, under both the generated-code and closure paths.
- **Generated row decoders** (`generateLoader` in codegen.ts): per table access, column offsets and types are baked into a decoder that
  reads leaf page bytes directly. Overflow cells and short (pre-ADD COLUMN) records fall back to the generic `RecordReader`.
- **Append-optimized splits:** an insert past the end of the rightmost leaf starts a new page instead of splitting 50/50.
