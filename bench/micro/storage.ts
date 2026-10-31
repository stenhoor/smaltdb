import { BTree } from '../../src/engine/storage/btree.js';
import { KeyEncoder, encodeKey } from '../../src/engine/storage/key-codec.js';
import { Pager } from '../../src/engine/storage/pager.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';
import { type BenchResult, runSuite } from '../lib/harness.js';

function freshTree(pageSize = 8192): BTree {
  const pager = Pager.open(new MemoryVfs().openSync('b.db'), { pageSize, cacheSizeBytes: 256 * 1024 * 1024, syncOnCommit: false });
  return new BTree(pager, BTree.create(pager));
}

/** Storage-layer micro benchmarks (memory VFS, warm cache). */
export async function storageBenchmarks(N = 100_000): Promise<BenchResult[]> {
  const keys = Array.from({ length: N }, (_, i) => encodeKey([i]));
  let s = 12345;
  const shuffled = keys.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) >>> 0;
    const j = s % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const value = new Uint8Array(32);
  const loaded = freshTree();
  for (const k of keys) loaded.put(k, value);
  loaded.pager.commit();
  const enc = new KeyEncoder();
  let sink = 0;

  const results = [
    ...(await runSuite('btree.insert', [
      { name: `sequential ${N} keys + commit`, ops: N, run: () => { const t = freshTree(); for (const k of keys) t.put(k, value); t.pager.commit(); } },
      { name: `random ${N} keys + commit`, ops: N, run: () => { const t = freshTree(); for (const k of shuffled) t.put(k, value); t.pager.commit(); } },
    ])),
    ...(await runSuite('btree.read', [
      { name: 'point get (random)', ops: N, run: () => { for (const k of shuffled) sink += loaded.get(k)!.length; } },
      { name: 'has (random)', ops: N, run: () => { for (const k of shuffled) sink += loaded.has(k) ? 1 : 0; } },
      {
        name: 'cursor full scan',
        ops: N,
        run: () => {
          const c = loaded.cursor();
          for (let ok = c.first(); ok; ok = c.next()) sink++;
          c.close();
        },
      },
    ])),
    ...(await runSuite('keycodec', [
      { name: 'encode int', ops: N, run: () => { for (let i = 0; i < N; i++) sink += enc.reset().add(i).length; } },
      { name: 'encode (int, text)', ops: N, run: () => { for (let i = 0; i < N; i++) sink += enc.reset().add(i & 1023).add('user-name-' + (i & 255)).length; } },
    ])),
  ];
  if (sink === -1) console.log(sink);
  return results;
}
