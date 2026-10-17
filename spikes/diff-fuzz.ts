// Spike B: seeded random differential test. Each random program is built twice: as a handwired circuit and as plain JS.
// Compared: circuit.evaluateReference vs compiled tensor evaluator (bitwise), vs JS with Math.fround after every op
// (the documented FP32 contract), and vs plain float64 JS (what "same as your JS" would naively mean).
import {Circuit, type Wire, emitCompare, emitMaximumExact, emitMinimumExact, emitSelect} from '../vendor/handwired/src/runtime/numeric-ui-core.ts'
const f = Math.fround
function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let v = Math.imul(seed ^ seed >>> 15, 1 | seed); v = v + Math.imul(v ^ v >>> 7, 61 | v) ^ v; return ((v ^ v >>> 14) >>> 0) / 4294967296 } }
type Node = {kind: 'add' | 'lin' | 'mul' | 'max' | 'min' | 'sel', a: number, b: number, c: number, d: number, k: number, bias: number}
const N_IN = 4
const EDGE = [0, -0, 1e-30, -1e-38, 1.4e-45, 100, -100, 99.99999, 0.1, 1 / 3, 50, 50]
function genProgram(r: () => number, len: number): Node[] {
  const kinds: Node['kind'][] = ['add', 'lin', 'mul', 'max', 'min', 'sel']
  const pick = (i: number) => Math.floor(r() * (N_IN + i))
  return Array.from({length: len}, (_, i) => ({kind: kinds[Math.floor(r() * kinds.length)]!, a: pick(i), b: pick(i), c: pick(i), d: pick(i), k: f((r() * 4 - 2)), bias: f(r() * 20 - 10)}))
}
function buildCircuit(prog: Node[], mode: 'affine' | 'roundAffine') {
  const c = new Circuit(N_IN); const w: Wire[] = []
  for (let i = 0; i < N_IN; i++) { const s = c.source(i); c.assumeRange(s, -100, 100); w.push(s) }
  const aff = mode === 'affine' ? c.affine.bind(c) : c.roundAffine.bind(c)
  for (const n of prog) {
    const A = w[n.a]!, B = w[n.b]!
    switch (n.kind) {
      case 'add': w.push(aff([[A, 1], [B, 1]])); break
      case 'lin': w.push(aff([[A, n.k]], n.bias)); break
      case 'mul': w.push(c.multiply(A, B)); break
      case 'max': w.push(emitMaximumExact(c, A, B)); break
      case 'min': w.push(emitMinimumExact(c, A, B)); break
      case 'sel': w.push(emitSelect(c, emitCompare(c, A, '>', B), w[n.d]!, w[n.c]!)); break
    }
  }
  return {c, w}
}
function runJs(prog: Node[], x: number[], fr: boolean) {
  const R = fr ? f : (v: number) => v; const v = [...x]
  for (const n of prog) {
    const A = v[n.a]!, B = v[n.b]!
    switch (n.kind) {
      case 'add': v.push(R(A + B)); break
      case 'lin': v.push(R(R(n.bias) + R(R(n.k) * A))); break
      case 'mul': v.push(R(A * B)); break
      case 'max': v.push(A >= B ? A : B); break     // emitMaximumExact: ties return the first operand
      case 'min': v.push(A <= B ? A : B); break
      case 'sel': v.push(A > B ? v[n.c]! : v[n.d]!); break
    }
  }
  return v
}
const same = (a: number, b: number) => a === b || (Number.isNaN(a) && Number.isNaN(b)) // ignores sign of zero, like the docs
const r = rng(20261017)
const stats: Record<string, number> = {}
const inc = (k: string, by = 1) => { stats[k] = (stats[k] ?? 0) + by }
let firstMismatch: string | null = null, maxRel64 = 0; const rels: number[] = []
const PROGRAMS = 300, INPUTS = 40
for (let p = 0; p < PROGRAMS; p++) {
  const prog = genProgram(r, 4 + Math.floor(r() * 12))
  for (const mode of ['roundAffine', 'affine'] as const) {
    let built
    try { built = buildCircuit(prog, mode) } catch (e) { inc(`${mode}: builder refused`); continue }
    const {c, w} = built
    const roots = w.slice(N_IN)
    const ev = c.createTensorEvaluator(roots)
    inc(`${mode}: programs built`)
    for (let t = 0; t < INPUTS; t++) {
      const x = Array.from({length: N_IN}, () => f(r() < 0.3 ? EDGE[Math.floor(r() * EDGE.length)]! : r() * 200 - 100))
      const src = new Float32Array(x)
      const ref = c.evaluateReference(src); const ten = ev(src)
      const jsF = runJs(prog, x, true), js64 = runJs(prog, x, false)
      roots.forEach((wire, i) => {
        inc(`${mode}: values compared`)
        if (!same(ref[wire]!, ten[i]!)) inc(`${mode}: reference != tensor`)
        if (!same(ref[wire]!, jsF[N_IN + i]!)) { inc(`${mode}: reference != JS-fround`); if (mode === 'roundAffine' && firstMismatch === null) firstMismatch = JSON.stringify({p, i, prog: prog[i], ref: ref[wire], js: jsF[N_IN + i]}) }
        if (!same(ref[wire]!, js64[N_IN + i]!)) {
          inc(`${mode}: reference != JS-float64`)
          const d = Math.abs(ref[wire]! - js64[N_IN + i]!) / Math.max(1e-30, Math.abs(js64[N_IN + i]!)); if (Number.isFinite(d) && mode === 'roundAffine') { maxRel64 = Math.max(maxRel64, d); rels.push(d) }
        }
        if (!Number.isFinite(ref[wire]!)) inc(`${mode}: nonfinite outputs`)
      })
    }
  }
}
console.log(`seed 20261017, ${PROGRAMS} random programs x ${INPUTS} inputs (30% edge values incl. -0, subnormals, ties, range ends)`)
for (const [k, v] of Object.entries(stats).sort()) console.log(`  ${k}: ${v}`)
console.log(`  max relative |circuit - float64 JS| (roundAffine, finite): ${maxRel64.toExponential(3)}`)
rels.sort((x, y) => x - y); const q = (p: number) => rels[Math.floor(p * (rels.length - 1))]!.toExponential(2)
console.log(`  roundAffine vs float64 relative error over ${rels.length} differing values: median ${q(0.5)}, p99 ${q(0.99)}; >1e-3 (gross, e.g. branch flip or underflow): ${rels.filter(d => d > 1e-3).length}`)
console.log(`  first roundAffine mismatch vs JS-fround: ${firstMismatch}`)

