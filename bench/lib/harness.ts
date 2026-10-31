/**
 * Minimal benchmark harness usable in Node and in browsers/workers (no dependencies).
 * Each case runs `iterations` times after warmup; we report the median and min wall time.
 */
export interface BenchCase {
  name: string;
  /** Operations performed per invocation (for ops/s reporting). */
  ops: number;
  setup?: () => void | Promise<void>;
  run: () => void | Promise<void>;
  teardown?: () => void | Promise<void>;
}

export interface BenchResult {
  suite: string;
  name: string;
  ops: number;
  samples: number;
  medianMs: number;
  minMs: number;
  opsPerSec: number;
  nsPerOp: number;
}

export interface BenchOptions {
  warmup?: number;
  iterations?: number;
  /** Stop sampling after this many ms per case (min 3 samples). */
  maxTimeMs?: number;
}

export async function runSuite(suite: string, cases: BenchCase[], opts: BenchOptions = {}): Promise<BenchResult[]> {
  const warmup = opts.warmup ?? 2;
  const iterations = opts.iterations ?? 10;
  const maxTime = opts.maxTimeMs ?? 5000;
  const results: BenchResult[] = [];
  for (const c of cases) {
    const times: number[] = [];
    const started = performance.now();
    for (let i = 0; i < warmup + iterations; i++) {
      if (c.setup) await c.setup();
      const t0 = performance.now();
      await c.run();
      const dt = performance.now() - t0;
      if (c.teardown) await c.teardown();
      if (i >= warmup) times.push(dt);
      if (times.length >= 3 && performance.now() - started > maxTime) break;
    }
    times.sort((a, b) => a - b);
    const median = times[times.length >> 1];
    results.push({
      suite,
      name: c.name,
      ops: c.ops,
      samples: times.length,
      medianMs: median,
      minMs: times[0],
      opsPerSec: (c.ops / median) * 1000,
      nsPerOp: (median * 1e6) / c.ops,
    });
  }
  return results;
}

export function formatResults(results: BenchResult[]): string {
  const rows = results.map((r) => [
    r.suite,
    r.name,
    r.medianMs.toFixed(2),
    Math.round(r.opsPerSec).toLocaleString('en-US'),
    r.nsPerOp.toFixed(0),
  ]);
  const header = ['suite', 'case', 'median ms', 'ops/s', 'ns/op'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => (i >= 2 ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}
