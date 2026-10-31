/// <reference lib="webworker" />
import { detectCapabilities } from '../../src/engine/vfs/capabilities.js';
import { OpfsVfs } from '../../src/engine/vfs/opfs.js';
import { Pager } from '../../src/engine/storage/pager.js';
import { BTree } from '../../src/engine/storage/btree.js';
import { encodeKey } from '../../src/engine/storage/key-codec.js';
import { SmaltError } from '../../src/engine/errors.js';

type Check = { name: string; ok: boolean; detail?: string };

async function run(): Promise<{ checks: Check[]; capabilities: unknown; timings: Record<string, number> }> {
  const checks: Check[] = [];
  const timings: Record<string, number> = {};
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  const capabilities = detectCapabilities();
  check('OPFS sync access handles available', OpfsVfs.isSupported());

  const vfs = new OpfsVfs({ rootDir: 'smaltdb-test' });
  await vfs.delete('it.db');
  const N = 50_000;

  let file = await vfs.open('it.db');
  let pager = Pager.open(file, { pageSize: 8192 });
  const root = BTree.create(pager);
  pager.catalogRoot = root;
  let tree = new BTree(pager, root);
  let t0 = performance.now();
  for (let i = 0; i < N; i++) tree.put(encodeKey([i]), encodeKey([`value-${i}`]));
  timings.insert50kMs = performance.now() - t0;
  t0 = performance.now();
  pager.commit();
  timings.commitMs = performance.now() - t0;
  timings.fileBytes = file.size();

  // Exclusive lock: a second handle on the same file must fail while the first is open.
  try {
    const second = await vfs.open('it.db');
    second.close();
    check('second sync handle is rejected while locked', false, 'opened twice');
  } catch (e) {
    check('second sync handle is rejected while locked', e instanceof SmaltError && e.code === 'SMALT_BUSY', String(e));
  }

  // Small durable transactions: commit latency including flush().
  const small = 200;
  t0 = performance.now();
  for (let i = 0; i < small; i++) {
    tree.put(encodeKey([N + i]), new Uint8Array(16));
    pager.commit();
  }
  timings.smallCommitAvgMs = (performance.now() - t0) / small;
  pager.close();

  // Reopen from OPFS and verify.
  file = await vfs.open('it.db');
  pager = Pager.open(file);
  tree = new BTree(pager, pager.catalogRoot);
  t0 = performance.now();
  const report = tree.checkIntegrity();
  timings.coldIntegrityCheckMs = performance.now() - t0;
  check('reopened tree has all keys', report.keys === N + small, `keys=${report.keys}`);
  const v = tree.get(encodeKey([12345]));
  check('point lookup after reopen', v !== undefined && new TextDecoder().decode(v).includes('value-12345'));
  check('no pinned pages', pager.pinnedCount() === 0);
  t0 = performance.now();
  for (let i = 0; i < N; i += 7) tree.get(encodeKey([i]));
  timings.lookupsWarmUsPerOp = ((performance.now() - t0) * 1000) / Math.ceil(N / 7);
  pager.close();
  await vfs.delete('it.db');
  check('cleanup', !(await vfs.exists('it.db')));
  return { checks, capabilities, timings };
}

run().then(
  (r) => postMessage({ ok: true, ...r }),
  (e) => postMessage({ ok: false, error: String((e as Error)?.stack ?? e) }),
);
