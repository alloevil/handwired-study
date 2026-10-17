// Shows issue #1's point on an FDC-style alarm: a threshold constant gets zero gradient through emitCompare.
import {Circuit, emitCompare} from '../vendor/handwired/src/runtime/numeric-ui-core.ts'
const c = new Circuit(2) // [sensor, threshold]
const x = c.source(0), thr = c.source(1)
c.assumeRange(x, 0, 100); c.assumeRange(thr, 0, 100)
const alarm = emitCompare(c, x, '>', thr)
for (const [xv, tv] of [[60, 50], [40, 50], [50.0001, 50]]) {
  const vals = c.evaluateReference(new Float32Array([xv, tv]))
  const og = new Float32Array(vals.length); og[alarm] = 1
  const gr = c.backpropagateReference(vals, og)
  console.log(`x=${xv} thr=${tv}: alarm=${vals[alarm]} d alarm/d thr=${gr[1]} d alarm/d x=${gr[0]}  (ops=${c.operations.length})`)
}
