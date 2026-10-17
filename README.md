# handwired-study

对 [chenglou/handwired](https://github.com/chenglou/handwired)（MIT）的调研：两份实验方案和几个最小可运行的验证（spike）。

> **先说清楚**：handwired **不会自动把现成的 JavaScript 源码转成神经网络**。官方文档原话："No tool converts existing JavaScript source into a program."（[docs/README.md](https://github.com/chenglou/handwired/blob/257856e3b221140acb4cc4460626b850c0bd4ff1/docs/README.md)）你要用它的 builder API（`Circuit.affine / roundAffine / multiply / select`、`emitCompare`、`emitClampExact` 等）把逻辑手写一遍。它说的 "exact" 指的是等于逐步 FP32（`Math.fround`）计算，而不是等于 JS 的 float64。

- 被调研的版本：`chenglou/handwired` main @ [`257856e`](https://github.com/chenglou/handwired/commit/257856e3b221140acb4cc4460626b850c0bd4ff1)（2026-10-16 17:33 PT）
- 运行环境：Bun 1.4.2，Linux x64（handwired 文档写的测试版本是 Bun 1.4.3）
- 在这个 commit 上，handwired 自带的 `bun run test` 结果：1,347 个测试，1,345 通过，2 跳过，0 失败

## 内容

| 路径 | 内容 |
| --- | --- |
| [plans/plan-A-semiconductor.md](plans/plan-A-semiconductor.md) | 方案 A：用 handwired 给半导体设备的 R2R EWMA 补偿逻辑调常数（保留规则结构，只用数据梯度调 λ 和增益） |
| [plans/plan-B-exactness.md](plans/plan-B-exactness.md) | 方案 B：验证"和原 JS 完全一致"这个说法，包括差分测试、模糊测试、边界值、梯度和数值差分的对比，以及 claims 清单 |
| `spikes/*.ts` | spike 源码 |
| `spikes/*.out` | 调研时记录的原始输出 |

| spike | 做什么 |
| --- | --- |
| `r2r-ewma.ts` | 方案 A：闭环 R2R EWMA 电路。检查精确性和梯度，用 Adam 调 λ 和 g，并和手调常数、网格搜索对比 |
| `r2r-check.ts` | 方案 A：g 的敏感性检查和细网格（纯 JS） |
| `fdc-threshold.ts` | 方案 A：FDC 风格的阈值经过 `emitCompare` 后梯度为 0 |
| `diff-fuzz.ts` | 方案 B：带种子的随机差分测试和边界值探针 |
| `grad-check.ts` | 方案 B：反传梯度和中心差分对比 |
| `affine-example.ts` | 方案 B：builder 合并 affine 后，结果和逐步 FP32 的 JS 有差异的最小例子 |

**数据说明**：所有 spike 用的都是**合成数据**，由固定种子生成，不是真实设备数据。方案 A 里提到的 PHM 2016、SECOM、LAM etch 等公开数据集只出现在计划里，本仓库没有收录。

## 复现

需要 git 和 [Bun](https://bun.sh)。

```sh
git clone https://github.com/alloevil/handwired-study.git
cd handwired-study
bash scripts/setup.sh        # 把 chenglou/handwired 克隆到 vendor/handwired，固定在 257856e，并执行 bun install
bun spikes/r2r-ewma.ts       # 方案 A，约 1 秒
bun spikes/diff-fuzz.ts      # 方案 B，约 1 秒
bun spikes/grad-check.ts
bun spikes/fdc-threshold.ts
bun spikes/affine-example.ts
bun spikes/r2r-check.ts
```

所有随机数都有固定种子，输出应该和 `spikes/*.out` 一致。只有 `r2r-ewma.ts` 最后一行的耗时（秒）会随机器变化。`vendor/` 已经写进 .gitignore，本仓库不包含 handwired 的源码。

## 主要发现（详见两份方案）

- R2R EWMA（合成数据）：电路的参考求值和编译后求值逐位一致；反传梯度和数值差分对到 4–6 位有效数字；梯度训练把测试集 MSE 从 293.4（手调常数）降到 185.8，结果和 12,120 次评估的细网格一致。
- 阈值经过 `emitCompare` 后梯度为 0，和 [issue #1](https://github.com/chenglou/handwired/issues/1) 一致，所以阈值和断点类常数需要另外处理。
- 用保留舍入的写法时，电路和逐步 FP32 的 JS 逐位一致；用普通 `affine` 时，约 2% 的值不同（builder 会合并运算）。和 float64 的 JS 相比，约 49% 的值不同，相对误差的中位数是 2.6e-8。
- CPU 和 WebGPU 的一致性还没测。

## English summary

A study of [chenglou/handwired](https://github.com/chenglou/handwired) pinned at commit `257856e`. Note: handwired does not convert existing JS automatically; programs are written with its builder API, and "exact" means equal to step-by-step FP32 arithmetic. Plan A tunes the constants of a run-to-run EWMA controller (semiconductor process control) using the circuit's exact gradients. Plan B is a verification plan for the exactness claim (differential fuzzing, edge values, gradient checks, CPU vs WebGPU). All spikes use seeded synthetic data. To reproduce, run `bash scripts/setup.sh` and then `bun spikes/<name>.ts`.

## 许可

MIT © alloevil。handwired 本身是 MIT 许可，版权归原作者所有，本仓库不包含它的代码。