// ---- boundary probes
console.log('boundary probes:')
{
  const c = new Circuit(2); const a = c.source(0), b = c.source(1); c.assumeRange(a, 0, 2 ** 25); c.assumeRange(b, 0, 2 ** 25)
  const s = c.roundAffine([[a, 1], [b, 1]])
  const v = c.evaluateReference(new Float32Array([2 ** 24, 1]))
  console.log(`  2^24 + 1: circuit ${v[s]}, JS float64 ${2 ** 24 + 1}, JS fround ${f(2 ** 24 + 1)}`)
  const v2 = c.evaluateReference(new Float32Array([f(0.1), f(0.2)]))
  console.log(`  0.1 + 0.2: circuit ${v2[s]}, JS float64 ${0.1 + 0.2}, JS fround ${f(f(0.1) + f(0.2))}`)
}
{
  const c = new Circuit(1); const a = c.source(0); c.assumeRange(a, -100, 100)
  c.roundAffine([[a, 2]])
  for (const bad of [NaN, Infinity, 101]) { try { c.evaluateReference(new Float32Array([bad])); console.log(`  input ${bad}: accepted`) } catch (e) { console.log(`  input ${bad}: refused -> ${String((e as Error).message).slice(0, 90)}`) } }
}
{
  const {emitMaximum} = await import('../vendor/handwired/src/runtime/numeric-ui-core.ts')
  const c = new Circuit(2); const a = c.source(0), b = c.source(1); c.assumeRange(a, -(2 ** 25), 2 ** 25); c.assumeRange(b, -(2 ** 25), 2 ** 25)
  const m = emitMaximum(c, a, b), me = emitMaximumExact(c, a, b)
  const v = c.evaluateReference(new Float32Array([2 ** 24, -1]))
  console.log(`  max(2^24, -1): emitMaximum ${v[m]}, emitMaximumExact ${v[me]}, Math.max ${Math.max(2 ** 24, -1)}  (docs say emitMaximum gives 16777215)`)
}
