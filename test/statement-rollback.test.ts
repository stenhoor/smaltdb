import { describe, expect, it } from 'vitest';
import { BTree } from '../src/engine/storage/btree.js';
import { encodeKey } from '../src/engine/storage/key-codec.js';
import { compareBytes } from '../src/engine/util/bytes.js';
import { hex, openMemoryPager, rng } from './helpers.js';

type Model = Map<string, [Uint8Array, Uint8Array]>;

function snapshot(tree: BTree): string[] {
  const out: string[] = [];
  const c = tree.cursor();
  for (let ok = c.first(); ok; ok = c.next()) out.push(hex(c.key()) + '=' + hex(c.value()));
  c.close();
  return out;
}

function modelSnapshot(m: Model): string[] {
  return [...m.values()].sort((a, b) => compareBytes(a[0], b[0])).map(([k, v]) => hex(k) + '=' + hex(v));
}

describe('Pager statement savepoints', () => {
  const seeds = Number(process.env.STMT_SEEDS ?? 6);
  for (const seed of Array.from({ length: seeds }, (_, i) => 101 + i)) {
    it(`statement rollback restores the exact pre-statement tree (seed ${seed})`, () => {
      const pageSize = 512;
      const { pager, reopen } = openMemoryPager({ pageSize, cacheSizeBytes: 32 * pageSize });
      const root = BTree.create(pager);
      const tree = new BTree(pager, root);
      pager.commit();
      const r = rng(seed);
      let committed: Model = new Map();
      let txnModel: Model = new Map();

      for (let stmt = 0; stmt < 300; stmt++) {
        pager.beginStatement();
        const stmtModel: Model = new Map(txnModel);
        const ops = 1 + Math.floor(r() * 60);
        for (let i = 0; i < ops; i++) {
          const k = encodeKey([Math.floor(r() * 400)]);
          if (r() < 0.65) {
            const v = new Uint8Array(r() < 0.05 ? 1500 : Math.floor(r() * 50)).fill(stmt & 0xff);
            tree.put(k, v);
            stmtModel.set(hex(k), [k, v]);
          } else {
            tree.delete(k);
            stmtModel.delete(hex(k));
          }
        }
        if (r() < Number(process.env.P_STMT_RB ?? 0.35)) {
          pager.rollbackStatement();
        } else {
          pager.commitStatement();
          txnModel = stmtModel;
        }
        expect(snapshot(tree)).toEqual(modelSnapshot(txnModel));
        const rep = tree.checkIntegrity();
        expect(1 + rep.pages + pager.freelistCount).toBe(pager.pageCount);
        // Occasionally end the transaction.
        const roll = r();
        if (roll < 0.1 || process.env.NO_TXN_RB) {
          pager.commit();
          committed = new Map(txnModel);
        } else if (roll < 0.15) {
          pager.rollback();
          txnModel = new Map(committed);
          expect(snapshot(tree)).toEqual(modelSnapshot(txnModel));
        }
      }
      pager.commit();
      pager.close();
      const p2 = reopen();
      const t2 = new BTree(p2, root);
      expect(snapshot(t2)).toEqual(modelSnapshot(txnModel));
      t2.checkIntegrity();
    });
  }
});
