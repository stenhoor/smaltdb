# Public API (draft)

```ts
import { open } from 'smaltdb';

const db = await open('app', {
  storage: 'opfs',          // 'opfs' | 'memory'
  cache: { mode: 'lru', sizeMB: 64 },   // or { mode: 'full' } = memory-cached
  workers: 'auto',          // number of reader workers; requires crossOriginIsolated
  multiTab: true,
});

// One-shot
const rows = await db.query('SELECT id, name FROM users WHERE age > ?', [30]);

// Prepared + streaming
const stmt = await db.prepare('SELECT * FROM events WHERE ts BETWEEN :from AND :to');
for await (const batch of stmt.stream({ from, to })) {
  // batch.columns.ts : Float64Array, batch.length, batch.row(i), batch.toObjects()
}

// Transactions
await db.transaction(async (tx) => {
  await tx.exec('INSERT INTO t VALUES (?, ?)', [1, 'a']);
  await tx.exec('UPDATE c SET n = n + 1');
});

// Bulk load (fast path, bypasses per-row SQL)
await db.insertColumns('events', { ts: Float64Array.from(...), kind: ['a','b', ...] });

// Introspection
await db.query('SELECT * FROM information_schema.columns WHERE table_name = ?', ['users']);
await db.explain('SELECT ...', { analyze: true });

await db.close();
```

Open design points: result row shape (objects vs. arrays vs. columnar), bigint handling, the UDF API **[Q-13]**,
change notifications / live queries **[Q-15]**, and framework bindings.
