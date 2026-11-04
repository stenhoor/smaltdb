// Engine-comparison report shared by the browser harness (bench/browser/run.mjs) and the Node harness
// (bench/node/run.mjs): per-workload median and spread, result agreement across engines and repetitions, ratios
// against a baseline engine with a verdict only when the min/max ranges do not overlap, and the saved JSON.
import { writeFileSync } from 'node:fs';

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stats = (xs) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length });
const fmt = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));

/**
 * `runs[engine]`: successful repetition results ({ engine, config, atomicCommits, version, openMs, results }).
 * Prints the report; with `file`, also writes { env, summary, failures, mismatches, raw }.
 */
export function report({ engines, runs, failures, baseline, env, file }) {
  const summary = {};
  for (const engine of engines) {
    const rs = runs[engine];
    if (!rs || rs.length === 0) continue;
    const workloads = rs[0].results.map((w) => w.workload);
    summary[engine] = {
      name: rs[0].engine,
      config: rs[0].config,
      atomicCommits: rs[0].atomicCommits,
      version: rs[0].version,
      open: stats(rs.map((r) => r.openMs)),
      workloads: Object.fromEntries(workloads.map((w, i) => [w, { ...stats(rs.map((r) => r.results[i].ms)), check: rs[0].results[i].check, ops: rs[0].results[i].ops }])),
    };
  }

  // Result agreement across engines and repetitions.
  const mismatches = [];
  for (const engine of Object.keys(summary)) {
    for (const r of runs[engine]) {
      for (const w of r.results) {
        const ref = summary[Object.keys(summary)[0]].workloads[w.workload];
        if (ref && w.check !== ref.check && !w.workload.startsWith('load') && !w.workload.includes('txns') && !w.workload.startsWith('bulk')) {
          mismatches.push(`${engine} / ${w.workload}: ${w.check.slice(0, 120)} vs ${ref.check.slice(0, 120)}`);
        }
      }
    }
  }

  for (const s of Object.values(summary)) {
    console.log(`== ${s.name}${s.version ? ' ' + s.version : ''}  [${s.config}]  atomic commits: ${s.atomicCommits ? 'yes' : 'NO'}  (n=${s.open.n})`);
    for (const [w, x] of Object.entries(s.workloads)) {
      const spread = ((x.max - x.min) / x.median) * 100;
      console.log(`  ${w.padEnd(40)} median ${fmt(x.median).padStart(8)} ms   range ${fmt(x.min)}–${fmt(x.max)} (±${spread.toFixed(0)}%)`);
    }
    console.log();
  }

  const base = summary[baseline];
  if (base) {
    console.log(`Ratio = ${base.name} time / engine time (>1 = faster than baseline). Verdict only when ranges do not overlap.`);
    for (const [engine, s] of Object.entries(summary)) {
      if (engine === baseline) continue;
      console.log(`\n  ${s.name}${s.atomicCommits !== base.atomicCommits ? '   ⚠ different durability than baseline (commit numbers not comparable)' : ''}`);
      for (const [w, x] of Object.entries(s.workloads)) {
        const b = base.workloads[w];
        if (!b) continue;
        const ratio = b.median / x.median;
        const verdict = x.max < b.min ? 'faster' : x.min > b.max ? 'slower' : 'overlap (no clear difference)';
        console.log(`    ${w.padEnd(40)} ${ratio.toFixed(2).padStart(6)}x   ${verdict}`);
      }
    }
  }
  if (failures.length) console.log('\nFailures:\n' + failures.map((f) => `  ${f.engine} rep ${f.rep}: ${f.error.split('\n')[0]}`).join('\n'));
  if (mismatches.length) console.log('\nRESULT MISMATCHES:\n  ' + [...new Set(mismatches)].slice(0, 10).join('\n  '));
  else console.log('\nAll engines returned identical results for every read workload.');

  if (file) {
    writeFileSync(file, JSON.stringify({ env, summary, failures, mismatches, raw: runs }, null, 2));
    console.log(`\nsaved ${file}`);
  }
  return { summary, mismatches };
}
