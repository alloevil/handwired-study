# 方案 B：验证 handwired "结果和原 JS 完全一致" 这个说法

> 写于 2026-10-17（PT）。被测版本：`chenglou/handwired` main @ `257856e`（2026-10-16 17:33 PT）。
> 风格参照 paired-eval / verify-claims：每条说法变成一个可重跑的 claim，带命令、期望和实测。
> 标注约定：**[事实]** 有链接或本机实测；**[推断]** 是我的判断，未验证。

## 1. 目标

README 的说法是 "Turn your regular JavaScript code into a neural net; no training, exact, yet also fully differentiable!"（[README](https://github.com/chenglou/handwired/blob/main/README.md)）。这句话里有三个可以验证的说法：

1. **exact**：电路算出来的值和原 JS 一样；
2. **跨后端一致**：CPU 求值和编译后的张量求值（以及 WebGPU）一样；
3. **fully differentiable**：反传梯度是对的。

先读文档，把"exact"到底指什么定下来，再分层验证，最后写成一篇 claims 清单 + 博客。

## 2. 先把说法读准（阅读结论）

- **[事实]** "exact" 在文档里定义为**等于逐步 FP32 计算**（每步 `Math.fround`），忽略零的符号；**不是**等于 JS 的 float64。原话："Exactness means equality to the stated FP32 calculation, ignoring the sign of zero, not equality to arbitrary JavaScript float64 arithmetic."（[Macro contracts](https://github.com/chenglou/handwired/blob/main/docs/execution-model.md#macro-contracts)）
- **[事实]** 没有自动把 JS 源码转成电路的工具，要用 builder API 手写（[docs/README.md](https://github.com/chenglou/handwired/blob/main/docs/README.md)）。所以"和原 JS 一致"的意思是：你手写的电路和你手写的 JS 参照对得上，要靠你自己的测试证明（官方 [template/toggle.test.ts](https://github.com/chenglou/handwired/blob/main/template/toggle.test.ts) 就是这么做的）。
- **[事实]** 文档自己承认："That the two evaluators agree doesn't show that a program does what the JavaScript it replaces did."（[Compilation](https://github.com/chenglou/handwired/blob/main/docs/execution-model.md#compilation)）
- **[事实]** builder 会做改写：少于 4 项的普通 affine 会被内联到读它的运算里，常量折进 bias；`roundAffine`、`multiply`、`select` 保留舍入点（同上）。`tests/runtime/builder-differential.test.ts` 的注释也写明 "Rewrites legally change FP32 rounding"，所以它用相对容差比较。
- **[事实]** 支持的 JS 子集：只有 FP32 标量；四种指令 `affine`、`reglu`、`boolean`、`index`；比较、min/max、select、clamp 是宏；数组靠 `indexRead`（下标必须是整数、区间在 ±2^24 内）；**没有运行时次数的循环**，循环要写成固定上限的展开、树、表或对每个元素做同样的事（[patterns.md](https://github.com/chenglou/handwired/blob/main/docs/patterns.md)）；没有除法、字符串、对象。
- **[事实]** 后端：`src/runtime` 全部是 CPU 上的 JS，"Tensor" 指稀疏矩阵分层，不是 GPU；只有 JSON search demo 跑 WebGPU（[Backends](https://github.com/chenglou/handwired/blob/main/docs/execution-model.md#backends)）。GPU 代码在测试里用 WGSL 解释器跑；真机 GPU 只在 Apple M5 Max + Metal + Chrome 155 上对过（[src/json-search/README.md](https://github.com/chenglou/handwired/blob/main/src/json-search/README.md)）。
- **[事实]** 仓库已经有的验证：随机电路 reference vs tensor（`tests/runtime/random-hardened.test.ts`）、builder 改写差分（带容差）、`lab/trace-compiler` 里五路对比（含原生 JS 执行）。**我们的增量**是：独立写的黑盒差分（不复用它的随机生成器）、直接对原生 JS（fround 和 float64 两种）、边界值清单、梯度对数值差分，以及 GPU 一致性。

## 3. 方法：四层对比

每个随机程序同时生成两份：handwired 电路 和 普通 JS 函数。每组输入算四个值：

| 记号 | 是什么 |
| --- | --- |
| `REF` | `circuit.evaluateReference`（官方定义的真值） |
| `TEN` | `circuit.createTensorEvaluator` 编译后的求值 |
| `JS32` | 普通 JS，每一步后 `Math.fround`（文档里的 FP32 合约） |
| `JS64` | 普通 JS float64（用户心里的"原 JS"） |
| （后续）`GPU` | 同一程序写成 WGSL，在 WebGPU 上跑 |

比较规则：`===`，NaN 对 NaN 算相等，忽略 -0/+0（与文档一致），另外单独统计零的符号差异。

## 4. 实验清单

1. **差分测试**：随机程序（add、线性、乘法、精确 max/min、比较+select、clamp），两种构建方式：`affine`（会被 builder 合并）和 `roundAffine`（保留舍入）。
2. **模糊测试**：30% 输入取边界值（0、-0、1e-30、负次正规数、最小次正规数 1.4e-45、区间端点、相等值制造 tie、0.1、1/3）。以后可接 fast-check 做 shrinking。
3. **边界值专项**：
   - 大整数：2^24+1、2^24 附近的加法和 `indexRead` 下标；
   - NaN / ±Infinity / 越界输入：是否被源表校验拒绝；
   - `emitMaximum` vs `emitMaximumExact`（文档说前者 max(2^24,-1)=16777215）；
   - `emitCompare` 的阈值不是 FP32 值时（文档举例 5/24）；
   - 次正规差值的比较（CPU 正确，flush-to-zero 的 GPU 可能不对，文档有写）；
   - **循环上限**：把 `while` 写成固定上限 K 的展开，测输入需要 >K 次迭代时的行为（预期：静默错误，需要自己加溢出标志位）。
4. **CPU vs WebGPU**：用 `src/json-search/loop-emit.ts` 的 WGSL 写法或自写一个"每个运算一条 f32 语句"的生成器，先过仓库自带的 WGSL 解释器，再在 headless Chrome（`--enable-unsafe-webgpu`，调研用的机器装有 Chrome，但没有独立 GPU，需要软件 WebGPU）和至少一块真 GPU（NVIDIA 或 Apple）上比。重点看 `boolean` 原子的 `(x + 8388609) - 8388609` 会不会被 shader 编译器优化掉、次正规数会不会被冲成 0。
5. **梯度**：随机光滑程序（含 select 分段），反传梯度 vs float64 JS 的中心差分；分支翻转点附近的样本单独统计。再测 boolean 原子（默认会 throw，`straight-through` 要单独说明）、index read（默认 throw）。
6. **规模**：同一套 claims 在 HandwiredOS 级别的电路（几千到两万个运算）上抽样跑一次，看是否仍然成立、跑多久。

## 5. 步骤

1. 固定被测 commit，vendor 进实验目录（只读）。
2. 写生成器和四路对比（spike 已有雏形 `spikes/diff-fuzz.ts`、`spikes/grad-check.ts`）。
3. 写成 `claims.json` + 一个 `verify-claims` 脚本：每条 claim 有 id、命令、期望、容差、实测值，CI 里重跑。
4. 加边界值专项、循环上限专项。
5. GPU 一致性（最不确定的一步，单独排期）。
6. 写博客。

## 6. Claims 清单（草案，含 spike 实测）

| id | 说法 | 期望 | spike 实测 | 状态 |
| --- | --- | --- | --- | --- |
| C1 | reference 与编译后 tensor 求值逐位一致 | 0 差异 | 600 个程序构建 × 40 组输入，226,960 个值，0 差异 | 通过 |
| C2 | 用 `roundAffine`/`multiply`/精确宏写的电路，等于逐步 fround 的 JS | 0 差异 | 113,480 个值，0 差异 | 通过 |
| C3 | 用普通 `affine` 写的电路，等于逐步 fround 的 JS | 文档未承诺 | 113,480 个值中 2,246 个不同（1.98%）；最小例子 `affine(affine(x))` 在 10,000 个点里 4,336 个不同 | **不成立（文档已说明）** |
| C4 | 电路等于 float64 JS | 文档未承诺 | 约 48.8% 的值不同；相对误差中位数 2.59e-8，p99 1.86e-7；2 个值相对误差 >1e-3 | **不成立（FP32 本性）** |
| C5 | NaN、Infinity、越界输入被拒绝 | 抛错 | 三种都抛 "source wire 0 is outside its assumed range" | 通过 |
| C6 | `emitMaximum(2^24, -1) = 16777215`（文档写的已知缺陷） | 16777215 | 16777215；`emitMaximumExact` 给 16777216 | 文档可复现 |
| C7 | 2^24+1 | FP32 合约 | 电路 16777216、fround 16777216、float64 16777217 | 符合 FP32 |
| C8 | 反传梯度 = 中心差分 | 相对误差 <1e-3 | 200 个随机程序 × 5 点 × 3 维 = 3,000 组，全部通过，最差 2.06e-7；0 组落在分支翻转点 | 通过 |
| C9 | 阈值经 `emitCompare` 的梯度 | 0（文档、issue #1） | 3 个点都是 0 | 符合文档 |
| C10 | CPU 与 WebGPU 一致 | 0 差异 | **没测** | 待做 |
| C11 | 循环超过展开上限时的行为 | 静默错误 [推断] | **没测** | 待做 |
| C12 | 次正规差值比较在 GPU 上 | 可能错（文档） | **没测** | 待做 |

## 7. Spike 结果（本机实测，Bun 1.4.2，Linux，无 GPU）

`bun spikes/diff-fuzz.ts`（种子 20261017，300 个随机程序，每个 40 组输入，长度 4–15 个运算）：

```
  affine: programs built: 300
  affine: reference != JS-float64: 55208
  affine: reference != JS-fround: 2246
  affine: values compared: 113480
  roundAffine: programs built: 300
  roundAffine: reference != JS-float64: 55336
  roundAffine: values compared: 113480
  roundAffine vs float64 relative error over 55336 differing values: median 2.59e-8, p99 1.86e-7; >1e-3 (gross, e.g. branch flip or underflow): 2
  first roundAffine mismatch vs JS-fround: null
boundary probes:
  2^24 + 1: circuit 16777216, JS float64 16777217, JS fround 16777216
  0.1 + 0.2: circuit 0.30000001192092896, JS float64 0.30000000000000004, JS fround 0.30000001192092896
  input NaN: refused -> source wire 0 is outside its assumed range
  input Infinity: refused -> source wire 0 is outside its assumed range
  input 101: refused -> source wire 0 is outside its assumed range
  max(2^24, -1): emitMaximum 16777215, emitMaximumExact 16777216, Math.max 16777216
```

（输出里没有 "reference != tensor" 和 "builder refused" 这两行，意思是计数为 0。）

`bun spikes/affine-example.ts`：

```
affine(affine(x)): 4336/10000 differ from step-by-step FP32 JS; e.g. x=-100: circuit -92.70999908447266 vs JS-fround -92.70999145507812; ops built 2, live 1
```

两步线性被 builder 合成一步（2 个运算变 1 个活跃运算），系数先相乘再舍入，所以和逐步舍入的 JS 差 1 ulp 左右。

`bun spikes/grad-check.ts`：

```
gradient check: 3000 (program, input, coordinate) triples; 0 skipped as branch flip within h; 3000/3000 agree within 1e-3 relative; worst 2.06e-7
```

仓库自带测试：`bun test tests/runtime` 174 通过；`bun run test` 1,347 个测试，1,345 通过、2 跳过、0 失败（371 s）。

spike 的局限：随机生成器只覆盖 6 种运算，没覆盖 `indexRead`、`emitArgmax`、`boolean` 原子、弹簧宏；输入区间固定 ±100；没做 shrinking；>1e-3 的 2 个值没逐个查原因（推断是分支翻转或下溢）。

## 8. 可发博客的结论结构

1. **一句话结论**（等正式实验跑完再定）。按 spike 的初步结果，大致是："handwired 说的 exact 是 FP32 意义上的 exact。只要你用保留舍入的写法，它和逐步 fround 的 JS 逐位一致，CPU 两种求值也逐位一致，梯度也对。但它不等于你原来的 float64 JS，普通 affine 会被 builder 合并，再差 1 ulp。"
2. **它到底说了什么**：README 原话 vs 文档定义，"不会自动转换"这件事。
3. **怎么测的**：四路对比图、生成器、边界值清单、种子和命令。
4. **结果表**：就是 §6 的 claims 表。
5. **三个反直觉的发现**：exact ≠ float64；builder 合并 affine 会改舍入；阈值没有梯度。
6. **GPU 那一节**（做完再写）。
7. **对使用者的建议**：哪些写法能拿到逐位一致，哪些要容差；一定要写自己的 JS 参照对拍。
8. **复现**：commit、命令、claims.json。
9. **局限**。

## 9. 工作量估计 [推断]

| 阶段 | 内容 | 人日 |
| --- | --- | --- |
| 0 | spike（已完成） | 0 |
| 1 | 生成器扩到 indexRead / argmax / boolean / 弹簧宏，fast-check shrinking | 1.5 |
| 2 | 边界值专项 + 循环上限专项 | 1 |
| 3 | claims.json + verify-claims 脚本 | 0.5 |
| 4 | 大电路抽样 | 0.5 |
| 5 | WebGPU：WGSL 生成器、解释器、headless Chrome、真机 | 2–3（不确定性最大） |
| 6 | 博客 | 1 |
| 合计 | | 6.5–7.5 |

## 10. 成功标准

- 每条 claim 都有一条可重跑的命令，结果写进 `claims.json`，两次运行结果一致（固定种子）。
- C1/C2 在 ≥10^6 个值上 0 差异；任何差异都给出最小复现（shrink 后的程序 + 输入）。
- C3/C4 给出差异率和误差分布，并对照文档条款解释清楚。
- C10 至少在一个软件 WebGPU 和一块真 GPU 上跑完，0 差异或给出差异的根因。
- 博客里的每个数字都能从 claims 复现。

## 11. 风险

- **"打稻草人"**：作者文档已经写清楚 exact = FP32，如果博客标题写"handwired 不精确"就不公道。结论要写成"说法的准确含义 + 验证结果"。
- **GPU 环境**：本机没有 GPU；只有 JSON search 有 WGSL 生成器，而且是针对 loop program 的，套到随机程序上要改；软件 WebGPU 的行为不代表真 GPU。
- **生成器偏差**：随机程序太浅、区间太窄，会漏掉大数值和深链条的问题；要配合手写边界用例。
- **区间声明**：越界输入会被拒绝，但计算中间值的 `assumeRange` 是承诺，写错时行为不受合约保护，要单独测"错误声明"的场景。
- **项目变化快**：单作者，一天几十个提交，结论只对固定 commit 成立，要在博客里写明 commit。
- **gross 差异没查**：spike 里 2 个大误差值还没定位原因，正式实验要查清。
