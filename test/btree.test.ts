import { describe, expect, it } from 'vitest';
import { BTree } from '../src/engine/storage/btree.js';
import { encodeKey } from '../src/engine/storage/key-codec.js';
import type { Pager } from '../src/engine/storage/pager.js';
import { compareBytes } from '../src/engine/util/bytes.js';
import { hex, openMemoryPager, rng } from './helpers.js';

function valueFor(r: () => number, pageSize: number): Uint8Array {
  const roll = r();
  // Mostly small values, some medium, a few that need overflow chains.
  const len = roll < 0.8 ? Math.floor(r() * 40) : roll < 0.97 ? Math.floor(r() * 200) : pageSize + Math.floor(r() * pageSize * 3);
  const v = new Uint8Array(len);
  for (let i = 0; i < len; i++) v[i] = Math.floor(r() * 256);
  return v;
}

function randomKey(r: () => number, space: number): Uint8Array {
  const kind = r();
  if (kind < 0.5) return encodeKey([Math.floor(r() * space)]);
  if (kind < 0.8) return encodeKey(['k' + Math.floor(r() * space).toString(36).repeat(1 + Math.floor(r() * 4))]);
  return encodeKey([Math.floor(r() * 10), 'x'.repeat(Math.floor(r() * 60)), Math.floor(r() * space)]);
}

/** Every page must be accounted for: header + tree pages + freelist. */
function checkAccounting(pager: Pager, tree: BTree): void {
  const report = tree.checkIntegrity();
  expect(1 + report.pages + pager.freelistCount).toBe(pager.pageCount);
  expect(pager.pinnedCount()).toBe(0);
}

function checkAgainstModel(tree: BTree, model: Map<string, [Uint8Array, Uint8Array]>): void {
  const sorted = [...model.values()].sort((a, b) => compareBytes(a[0], b[0]));
  const c = tree.cursor();
  let i = 0;
  for (let ok = c.first(); ok; ok = c.next()) {
    expect(hex(c.key())).toBe(hex(sorted[i][0]));
    expect(hex(c.value())).toBe(hex(sorted[i][1]));
    i++;
  }
  expect(i).toBe(sorted.length);
  i = sorted.length - 1;
  for (let ok = c.last(); ok; ok = c.prev()) {
    expect(hex(c.key())).toBe(hex(sorted[i][0]));
    i--;
  }
  expect(i).toBe(-1);
  c.close();
}

describe('BTree', () => {
  it('supports basic put/get/delete on an empty tree', () => {
    const { pager } = openMemoryPager({ pageSize: 512 });
    const tree = new BTree(pager, BTree.create(pager));
    const k = encodeKey([1]);
    expect(tree.get(k)).toBeUndefined();
    tree.put(k, new Uint8Array([1, 2]));
    expect([...tree.get(k)!]).toEqual([1, 2]);
    tree.put(k, new Uint8Array([3]));
    expect([...tree.get(k)!]).toEqual([3]);
    expect(tree.delete(k)).toBe(true);
    expect(tree.delete(k)).toBe(false);
    expect(tree.get(k)).toBeUndefined();
    const c = tree.cursor();
    expect(c.first()).toBe(false);
    expect(c.last()).toBe(false);
    checkAccounting(pager, tree);
  });

  it('handles sequential inserts, range scans and seeks', () => {
    const { pager } = openMemoryPager({ pageSize: 512 });
    const tree = new BTree(pager, BTree.create(pager));
    const N = 5000;
    for (let i = 0; i < N; i++) tree.put(encodeKey([i]), encodeKey([`v${i}`]));
    const rep = tree.checkIntegrity();
    expect(rep.keys).toBe(N);
    expect(tree.count()).toBe(N);
    expect(rep.depth).toBeGreaterThan(1);

    const c = tree.cursor();
    expect(c.seek(encodeKey([1234]))).toBe(true);
    expect(hex(c.key())).toBe(hex(encodeKey([1234])));
    expect(c.seek(encodeKey([1234.5]))).toBe(true);
    expect(hex(c.key())).toBe(hex(encodeKey([1235])));
    expect(c.seek(encodeKey([N]))).toBe(false);
    let count = 0;
    for (let ok = c.seek(encodeKey([N - 10])); ok; ok = c.next()) count++;
    expect(count).toBe(10);
    c.close();

    // Delete everything in reverse: the tree must shrink back to a single root leaf.
    for (let i = N - 1; i >= 0; i--) expect(tree.delete(encodeKey([i]))).toBe(true);
    const after = tree.checkIntegrity();
    expect(after.keys).toBe(0);
    expect(after.pages).toBe(1);
    checkAccounting(pager, tree);
  });

  // BTREE_SEEDS=200 npm test -- btree  runs a longer stress pass.
  const seedCount = Number(process.env.BTREE_SEEDS ?? 6);
  for (const seed of Array.from({ length: seedCount }, (_, i) => i + 1)) {
    it(`matches a model under random operations (seed ${seed})`, () => {
      const pageSize = seed % 2 === 0 ? 512 : 1024;
      const { pager, reopen } = openMemoryPager({ pageSize, cacheSizeBytes: 64 * pageSize });
      const root = BTree.create(pager);
      let tree = new BTree(pager, root);
      let p = pager;
      const r = rng(seed);
      const model = new Map<string, [Uint8Array, Uint8Array]>();
      const space = seed <= 2 ? 300 : 3000;

      for (let step = 0; step < 6000; step++) {
        const op = r();
        const key = randomKey(r, space);
        const h = hex(key);
        if (op < 0.55) {
          const v = valueFor(r, pageSize);
          tree.put(key, v);
          model.set(h, [key, v]);
        } else if (op < 0.85) {
          expect(tree.delete(key)).toBe(model.delete(h));
        } else {
          const got = tree.get(key);
          const want = model.get(h);
          expect(got === undefined ? undefined : hex(got)).toBe(want === undefined ? undefined : hex(want[1]));
        }
        if (step % 1000 === 999) {
          checkAccounting(p, tree);
          checkAgainstModel(tree, model);
          // Commit, close, and reopen from storage to verify persistence.
          p.commit();
          p.close();
          p = reopen();
          tree = new BTree(p, root);
        }
      }
      // Drain: delete all remaining keys.
      for (const [, [k]] of model) expect(tree.delete(k)).toBe(true);
      const rep = tree.checkIntegrity();
      expect(rep.keys).toBe(0);
      checkAccounting(p, tree);
    });
  }

  it('rolls back uncommitted tree changes', () => {
    const { pager } = openMemoryPager({ pageSize: 512 });
    const root = BTree.create(pager);
    const tree = new BTree(pager, root);
    for (let i = 0; i < 500; i++) tree.put(encodeKey([i]), new Uint8Array(20));
    pager.commit();
    for (let i = 500; i < 2000; i++) tree.put(encodeKey([i]), new Uint8Array(20));
    for (let i = 0; i < 250; i++) tree.delete(encodeKey([i]));
    pager.rollback();
    const rep = tree.checkIntegrity();
    expect(rep.keys).toBe(500);
    checkAccounting(pager, tree);
  });

  it('destroy() returns every page to the freelist', () => {
    const { pager } = openMemoryPager({ pageSize: 512 });
    const tree = new BTree(pager, BTree.create(pager));
    for (let i = 0; i < 2000; i++) tree.put(encodeKey([i]), new Uint8Array(i % 50 === 0 ? 3000 : 10));
    tree.destroy();
    expect(pager.freelistCount).toBe(pager.pageCount - 1);
    expect(pager.pinnedCount()).toBe(0);
  });

  it('rejects oversized keys', () => {
    const { pager } = openMemoryPager({ pageSize: 512 });
    const tree = new BTree(pager, BTree.create(pager));
    expect(() => tree.put(new Uint8Array(tree.maxKeySize + 1), new Uint8Array(0))).toThrow(/key too large/);
    tree.put(new Uint8Array(tree.maxKeySize).fill(7), new Uint8Array(5000));
    expect(tree.get(new Uint8Array(tree.maxKeySize).fill(7))!.length).toBe(5000);
  });
});

