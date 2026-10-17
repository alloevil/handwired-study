// Minimal case for the affine-mode mismatch: lin(lin(x)) is composed into one affine by the builder.
import {Circuit} from '../vendor/handwired/src/runtime/numeric-ui-core.ts'
const f = Math.fround
const c = new Circuit(1); const x = c.source(0); c.assumeRange(x, -100, 100)
const k1 = f(0.7), b1 = f(0.3), k2 = f(1.3), b2 = f(-2.1)
const y1 = c.affine([[x, k1]], b1); const y2 = c.affine([[y1, k2]], b2)
let mism = 0, n = 0, ex = ''
for (let i = 0; i < 10000; i++) { const xv = f(-100 + i * 0.02); const v = c.evaluateReference(new Float32Array([xv])); const js = f(f(b2) + f(k2 * f(f(b1) + f(k1 * xv)))); n++; if (v[y2] !== js) { mism++; if (!ex) ex = `x=${xv}: circuit ${v[y2]} vs JS-fround ${js}` } }
console.log(`affine(affine(x)): ${mism}/${n} differ from step-by-step FP32 JS; e.g. ${ex}; ops built ${c.operations.length}, live ${(() => { const p = c.compileTensorProgram([y2]); return p.valueCount - p.sourceSize })()}`)
