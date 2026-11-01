# ADR 0006: Compact index keys (format 2) and an in-memory database mode

- **Status:** accepted
- **Date:** 2026-11-01

## Context

Two measurements after M4 showed the engine itself, not only storage I/O, was behind SQLite on
index work.

- **Index size.** On a 200k-row table, smaltdb's indexes were 2.2–2.9× larger than SQLite's.
  - Every number in a key took 11 bytes: a tag, an 8-byte order-preserving double, and a 2-byte
    correction for int64 beyond 2^53.
  - The rowid suffix took another 11 bytes.
  - An entry of `a(b)` was about 31 bytes against about 12 in SQLite.
  - Index builds, range scans, inserts, checksums, cache copies and OPFS writes all touched about
    3× more pages.
- **No real in-memory mode.** The only "memory" storage was `MemoryVfs`, a simulated file system
  for tests. Every commit still computed page checksums and copied pages into the simulated file,
  so the Node comparison against SQLite's `:memory:` was not like for like. Checksums alone were
  about 17% of an UPDATE.

## Decisions

1. **Number encoding in index keys (format major version 2).** `|v| = 1.m × 2^E`.
   - *Tag byte:* encodes the sign and E. Each exponent 0..63 (every integer up to 2^64) has its own
     tag, so small integers need no exponent byte. Values below 1 or at least 2^64 use a tag plus a
     2-byte exponent.
   - *Mantissa:* 7-bit groups from the most significant, `byte = group << 1 | more`. Trailing zero
     groups are dropped; a power of two is the single byte 0x00.
   - *Negatives:* use mirrored tags and inverted payload bytes.
   - *Properties kept:* byte-wise order equals SQLite numeric order (integers and reals mixed), and
     components are prefix-free (DESC is still byte inversion). Values are exact, including int64
     beyond 2^53, which the old 2-byte correction only approximated in ordering terms.
   - *Sizes:* 0 is 1 byte, 1–127 are 2 bytes, up to 16k 3 bytes, up to 2M 4 bytes, a full double
     9 bytes, any int64 at most 10 bytes.
2. **Rowid suffix.** The rowid is encoded as a number component followed by one byte giving that
   component's length, so it is read from the end of the key without parsing the columns. Index
   entries are unique, so the extra byte never affects order.
3. **Tags renumbered:**
   - NULL 0x01;
   - numbers 0x02–0x86;
   - TEXT 0x90;
   - BLOB 0xA0.

   No tag or inverted tag is 0x00 or 0xFF, so `component + 0xFF` still bounds every extension of
   a component.
4. **Format version.** The format major version goes to 2. Format-1 files are refused
   (`SMALT_FORMAT`). There are no deployed databases yet. Once there are, a format change ships
   with a converter.
5. **In-memory databases.** These are opened with `Database.openMemory()`, `open(':memory:')` or
   `storage: 'memory'` in the client.
   - *What is skipped:* there is no file, no WAL and no page checksums, and frames are never
     evicted.
   - *Rollback:* still works. Each page's committed contents are kept in memory on its first change
     in a transaction (undo images, like SQLite's in-memory journal). Statement savepoints use the
     existing image mechanism.
   - *Benchmarks:* the in-memory adapters (`smaltdb-mem`, `sqlite-mem`) give a CPU-only
     comparison with identical workloads, so wins from I/O batching cannot hide engine regressions.

## Consequences

- **Index sizes** (200k rows, 8 KiB pages): `a(b)` 766 → 397 pages (SQLite 263), `a(d, c)`
  1,040 → 455 (SQLite 463), `a(lower(e))` 636 → 478 (SQLite 286).
- **Lookups (Node, in memory):** equality ×10k 160 → 108 ms (SQLite 99), composite ×1k 49 → 39 ms
  (SQLite 33). The new decoder needed a fast path for non-negative numbers below 2^53: a general
  decode with `2 ** k` made lookups 3× slower until the fast path was added.
- **Encoding costs more CPU per number** than writing a double. It is offset by fewer pages
  everywhere else. CREATE INDEX did not get faster; its cost is in allocation, sorting and the
  B-tree (see the housekeeping work).
- **Remaining size gap:** the per-entry overhead is now mostly the 7-byte leaf cell header and the
  2-byte slot (SQLite uses varints there). Table rows are unchanged (fixed 8-byte integers); the
  row format is revisited with the columnar work.
