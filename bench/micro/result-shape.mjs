// Micro-benchmark: cost of materializing result rows as objects vs arrays.
// Run: node --expose-gc bench/micro/result-shape.mjs [arr-first]
const N = 1_000_000;
const id = new Float64Array(N), age = new Int32Array(N), score = new Float64Array(N);
const names = Array.from({length: 1000}, (_, i) => 'name' + i);
const nm = new Int32Array(N), flag = new Uint8Array(N);
for (let i = 0; i < N; i++) { id[i]=i; age[i]=i%90; score[i]=i*0.5; nm[i]=i%1000; flag[i]=i&1; }
const mkObj = (i) => ({id:id[i],name:names[nm[i]],age:age[i],score:score[i],active:flag[i]===1});
const mkArr = (i) => [id[i], names[nm[i]], age[i], score[i], flag[i]===1];
function t(label, fn, reps=7){ fn(); const ts=[]; for(let k=0;k<reps;k++){global.gc(); const s=performance.now(); fn(); ts.push(performance.now()-s);} ts.sort((a,b)=>a-b); console.log(label.padEnd(36), 'median', ts[reps>>1].toFixed(1),'ms'); }
const order = process.argv[2]==='arr-first';
const bo = () => { const o=new Array(N); for(let i=0;i<N;i++)o[i]=mkObj(i); return o; };
const ba = () => { const o=new Array(N); for(let i=0;i<N;i++)o[i]=mkArr(i); return o; };
if (order) { t('build arrays', ba); t('build objects', bo); } else { t('build objects', bo); t('build arrays', ba); }
for (const [label, f] of [['objects', bo], ['arrays', ba]]) {
  global.gc(); const m0=process.memoryUsage().heapUsed; globalThis.keep=f(); global.gc(); const m1=process.memoryUsage().heapUsed;
  console.log(`heap per ${label} row:`.padEnd(36), ((m1-m0)/N).toFixed(0), 'B'); globalThis.keep=null;
}
