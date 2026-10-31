// OPFS read-cost probe: per-call cost of FileSystemSyncAccessHandle.read by size/pattern. Bundle and run in a worker.
/// <reference lib="webworker" />
(async () => {
  const root = await navigator.storage.getDirectory();
  const fh = await root.getFileHandle('probe.bin', { create: true });
  const h: any = await (fh as any).createSyncAccessHandle();
  const PAGES = 2000, PS = 8192;
  const fill = new Uint8Array(PS * 100);
  for (let i = 0; i < PAGES; i += 100) h.write(fill, { at: i * PS });
  h.flush();
  const offs = Array.from({ length: 1544 }, (_, i) => ((i * 7919) % PAGES) * PS);
  const res: Record<string, number> = {};
  const time = (name: string, size: number, offsets: number[]) => { const b = new Uint8Array(size); const t0 = performance.now(); for (const o of offsets) h.read(b, { at: o }); res[name] = Math.round(((performance.now() - t0) * 1000) / offsets.length); };
  const rnd = (n: number, align: number) => Array.from({ length: n }, (_, i) => ((i * 7919) % Math.floor((PAGES * PS) / align)) * align);
  time('random 4 KiB', 4096, rnd(1500, 4096));
  time('random 8 KiB', 8192, rnd(1500, 8192));
  time('random 64 KiB', 65536, rnd(200, 65536));
  time('sequential 8 KiB', 8192, Array.from({ length: 1500 }, (_, i) => i * PS));
  time('same 8 KiB page repeatedly', 8192, Array.from({ length: 1500 }, () => 0));
  time('random 8 KiB again (2nd pass)', 8192, rnd(1500, 8192));
  h.close();
  await root.removeEntry('probe.bin');
  postMessage(res);
})();
