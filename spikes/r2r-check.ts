// Sensitivity check for spike A: why did the coarse grid miss? (imports the model by re-running the same JS reference)
const N = 40, T = 500, B_TRUE = 10, B_NOM = 9, U_MIN = 20, U_MAX = 80
function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let v = Math.imul(seed ^ seed >>> 15, 1 | seed); v = v + Math.imul(v ^ v >>> 7, 61 | v) ^ v; return ((v ^ v >>> 14) >>> 0) / 4294967296 } }
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()) }
function makeLot(seed: number) { const r = rng(seed); const z: number[] = []; let walk = 0; const drift = -1.5 - r(); for (let t = 0; t < N; t++) { walk += 2 * gauss(r); z.push(Math.fround(20 + drift * t + walk + 5 * gauss(r))) } return z }
function jsRun(l: number, gg: number, zs: number[]) { let a = 0; const ys: number[] = []; let clamps = 0; for (let t = 0; t < N; t++) { const raw = (T - a) * gg; if (raw < U_MIN || raw > U_MAX) clamps++; const u = Math.min(U_MAX, Math.max(U_MIN, raw)); const y = zs[t]! + B_TRUE * u; ys.push(y); a = l * (y - B_NOM * u) + (1 - l) * a } return {ys, clamps} }
const train = Array.from({length: 16}, (_, i) => makeLot(100 + i))
const m = (l: number, g: number) => train.reduce((s, zs) => s + jsRun(l, g, zs).ys.reduce((q, y) => q + (y - T) ** 2, 0) / N, 0) / train.length
for (const g of [0.106, 0.108, 0.110, 0.1105, 0.111, 0.1111, 0.1115, 0.112, 0.114]) console.log(`lambda=0.788 g=${g}: MSE ${m(0.788, g).toFixed(2)}`)
console.log('clamp hits at hand-tuned (0.3,1/9):', train.map(zs => jsRun(0.3, 1 / 9, zs).clamps).join(','))
let best = {l: 0, g: 0, v: Infinity}; let n = 0
for (let l = 0.5; l <= 1.0001; l += 0.005) for (let g = 0.105; g <= 0.117; g += 0.0001) { n++; const v = m(l, g); if (v < best.v) best = {l, g, v} }
console.log(`fine grid (${n} evals): lambda=${best.l.toFixed(3)} g=${best.g.toFixed(4)} MSE ${best.v.toFixed(2)}`)
