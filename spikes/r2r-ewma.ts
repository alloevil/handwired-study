// Spike A: R2R EWMA controller (synthetic CMP-like process) as a handwired circuit.
// Trainable constants: lambda (EWMA weight) and g (controller gain). Everything here is SYNTHETIC data.
import {Circuit, type Wire, emitClampExact} from '../vendor/handwired/src/runtime/numeric-ui-core.ts'

const N = 40            // runs (wafers) per lot
const T = 500           // target removal, nm
const B_TRUE = 10       // true removal rate, nm/s
const B_NOM = 9         // model's removal rate (10% mismatch)
const U_MIN = 20, U_MAX = 80   // actuator limits, s
const A0_GUESS = 0

function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let v = Math.imul(seed ^ seed >>> 15, 1 | seed); v = v + Math.imul(v ^ v >>> 7, 61 | v) ^ v; return ((v ^ v >>> 14) >>> 0) / 4294967296 } }
function gauss(r: () => number) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()) }
// disturbance z_t = offset_t + noise: linear pad-wear drift + random walk + white noise
function makeLot(seed: number) {
  const r = rng(seed); const z: number[] = []; let walk = 0
  const drift = -1.5 - r()          // nm per run
  for (let t = 0; t < N; t++) { walk += 2 * gauss(r); z.push(Math.fround(20 + drift * t + walk + 5 * gauss(r))) }
  return z
}

// ---- the circuit: source cells [lambda, g, z_0..z_{N-1}]
const circuit = new Circuit(2 + N)
const lam = circuit.source(0), g = circuit.source(1)
circuit.assumeRange(lam, 0, 1); circuit.assumeRange(g, 0, 0.5)
const z = Array.from({length: N}, (_, t) => { const w = circuit.source(2 + t); circuit.assumeRange(w, -500, 500); return w })
const uMin = circuit.constant(U_MIN), uMax = circuit.constant(U_MAX)
circuit.assumeRange(uMin, U_MIN, U_MIN); circuit.assumeRange(uMax, U_MAX, U_MAX)
let aHat: Wire = circuit.constant(A0_GUESS)
const oneMinusLam = circuit.roundAffine([[lam, -1]], 1)
const yWires: Wire[] = []
for (let t = 0; t < N; t++) {
  // JS: u = clamp((T - aHat) * g, U_MIN, U_MAX)
  const err = circuit.roundAffine([[aHat, -1]], T)
  const uRaw = circuit.multiply(err, g)
  const u = emitClampExact(circuit, uRaw, uMin, uMax)
  // plant (in the circuit so the gradient sees the closed loop): y = z + B_TRUE * u
  const y = circuit.roundAffine([[z[t]!, 1], [u, B_TRUE]])
  yWires.push(y)
  // JS: aHat = lam * (y - B_NOM * u) + (1 - lam) * aHat
  const obs = circuit.roundAffine([[y, 1], [u, -B_NOM]])
  aHat = circuit.roundAffine([[circuit.multiply(lam, obs), 1], [circuit.multiply(oneMinusLam, aHat), 1]])
  circuit.assumeRange(aHat, -2000, 2000)
}
const width = () => circuit.sourceSize + circuit.operations.length

// ---- plain JS float64 reference of the same rule
function jsRun(l: number, gg: number, zs: number[]) {
  let a = A0_GUESS; const ys: number[] = []
  for (let t = 0; t < N; t++) { const u = Math.min(U_MAX, Math.max(U_MIN, (T - a) * gg)); const y = zs[t]! + B_TRUE * u; ys.push(y); a = l * (y - B_NOM * u) + (1 - l) * a }
  return ys
}
const mse = (ys: ArrayLike<number>) => { let s = 0; for (let i = 0; i < ys.length; i++) s += (ys[i]! - T) ** 2; return s / ys.length }

function circuitLossGrad(l: number, gg: number, zs: number[]) {
  const src = new Float32Array([l, gg, ...zs])
  const values = circuit.evaluateReference(src)
  const outGrad = new Float32Array(width())
  let loss = 0
  for (const w of yWires) { const e = values[w]! - T; loss += e * e / N; outGrad[w] = 2 * e / N }
  const grads = circuit.backpropagateReference(values, outGrad)
  return {loss, dl: grads[0]!, dg: grads[1]!, values, src}
}

const train = Array.from({length: 16}, (_, i) => makeLot(100 + i))
const test = Array.from({length: 16}, (_, i) => makeLot(900 + i))
const meanJs = (l: number, gg: number, lots: number[][]) => lots.reduce((s, zs) => s + mse(jsRun(l, gg, zs)), 0) / lots.length

console.log(`circuit: ${circuit.operations.length} built ops, live ${(() => { const p = circuit.compileTensorProgram(yWires); return p.valueCount - p.sourceSize })()} , ${N} runs/lot`)