describe('BTree.bulkLoadKeys', () => {
  for (const [seed, count, pageSize] of [[1, 0, 512], [2, 1, 512], [3, 30, 512], [4, 3000, 512], [5, 20000, 1024], [6, 5000, 4096]] as const) {
    it(`builds a valid tree from ${count} sorted keys (seed ${seed}, ${pageSize}-byte pages)`, () => {
      const { pager } = openMemoryPager({ pageSize, cacheSizeBytes: 64 * pageSize });
      const tree = new BTree(pager, BTree.create(pager));
      const r = rng(seed);
      const set = new Map<string, Uint8Array>();
      while (set.size < count) {
        // Mostly short keys, some up to the maximum key size (long separators, few cells per page).
        const len = r() < 0.9 ? 1 + Math.floor(r() * 12) : Math.floor(r() * tree.maxKeySize) + 1;
        const k = new Uint8Array(len);
        for (let i = 0; i < len; i++) k[i] = Math.floor(r() * 4);
        set.set(hex(k), k);
      }
      const sorted = [...set.values()].sort(compareBytes);
      // Pack in a shuffled physical order; `order` gives the sorted sequence.
      const phys = [...sorted].sort(() => r() - 0.5);
      const offs = new Int32Array(phys.length + 1);
      const total = phys.reduce((n, k) => n + k.length, 0);
      const keys = new Uint8Array(total);
      let o = 0;
      phys.forEach((k, i) => {
        offs[i] = o;
        keys.set(k, o);
        o += k.length;
      });
      offs[phys.length] = o;
      const pos = new Map(phys.map((k, i) => [hex(k), i]));
      const order = Int32Array.from(sorted.map((k) => pos.get(hex(k))!));
      tree.bulkLoadKeys(keys, offs, order);
      checkAccounting(pager, tree);
      const got: string[] = [];
      const c = tree.cursor();
      for (let ok = c.first(); ok; ok = c.next()) got.push(hex(c.key()));
      c.close();
      expect(got).toEqual(sorted.map(hex));
      // Backward iteration follows the prev links.
      const back: string[] = [];
      const c2 = tree.cursor();
      for (let ok = c2.last(); ok; ok = c2.prev()) back.push(hex(c2.key()));
      c2.close();
      expect(back).toEqual(sorted.map(hex).reverse());
      // The tree stays usable for ordinary writes.
      for (let i = 0; i < Math.min(2000, count); i++) {
        const k = sorted[Math.floor(r() * sorted.length)];
        if (r() < 0.5) tree.delete(k);
        else if (k.length < tree.maxKeySize) tree.put(new Uint8Array([...k, 9]), new Uint8Array(0));
      }
      checkAccounting(pager, tree);
      expect(pager.pinnedCount()).toBe(0);
    });
  }
});
