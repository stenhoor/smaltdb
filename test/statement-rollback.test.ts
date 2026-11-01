import { describe, expect, it } from 'vitest';
import { BTree } from '../src/engine/storage/btree.js';
import { Pager } from '../src/engine/storage/pager.js';
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

describe.each(['file', 'in-memory'] as const)('Pager statement savepoints (%s)', (mode) => {
  const seeds = Number(process.env.STMT_SEEDS ?? 6);
  for (const seed of Array.from({ length: seeds }, (_, i) => 101 + i)) {
    it(`statement rollback restores the exact pre-statement tree (seed ${seed})`, () => {
      const pageSize = 512;
      const opts = { pageSize, cacheSizeBytes: 32 * pageSize };
      const { pager, reopen } = mode === 'file' ? openMemoryPager(opts) : { pager: Pager.openMemory(opts), reopen: null };
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
      if (reopen === null) {
        expect(snapshot(tree)).toEqual(modelSnapshot(txnModel));
        tree.checkIntegrity();
        return;
      }
      pager.close();
      const p2 = reopen();
      const t2 = new BTree(p2, root);
      expect(snapshot(t2)).toEqual(modelSnapshot(txnModel));
      t2.checkIntegrity();
    });
  }
});

describe.each(['file', 'in-memory'] as const)('single-row INSERT without a statement journal (%s)', (mode) => {
  const open = async () => {
    const { Database } = await import('../src/engine/database.js');
    const { MemoryVfs } = await import('../src/engine/vfs/memory.js');
    return mode === 'file' ? Database.openFile(new MemoryVfs().openSync('x.db')) : Database.openMemory();
  };

  it('an index expression error leaves no partial row inside a transaction', async () => {
    const db = await open();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, j INT); CREATE INDEX tj ON t(abs(j)); BEGIN; INSERT INTO t VALUES (1, 5)');
    expect(() => db.exec('INSERT INTO t VALUES (2, -9223372036854775808)')).toThrow(/integer overflow/);
    expect(db.query('SELECT * FROM t').rows).toEqual([[1, 5]]);
    db.exec('COMMIT');
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('an oversized index key leaves no partial row inside a transaction', async () => {
    const db = await open();
    db.exec('CREATE TABLE u(id INTEGER PRIMARY KEY, s TEXT); CREATE INDEX us ON u(s); BEGIN');
    expect(() => db.prepare('INSERT INTO u VALUES (1, ?)').run(['x'.repeat(5000)])).toThrow(/index key too large/);
    expect(db.query('SELECT count(*) FROM u').rows).toEqual([[0]]);
    db.exec('COMMIT');
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('UPDATE keeps unchanged index entries and rewrites changed ones', async () => {
    const db = await open();
    db.exec("CREATE TABLE a(id INTEGER PRIMARY KEY, b INT, c TEXT); CREATE INDEX ab ON a(b); CREATE INDEX ac ON a(c); INSERT INTO a VALUES (1, 1, 'x'), (2, 2, 'y'), (3, 3, 'z')");
    db.exec("UPDATE a SET b = b + 10 WHERE id >= 2; UPDATE a SET c = 'longer text value' WHERE id = 1");
    expect(db.query('SELECT id FROM a INDEXED BY ab WHERE b > 5 ORDER BY id').rows).toEqual([[2], [3]]);
    expect(db.query("SELECT b FROM a INDEXED BY ac WHERE c = 'longer text value'").rows).toEqual([[1]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});
