// Spike B part 2: backprop gradients vs central differences of the float64 JS program, on random programs.
import {Circuit, type Wire, emitCompare, emitSelect} from '../vendor/handwired/src/runtime/numeric-ui-core.ts'
const f = Math.fround
function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let v = Math.imul(seed ^ seed >>> 15, 1 | seed); v = v + Math.imul(v ^ v >>> 7, 61 | v) ^ v; return ((v ^ v >>> 14) >>> 0) / 4294967296 } }
type Node = {kind: 'add' | 'lin' | 'mul' | 'sel', a: number, b: number, c: number, d: number, k: number, bias: number}
const N_IN = 3
const r = rng(7)
let checked = 0, agree = 0, nearKink = 0, worst = 0; const worstCases: string[] = []
for (let p = 0; p < 200; p++) {
  const len = 3 + Math.floor(r() * 8)
  const kinds: Node['kind'][] = ['add', 'lin', 'mul', 'sel']
  const prog: Node[] = Array.from({length: len}, (_, i) => { const pk = () => Math.floor(r() * (N_IN + i)); return {kind: kinds[Math.floor(r() * 4)]!, a: pk(), b: pk(), c: pk(), d: pk(), k: f(r() * 2 - 1), bias: f(r() * 4 - 2)} })
  const c = new Circuit(N_IN); const w: Wire[] = []
  for (let i = 0; i < N_IN; i++) { const s = c.source(i); c.assumeRange(s, -4, 4); w.push(s) }
  for (const n of prog) { const A = w[n.a]!, B = w[n.b]!
    w.push(n.kind === 'add' ? c.roundAffine([[A, 1], [B, 1]]) : n.kind === 'lin' ? c.roundAffine([[A, n.k]], n.bias) : n.kind === 'mul' ? c.multiply(A, B) : emitSelect(c, emitCompare(c, A, '>', B), w[n.d]!, w[n.c]!)) }
  const out = w[w.length - 1]!
  const js = (x: number[]) => { const v = [...x]; for (const n of prog) { const A = v[n.a]!, B = v[n.b]!; v.push(n.kind === 'add' ? A + B : n.kind === 'lin' ? n.k * A + n.bias : n.kind === 'mul' ? A * B : (A > B ? v[n.c]! : v[n.d]!)) } return v[v.length - 1]! }
  for (let t = 0; t < 5; t++) {
    const x = Array.from({length: N_IN}, () => f(r() * 6 - 3))
    const vals = c.evaluateReference(new Float32Array(x)); const og = new Float32Array(vals.length); og[out] = 1
    const g = c.backpropagateReference(vals, og)
    for (let i = 0; i < N_IN; i++) {
      const h = 1e-6; const xp = [...x], xm = [...x]; xp[i]! += h; xm[i]! -= h
      const fd = (js(xp) - js(xm)) / (2 * h)
      // a branch flip inside +-h, or very large values, makes central differences meaningless: flag it
      const kink = Math.abs(fd) > 1e5 || js(xp) - js(x) - (js(x) - js(xm)) > 1e-3 * Math.max(1, Math.abs(js(x)))
      checked++
      const err = Math.abs(g[i]! - fd) / Math.max(1, Math.abs(fd))
      if (kink) { nearKink++; continue }
      if (err < 1e-3) agree++; else if (worstCases.length < 3) worstCases.push(JSON.stringify({p, i, backprop: g[i], fd}))
      worst = Math.max(worst, err)
    }
  }
}
console.log(`gradient check: ${checked} (program, input, coordinate) triples; ${nearKink} skipped as branch flip within h; ${agree}/${checked - nearKink} agree within 1e-3 relative; worst ${worst.toExponential(2)}`)
console.log('disagreements:', worstCases)