// 1) exactness: reference vs compiled tensor evaluator (bitwise), and vs float64 JS
{
  const ev = circuit.createTensorEvaluator(yWires)
  let maxDiff64 = 0, tensorMismatch = 0
  for (const zs of [...train, ...test]) for (const [l, gg] of [[0.3, 1 / B_NOM], [0.05, 0.08], [0.9, 0.12]] as const) {
    const src = new Float32Array([l, gg, ...zs]); const ref = circuit.evaluateReference(src); const ten = ev(src)
    yWires.forEach((w, i) => { if (!Object.is(ref[w]! + 0, ten[i]! + 0)) tensorMismatch++ })
    const js = jsRun(Math.fround(l), Math.fround(gg), zs)
    yWires.forEach((w, i) => { maxDiff64 = Math.max(maxDiff64, Math.abs(ref[w]! - js[i]!)) })
  }
  console.log(`exactness: reference vs tensor mismatches = ${tensorMismatch} / ${32 * 3 * N}; max |circuit(FP32) - JS float64| = ${maxDiff64.toExponential(3)} nm`)
}

// 2) gradient check vs central differences on the float64 JS reference
{
  for (const [l, gg] of [[0.3, 0.1], [0.15, 0.09], [0.6, 0.105]] as const) {
    let dl = 0, dg = 0
    for (const zs of train) { const r = circuitLossGrad(l, gg, zs); dl += r.dl / train.length; dg += r.dg / train.length }
    const h = 1e-4
    const ndl = (meanJs(l + h, gg, train) - meanJs(l - h, gg, train)) / (2 * h)
    const ndg = (meanJs(l, gg + h * 0.01, train) - meanJs(l, gg - h * 0.01, train)) / (2 * h * 0.01)
    console.log(`grad check at lambda=${l}, g=${gg}: backprop dL/dlambda=${dl.toFixed(3)} vs central ${ndl.toFixed(3)}; dL/dg=${dg.toFixed(1)} vs central ${ndg.toFixed(1)}`)
  }
}

// 3) baselines: hand-tuned constants and grid search (float64 JS)
const hand = {l: 0.3, g: 1 / B_NOM}
console.log(`hand-tuned lambda=0.3 g=1/B_NOM=${(1 / B_NOM).toFixed(4)}: train MSE ${meanJs(hand.l, hand.g, train).toFixed(2)}, test MSE ${meanJs(hand.l, hand.g, test).toFixed(2)}`)
let best = {l: 0, g: 0, m: Infinity}; let evals = 0
for (let l = 0.02; l <= 1.0001; l += 0.02) for (let gg = 0.06; gg <= 0.14001; gg += 0.002) { evals++; const m = meanJs(l, gg, train); if (m < best.m) best = {l, g: gg, m} }
console.log(`grid search (${evals} evals, 50x41): lambda=${best.l.toFixed(2)} g=${best.g.toFixed(4)} train MSE ${best.m.toFixed(2)}, test MSE ${meanJs(best.l, best.g, test).toFixed(2)}`)

// 4) gradient training through the circuit (Adam), starting from the hand-tuned constants
{
  let l = hand.l, gg = hand.g; const m = [0, 0], v = [0, 0]; const lr = [0.01, 0.002]; const t0 = performance.now()
  for (let step = 1; step <= 300; step++) {
    let dl = 0, dg = 0, loss = 0
    for (const zs of train) { const r = circuitLossGrad(l, gg, zs); dl += r.dl / train.length; dg += r.dg / train.length; loss += r.loss / train.length }
    const gr = [dl, dg]; const p = [l, gg]
    for (let k = 0; k < 2; k++) { m[k] = 0.9 * m[k]! + 0.1 * gr[k]!; v[k] = 0.999 * v[k]! + 0.001 * gr[k]! ** 2; p[k] = p[k]! - lr[k]! * (m[k]! / (1 - 0.9 ** step)) / (Math.sqrt(v[k]! / (1 - 0.999 ** step)) + 1e-8) }
    l = Math.min(1, Math.max(0, p[0]!)); gg = Math.min(0.5, Math.max(0, p[1]!))
    if (step === 1 || step % 50 === 0) console.log(`  adam step ${step}: train MSE(circuit) ${loss.toFixed(2)} lambda=${l.toFixed(4)} g=${gg.toFixed(4)}`)
  }
  console.log(`gradient-trained: lambda=${l.toFixed(4)} g=${gg.toFixed(4)} train MSE ${meanJs(l, gg, train).toFixed(2)}, test MSE ${meanJs(l, gg, test).toFixed(2)}  (300 steps x 16 lots = 4800 forward+backward, ${((performance.now() - t0) / 1000).toFixed(1)} s)`)
}
