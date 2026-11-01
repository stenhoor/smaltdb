import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { HyperLogLog, hashValue, sampleTable } from '../src/engine/exec/stats.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

function build(n: number): Database {
  const db = Database.openFile(new MemoryVfs().openSync('s.db'));
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, uniq TEXT, low INT, periodic INT, sparse INT)');
  const ins = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i <= n; i++) ins.run([i, 'u' + i, i % 5, ((i * 7919) % 10000) + 1, i % 10 === 0 ? i % 300 : null]);
  db.exec('COMMIT');
  return db;
}

const within = (est: number, actual: number, factor: number): void => {
  expect(est, `estimate ${est} vs actual ${actual}`).toBeGreaterThanOrEqual(actual / factor);
  expect(est, `estimate ${est} vs actual ${actual}`).toBeLessThanOrEqual(actual * factor);
};

describe('statistics', () => {
  it('HyperLogLog is within a few percent', () => {
    const h = new HyperLogLog();
    for (let i = 0; i < 50_000; i++) h.add(hashValue(i % 20_000));
    within(h.count(), 20_000, 1.06);
  });

  it('sampled stats estimate distinct counts and NULLs (including periodic data)', () => {
    const db = build(200_000);
    const t = db.getTable('t')!;
    const tree = db.tree(t.rootPage);
    const s = sampleTable(tree, t, tree.estimateCount());
    within(s.rows, 200_000, 1.5);
    within(s.ndv[1], 200_000, 2); // unique text
    expect(s.ndv[2]).toBe(5); // low cardinality
    within(s.ndv[3], 10_000, 2); // periodic: evenly spaced samples would alias
    within(s.ndv[4], 30, 1.5); // sparse: 90% NULL, multiples of 10 mod 300
    within(s.nulls[4], 180_000, 1.3);
  });

  it('small tables get exact statistics', () => {
    const db = build(1000);
    const t = db.getTable('t')!;
    const tree = db.tree(t.rootPage);
    const s = sampleTable(tree, t, tree.estimateCount());
    expect(s.rows).toBe(1000);
    expect(s.ndv[2]).toBe(5);
    expect(s.nulls[4]).toBe(900);
  });
});
