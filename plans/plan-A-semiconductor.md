# 方案 A：用 handwired 给半导体设备的 R2R（run-to-run）EWMA 补偿逻辑调常数

> 写于 2026-10-17（PT）。handwired 版本：`chenglou/handwired` main @ `257856e`（提交时间 2026-10-16 17:33 PT）。
> 标注约定：**[事实]** 有链接或本机实测；**[推断]** 是我的判断，未验证；**[合成]** 是我自己生成的数据。

## 0. 先纠正一个认知（重要）

- **[事实]** handwired **不会自动把现成的 JS 源码转成网络**。官方文档原话："No tool converts existing JavaScript source into a program." 你要用它提供的 builder API（`Circuit.affine / multiply / select`、`emitCompare`、`emitClampExact` 等）把逻辑**重写一遍**，builder 代码执行一次，把运算追加进一个 `Circuit`。见 [docs/README.md](https://github.com/chenglou/handwired/blob/main/docs/README.md)。
- **[事实]** "精确"指的是**和逐步 FP32（`Math.fround`）计算一致**，不是和普通 JS 的 float64 一致。见 [execution-model.md · Macro contracts](https://github.com/chenglou/handwired/blob/main/docs/execution-model.md#macro-contracts)。
- **[事实]** `lab/trace-compiler` 有一个实验，能把"定义好的数值 TypeScript 子集"按 AST 编译成电路，但它明确说"does not compile arbitrary JavaScript"（[lab/trace-compiler/README.md](https://github.com/chenglou/handwired/blob/main/lab/trace-compiler/README.md)）。

## 1. 目标

挑一段典型的、工程师手写的设备控制逻辑，**保留规则结构不变**，只把里面的常数（EWMA 权重 λ、控制增益 g 等）变成可训练参数，用 handwired 自带的反向传播（`circuit.backpropagateReference`）拿数据梯度去调。证明三件事：

1. 调完的东西还是那条规则，工程师看得懂、能审核（可解释性卖点）；
2. 梯度是对的（和数值差分对得上），调出来的效果不差于网格搜索；
3. 常数多起来以后（几十个），梯度法比网格搜索省很多评估次数。

## 2. 选哪段逻辑，为什么选 R2R EWMA

| 候选 | handwired 里的写法 | 常数能拿到梯度吗 | 结论 |
| --- | --- | --- | --- |
| **R2R EWMA 补偿**（CMP 抛光时间、刻蚀时间、光刻剂量） | 全是 affine + multiply，加一个执行器限幅 clamp | **能**。λ、增益都在乘法里，反传给精确梯度 | **首选** |
| FDC 报警阈值（x > thr 就报警） | `emitCompare` | **不能**。阈值经过比较得到的梯度是 0 | 第二阶段再做 |
| 端点检测（OES 信号过阈值 + 持续 N 点） | `emitCompare` + 计数 | 同上，阈值梯度为 0；N 是循环/计数，也不可微 | 第二阶段 |
| 温控分段逻辑（分段线性/分段增益） | 比较 + select | 分段内的斜率能调；**断点**（分段边界）梯度为 0 | 部分可行 |

依据：

- **[事实]** issue #1 的作者 Rohansguliani 写明：`backpropagateReference` 让 `constant` 单元里的阈值经过 `emitCompare` 决策后梯度为 0，"a learned breakpoint never moves"。他在 fork 上做了 "flip gradients"（高斯平滑损失 + 单比特翻转），在 21 和 44 个运算的小程序上把断点学到了位，但限制很多：σ 要从宽到窄退火；只支持 `< <= > >=`；没测过大程序。见 [issue #1](https://github.com/chenglou/handwired/issues/1) 和 [fork 代码](https://github.com/Rohansguliani/handwired/tree/flip-gradients/lab/flip-gradients)。
- **[事实，本机实测]** 我写了一个 FDC 风格的报警 `alarm = emitCompare(x, '>', thr)`，在 x=60/40/50.0001、thr=50 三个点上，`d alarm / d thr` 全是 0（见 §8 spike 2）。
- **[事实]** 官方文档写明比较级联"gives its operands gradient 0, the derivative of a step"（[Comparisons](https://github.com/chenglou/handwired/blob/main/docs/execution-model.md#comparisons)）。
- **[推断]** R2R EWMA 是半导体 APC 里最常见、最"写死常数"的逻辑之一（λ 常年由工程师手调），而且它本来就是线性递推，最贴 handwired 的强项。

## 3. 问题定义

单输入单输出的 R2R 控制（以 CMP 抛光时间为例）：

```
工艺（plant）:  y_t = z_t + b · u_t            # y 去除量 nm，u 抛光时间 s，z_t 漂移+噪声
控制器（规则）: u_t = clamp((T - â_{t-1}) · g, U_MIN, U_MAX)
EWMA 更新:      â_t = λ · (y_t - b_nom · u_t) + (1 - λ) · â_{t-1}
可训练常数:     λ ∈ [0,1]，g ∈ [0, 0.5]（第二阶段再加：b_nom、初值 â_0、限幅、双 EWMA 的第二个权重）
损失:           每个 lot 上 mean((y_t - T)²)，对多个 lot 取平均
```

关键设计：**把工艺模型也放进电路**（闭环），这样梯度能看到"λ 改了 → u 改了 → y 改了"整条链。λ、g 放在 source 表的单元里，`backpropagateReference` 返回的 source 梯度就是 `dL/dλ`、`dL/dg`。这是官方 learned-gallery 用的同一套做法：参数放在 source cells，Adam 用反传梯度更新（[src/learned-gallery/README.md](https://github.com/chenglou/handwired/blob/main/src/learned-gallery/README.md)）。

乘法模型（真实 CMP 更像 `去除量 = 去除速率 × 时间`）**[推断]**：电路里没有除法。可以让主机端先算好 `1/MRR` 当数据输入，EWMA 估计速率的倒数，`u = T · ĝ`，这样电路里只剩乘法。

## 4. 数据

1. **[合成]** spike 用的数据：每个 lot 40 片，`z_t = 20 + drift·t + 随机游走(σ=2) + 白噪声(σ=5)`，drift ∈ [-2.5, -1.5] nm/片（模拟抛光垫磨损），b=10、b_nom=9（模型失配 10%），训练 16 个 lot（种子 100–115），测试 16 个 lot（种子 900–915）。代码 `spikes/r2r-ewma.ts`。
2. **[事实] PHM Society 2016 Data Challenge（CMP 去除速率）**：CMP 机台的时序数据，25 列（含 `TIMESTAMP`、`WAFER_ID`、`STAGE`、`CHAMBER`、抛光垫/修整器使用量、压力、浆料流量、转速），训练集 1,981 条去除速率记录。官方页面：[PHM Data Challenge 2016](https://phmsociety.org/conference/annual-conference-of-the-phm-society/annual-conference-of-the-prognostics-and-health-management-society-2016/phm-data-challenge-4/)，[CFP PDF](https://phmsociety.org/wp-content/uploads/2016/05/PHM16DataChallengeCFP.pdf)。
   - 官方 PDF 里的 Dropbox 链接我用 curl 测，返回的是 HTML 页而不是 zip，**原始下载可能已失效**。
   - 有第三方 GitHub 镜像 [akangel0307/PHM-Data-Challenge](https://github.com/akangel0307/PHM-Data-Challenge)（含训练、测试、验证集和答案）。我下载了 `CMP-training-removalrate.csv`，实测 1,981 行，速率最小 53.4、中位数 79.2、最大 4,326（有离群值，要清洗）。**数据许可以 PHM Society 为准，镜像仓库的 MIT 许可不一定覆盖数据**。
   - 用法 **[推断]**：这是开环数据（没有 R2R 控制）。把每个 chamber/stage 按 TIMESTAMP 排序的 MRR 序列当作"真实漂移"，在上面模拟闭环控制（半真实仿真，要在报告里明确说明）。速率文件里没有时间戳，要按 `WAFER_ID` 关联训练 CSV 拿时间，这一步还没做。
3. **[事实] SECOM**（UCI，1,567 个样本，591 个特征，有缺失，pass/fail 标签）：[archive.ics.uci.edu/dataset/179/secom](https://archive.ics.uci.edu/dataset/179/secom)。只适合第二阶段的 FDC 阈值/特征选择，不适合 R2R（没有控制量和时序）。
4. **[事实] LAM 9600 金属刻蚀数据**（Eigenvector，129 片晶圆，含 21 片故障，MATLAB 格式，带 OES 数据）：[eigenvector.com/data/Etch](https://eigenvector.com/data/Etch/)。适合第二阶段的端点检测/FDC 阈值。

## 5. 实现步骤

1. **电路**（已在 spike 完成）：source 表 `[λ, g, z_0..z_{N-1}]`；每片晶圆用 `roundAffine` 算误差，`multiply` 乘增益，`emitClampExact` 限幅，`roundAffine` 算工艺输出和 EWMA 更新；给 `â_t` 声明区间 `assumeRange(-2000, 2000)`（这是对 builder 的承诺，测试里要用 `validateNoNaN` 等校验）。
2. **float64 参照**：同一条规则用普通 JS 写一遍，作为"原逻辑"。
3. **精确性自检**：电路 reference 求值和编译后的 tensor 求值逐位对比；电路和 float64 参照的最大差。
4. **梯度自检**：反传梯度和 float64 参照的中心差分对比。
5. **训练**：Adam，多 lot 平均梯度，参数投影回合法区间；训练/测试 lot 分开。
6. **基线**：
   - 手调常数（λ=0.3、g=1/b_nom）；
   - 网格搜索（粗网格 + 细网格，记评估次数）；
   - 普通 MLP：输入最近 k 片的 (y, u)，输出 u，同样的闭环损失训练（PyTorch 或 handwired 自己的 ReGLU 层都行）；
   - 选做：Nelder–Mead / CMA-ES（无梯度优化）。
7. **扩到多常数**：双 EWMA（level + drift 两个 λ）、b_nom、â_0、限幅、按 chamber 分组的常数，常数数量从 2 增加到 20–50，画"达到同样 MSE 需要的评估次数"曲线：梯度法对比网格/CMA-ES。
8. **换 PHM 2016 半真实数据**重复 3–7。
9. **第二阶段（选做）**：端点检测或 FDC 阈值，用 issue #1 的 flip-gradient 方法，或者用软比较（训练时用 sigmoid 代替比较，部署时换回精确比较）；要明说"软比较不是精确导数"（官方原话："A soft comparison or a custom derivative is a training choice, not an exact derivative of a hard decision"）。

## 6. 评价指标

- 控制性能：测试 lot 上的 MSE / RMSE（相对目标 T）、Cpk（给定规格界限）、超规格片数、执行器触发限幅的次数。
- 优化成本：达到某个 MSE 需要的前向+反向次数、墙钟时间。
- 正确性：reference 与 tensor 逐位一致率；梯度与中心差分的相对误差。
- 可解释性：调参前后的 λ、g 数值和物理含义（"λ 从 0.3 调到 0.79，意思是更相信最新一片的量测"），规则结构 diff 为零。
- 泛化：训练/测试 lot 的 MSE 差距；换 drift 范围（分布外）后的表现。

## 7. 可解释性卖点 [推断]

- 调出来的是**同一条 EWMA 规则 + 两个数字**，可以直接填回 APC 系统的配方参数，不需要部署神经网络推理。
- 工艺工程师审核的对象没变（λ 和增益本来就是他们手调的），只是多了"数据给出的最优值 + 梯度方向"。
- 对比 MLP：MLP 可能 MSE 更低，但它是黑盒，没法填回现有控制器，也很难过变更审核。这是这篇 demo 想讲的取舍。
- 诚实的一面：只有 2 个常数时，网格搜索就足够（见 spike），梯度法的价值要在常数多的时候才体现。

## 8. Spike 结果（本机实测，Bun 1.4.2，Linux）

代码在本仓库 `spikes/`，原始输出在同目录 `*.out`。复现方法见根目录 README。

**Spike 1：R2R EWMA 调 λ 和 g（[合成] 数据）** —— `bun spikes/r2r-ewma.ts`

```
circuit: 1724 built ops, live 1718 , 40 runs/lot
exactness: reference vs tensor mismatches = 0 / 3840; max |circuit(FP32) - JS float64| = 1.506e-4 nm
grad check at lambda=0.3, g=0.1: backprop dL/dlambda=-549.353 vs central -549.353; dL/dg=-406283.2 vs central -406283.3
grad check at lambda=0.15, g=0.09: backprop dL/dlambda=-493.272 vs central -493.266; dL/dg=-799036.0 vs central -799036.1
grad check at lambda=0.6, g=0.105: backprop dL/dlambda=-107.669 vs central -107.669; dL/dg=-218461.2 vs central -218461.0
hand-tuned lambda=0.3 g=1/B_NOM=0.1111: train MSE 288.90, test MSE 293.39
grid search (2050 evals, 50x41): lambda=0.78 g=0.1120 train MSE 206.61, test MSE 202.64
  adam step 1: train MSE(circuit) 288.90 lambda=0.3100 g=0.1091
  adam step 50: train MSE(circuit) 194.40 lambda=0.6510 g=0.1110
  ...
  adam step 300: train MSE(circuit) 189.40 lambda=0.7881 g=0.1110
gradient-trained: lambda=0.7881 g=0.1110 train MSE 189.40, test MSE 185.81  (300 steps x 16 lots = 4800 forward+backward, 0.8 s)
```

补充检查 `bun spikes/r2r-check.ts`：

```
lambda=0.788 g=0.11: MSE 207.87 / g=0.111: MSE 189.40 / g=0.112: MSE 206.61   (g 非常敏感)
clamp hits at hand-tuned (0.3,1/9): 全部 lot 都是 0
fine grid (12120 evals): lambda=0.790 g=0.1110 MSE 189.40
```

读法：

- 闭环 40 步的电路有 1,718 个活跃运算；reference 和编译后求值 3,840 个输出逐位一致；和 float64 原逻辑最大差 1.5e-4 nm（FP32 舍入，符合"精确 = FP32"的定义）。
- 反传梯度和中心差分对到 4–6 位有效数字。
- 梯度法从手调值出发，训练 MSE 288.9 → 189.4（降 34%），测试 MSE 293.4 → 185.8。
- 粗网格（2,050 次评估）因为 g 太敏感，步长 0.002 跳过了最优点，只到 206.6。细网格（12,120 次）才找到和梯度法一样的点（189.40）。**这说明梯度法在这里找对了点，但不能说网格搜索不行**：只有 2 个常数时，细网格完全够用。
- 限幅在这组数据里从没触发，所以 clamp 部分的梯度路径**还没被真正测到**，正式实验要造会触发限幅的数据。

**Spike 2：FDC 阈值拿不到梯度** —— `bun spikes/fdc-threshold.ts`

```
x=60 thr=50: alarm=1 d alarm/d thr=0 d alarm/d x=0  (ops=16)
x=40 thr=50: alarm=0 d alarm/d thr=0 d alarm/d x=0  (ops=16)
x=50.0001 thr=50: alarm=1 d alarm/d thr=0 d alarm/d x=0  (ops=16)
```

和 issue #1 的说法一致，这是选 R2R 而不是 FDC/端点检测当第一个 demo 的直接原因。

**仓库自带测试**：`bun run test` 跑完 1,347 个测试，1,345 通过、2 跳过、0 失败，耗时 371 s（本机）。

## 9. 工作量估计 [推断]

| 阶段 | 内容 | 人日 |
| --- | --- | --- |
| 0 | spike（已完成） | 0 |
| 1 | 合成数据正式版：触发限幅的数据、MLP/CMA-ES 基线、多 seed 统计 | 1.5 |
| 2 | 多常数扩展（双 EWMA、分 chamber）+ 评估次数曲线 | 1.5 |
| 3 | PHM 2016 数据清洗、按时间排序、半真实仿真 | 1.5–2 |
| 4 | 写报告/博客、图表 | 1 |
| 5（选做） | 端点检测/FDC 阈值 + flip gradient 或软比较 | 2–3 |
| 合计 | 不含选做 | 5.5–6 |

## 10. 成功标准

- 反传梯度与中心差分相对误差 < 1e-3（所有测试点）。
- reference 与 tensor 逐位一致率 100%。
- 测试 lot 上，梯度法 MSE ≤ 最好的网格搜索 MSE，且在 ≥20 个常数时，达到同样 MSE 所需评估次数比网格/CMA-ES 少一个数量级以上（这是待验证的假设，做不到就如实报告）。
- 调完以后规则结构 diff 为零，只改常数。
- PHM 2016 半真实仿真上相对手调常数有可复现的改善（多 seed、给置信区间）。

## 11. 风险

- **工程量在"重写"**：没有自动转换器，每段设备逻辑都要用 builder API 重写，还要自己写 float64 参照和对拍测试。
- **阈值/断点学不动**：比较、计数、index read 的梯度是 0 或被拒绝，这类常数需要 flip gradient 或软化，都不是精确导数。
- **区间声明是承诺不是证明**：`assumeRange` 写错，builder 可能做出不合法的优化；必须在测试里跑 `validateNoNaN`、`validateGrids` 之类的校验。
- **长递推的梯度**：官方说"Exact settling says nothing about whether gradients through many steps stay usable"。片数很多（几百片）时梯度可能爆炸或消失，要实测。
- **FP32**：所有值是 FP32，大数（>2^24）和很小的差异会被舍入；去除量 nm 级没问题，累计量要小心。
- **项目成熟度**：单作者、2026-10-14 才公开、没有 npm 包、API 不稳定；作者自己定位是玩具项目。建议 vendor 固定 commit（如 `257856e`），不要当正式依赖。
- **数据**：PHM 2016 原链接可能失效，镜像来源是第三方；数据是开环的，闭环结论只是仿真结论。
- **说服力**：两参数问题网格就够了，如果多常数实验没体现出评估次数优势，卖点就只剩"可解释"。
