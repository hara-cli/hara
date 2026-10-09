# OpenCode / Pi coding executor：单轮真实模型试验与离线审计

初次记录日期：2026-10-08；2026-10-09 补充生产 adapter 的同模型续跑试验，见末节。本文只描述小型合成任务试验，不是通用模型或 executor 排行榜；旧试验及其错误不追溯改写为通过。

工程上的 `auto → OpenCode` 是接入与交付策略，不表示 OpenCode 普遍更快、更省 token 或能力更强。Pi 保留为实验性选择；本次有效样本中，Pi 在三个双方都通过的首段任务上，记录的耗时和 token 反而更少。单次样本不足以据此推广任何性能结论。

## 试验条件与公平性边界

- 两者使用同一个已授权 Coding Plan endpoint，模型精确 ID 为 `deepseek-v4-1-flash-260910`，不是相似名称的模型或自动 fallback。
- OpenCode 为捆绑 runtime `1.18.32`；Pi SDK 为 `1.1.0`。
- 代理逐请求统一 `thinking.type = disabled`、`max_tokens = 4096`、流式 usage。审计核对了全部 43 个已受理请求，模型 ID、这些参数及工具白名单均一致。
- 使用相同合成种子、相同初始任务要求与四个工具 schema：read、write、edit、verify。OpenCode 经 stdio MCP，Pi 经 SDK custom tools，实际调用同一个受限工具实现。原生工具、外部技能和插件不参与。
- 修改范围只限各任务允许的文件；独立验收检查只读文件完整性，并使用模型不可见的额外断言。分析题不得改文件。工具 verify 只能运行固定的公开测试，不能选择 shell 或任意命令。
- 每个任务独立本地状态；最多 12 个上游请求，整个任务及续跑共用 150 秒 route deadline。OpenCode 还设置了原生 step 上限；Pi benchmark 没有相同原生 step 控制，公共代理请求上限仍然生效。本次未触及 12 请求上限。

这不是严格随机对照：只有一轮、四个小型 JavaScript 合成任务；没有随机顺序、多次重复、置信区间或真实仓库代表性。OpenCode 与 Pi 保留各自的 prompt/history 格式和生命周期开销；有效 Pi 复跑在 OpenCode 之后，上游缓存与时段负载也未控制。记录的耗时是各 adapter 的 `durationMs`，不包含随后的独立验收，且 setup 计时边界不完全相同。不能把这些数值当作稳定延迟或费用排名。

## 先剔除无效 Pi 初始 trial

原始 `results.json` 中的四次 Pi 首试全部因 benchmark 自定义模型缺少 cost 元数据，在 SDK 计算 usage 时触发 `reading 'tiers'` 错误。每次上游实际已完成一个请求，但 harness 没有正常完成工具循环，自己的 usage 还显示为零。

这是试验适配器错误，四次 trial 必须从能力、成功率与速度比较中剔除，不能当作 Pi 的四次任务失败；它们实际消耗的 3,571 token 仍计入试验总量。补齐模型元数据后，Pi 的四个有效首段结果保存在另一个文件 `results-corrected.json`。这个文件名表示 Pi harness 复跑，不表示 transport usage 统计已经修正。

## Usage 重复帧：逐请求修正，不是直接把总数除二

原代理把每条 SSE `usage` 都相加；本次上游每个请求恰好返回两条完全相同的累计 usage，造成重复统计。离线审计按单 route 串行请求顺序关联 `request-N.json`，对每个请求验证：

1. 请求编号连续、请求文件数与 transport.requests 相同；原始 usage 恰有两帧。
2. 两帧完整对象深相等，且 `total_tokens = prompt_tokens + completion_tokens`；只计该请求的一份累计 usage。
3. 所有有效 trial 的 engine completion usage 逐请求与代理计数匹配。OpenCode input 加回 cache-read/write，output 加回 reasoning；Pi input 加回 cache-read/write，output 已包含 reasoning，不重复相加。

全部 43 个请求、86 条 usage 帧通过以上核对。原始文件未覆盖；审计产生独立摘要。

| 数据范围 | 修正后输入 | 修正后输出 | 合计 token |
| --- | ---: | ---: | ---: |
| OpenCode 有效首段与续跑 | 37,259 | 3,830 | 41,089 |
| Pi 有效复跑首段与受截断续跑 | 27,951 | 3,190 | 31,141 |
| 无效 Pi 初始 trial | 3,196 | 375 | 3,571 |
| 所有已受理请求 | 68,406 | 7,395 | 75,801 |

token 指包含缓存命中的 prompt token 与 completion token，不是人民币、美元价格或服务商账单。订阅配额/缓存计价不可由这里的 token 总量直接推算。

## 有效首段的观测结果

下表每格为「已受理请求数 / adapter 秒数 / 修正后输入+输出 token」。每个任务每种 executor 只有一个有效样本。

| 合成任务 | OpenCode 首段验收 | OpenCode 请求 / 秒 / token | Pi 首段验收 | Pi 请求 / 秒 / token |
| --- | --- | ---: | --- | ---: |
| 单文件边界修复 | 通过 | 4 / 7.764 / 7,749 | 通过 | 4 / 5.908 / 5,995 |
| 多文件购物车功能 | 通过 | 5 / 7.930 / 9,511 | 通过 | 4 / 5.976 / 6,845 |
| 只读重试逻辑分析 | 通过 | 4 / 7.555 / 6,773 | 未通过 | 3 / 6.008 / 4,380 |
| Ledger 首段实现 | 通过 | 4 / 5.874 / 6,088 | 通过 | 4 / 5.627 / 5,897 |

OpenCode 首段为 4/4，修正 harness 后 Pi 首段为 3/4。这只是本次精确任务断言的结果，不是一般成功率估计；尤其不能把回答错误的较短运行时间当作完成同一任务更快。

Pi 的分析题失败不是预算拒绝：没有 route 错误、没有 timeout，三次请求正常完成、文件完整性通过。最终结构化答案中其余字段正确，但要求的 `boundaryShouldBeInclusive` 返回了 false，而验收期望 true。这是该样本的语义/契约错误，不是格式解析错误或额度不足。

## 续跑与真实恢复：结论必须分开

OpenCode ledger 续跑通过独立验收：4 个请求、5.332 秒、10,968 token。首段和续跑的 session ID 相同，续跑上游历史确有首段 assistant 上下文。

Pi ledger 续跑的本地 session 文件与 ID 也相同，文件 header/cwd 匹配，续跑请求中保留了此前 assistant 上下文。因此有「打开同一持久会话并继续提供历史」的证据。但这一轮没有完整结束：前三个续跑请求已完成、修改和公开验证工具已执行，随后代理拒绝下一请求，最终没有产生包含记忆标记的完成回答。独立验收在检查完成回答时停止，不能把这个 false 解释成 transfer 实现测试不通过，更不能解释成 Pi 无法恢复上下文。

拒绝时，route 只受理了 7 个请求（首段 4 + 续跑 3），不足 12；未 timeout。全局计数却把先前错误累计的 89,320 带入 Pi 复跑，并再次逐 usage 帧累加。最后一个受理请求后计数为 `89,320 + 62,282 = 151,602`，超过该复跑的 150,000 ceiling，下一请求必然被 budget guard 拒绝并返回 503。对应实际、逐请求修正后的全试验累计只有 75,801。预算判断本身被重复统计污染，Pi 的完整续跑结果属于受截断样本，不能公平比较续跑能力或耗时。

两种 benchmark 均未测试操作系统重启、崩溃中断、断电、跨版本迁移或生产凭据重建。OpenCode 的新进程续跑成功与 Pi 的同进程 SDK 会话重建也不是完全相同的恢复条件。因此「真实故障后 durable recovery 谁更可靠」仍然 inconclusive。生产接线的 owned ID、worktree、授权撤销、取消传播和持久化单元/本机 mock 检查应单独验收，不能由本表替代。

## 证据与复核方式

原始数据留在任务私有 benchmark 目录，不提交请求正文、回复正文、会话原生 ID、凭据或用户配置。

- `results.json` SHA256：`71b36f38d93c2e5cfd276ace9dd0695ca9f7ff8e5dc6c993ac7a71c7c8769db6`
- `results-corrected.json` SHA256：`784d148af9225b30618111d07aa2c9298eee441e9b32a6c932845ff61b66780e`
- 同目录 `audit-benchmark.mjs`：纯离线、只读审计；不导入 engine、provider、验证器或 SDK，不运行模型/测试代码。
- 同目录 `audit-summary.json`：无 prompt、无凭据的逐请求计数、参数一致性、engine usage 匹配及预算重建摘要。

后续如需更强性能或恢复结论，应另获调用授权，先修复代理的逐请求 usage 结算，再使用独立同额预算、随机交错顺序、多轮重复与明确的故障恢复协议；不能用补写文档或离线重算替代这些缺失的实验证据。

## 2026-10-09：生产接线的完整续跑补测

用户授权继续比较后，先修复计量，再走最新 Hara `executePiCodingAgent` / `OpenCodeCodingWorkerAdapter` 与共同 `CodingHostBridge`，不再直接用上一次独立 executor harness。两者明确使用 Hara 的生产 **Chat Completions Provider**；本轮没有测试 Coding Plan 默认的 Responses 路由，不能推广到该协议。

本次只付费补测上次缺失的 ledger 首段及同会话续跑，两个引擎各一份相同任务，不额外重跑已有的单文件、多文件和分析样本。每引擎首段＋续跑共享 40,000 实际 I/O、12 请求、150 秒，总限额 80,000；模型仍精确为 `deepseek-v4-1-flash-260910`，`thinking.disabled`、输出上限 4096，无模型／账号／endpoint fallback、无 SDK 重试。请求发送前保守预留 UTF-8 body 字节＋4096，缺失或异常 usage 停止整个试验；预算或截止截断与能力失败分开记录。首段必须完成且独立验收通过才继续。

两个引擎均使用相同四个合成 benchmark 工具及固定公开测试；这不是生产 `createCodingToolset` 的任意 shell/build/test 开放，也不是本轮工具说明精简的性能 A/B。模型只可修改 `ledger.mjs`，不能改测试或访问隐藏验收。相同记忆标记必须从会话历史恢复、出现在续跑回答中，且不能写入文件。

| 引擎／阶段 | 独立验收 | 请求 | 输入 | 输出 | 总耗时秒 | 模型请求秒 | 启动／恢复秒 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Pi 首段 | 通过 | 4 | 5,351 | 600 | 5.504 | 5.213 | 0.135 |
| Pi 同会话续跑 | 通过 | 4 | 10,593 | 626 | 5.757 | 5.597 | 0.023 |
| OpenCode 首段 | 通过 | 4 | 5,597 | 592 | 7.702 | 5.302 | 2.028 |
| OpenCode 同会话续跑 | 通过 | 4 | 10,783 | 596 | 7.482 | 5.665 | 1.583 |

总耗时从阶段开始计到关闭及独立验收结束；模型耗时为上游请求累计；启动／恢复计到第一条已受理模型请求，含 factory/host/native session 建立，并非纯引擎 CPU 耗时。Pi 两段共 11.261 秒、17,170 token；OpenCode 共 15.184 秒、17,568 token。模型请求时间合计接近（10.810 / 10.968 秒），本样本端到端差异主要在启动／恢复，不应据此宣称模型推理更快。两者均有缓存命中，累计 cached input 分别 12,544 / 12,672，已包含于输入，不能再相加或推算账单。

四阶段全部完成、代码断言和文件完整性通过；两个续跑均保持原不透明会话 ID。Pi 是同进程内完整销毁后重新创建 SDK 会话，OpenCode 是关闭后启动新原生进程；这是生产 generation/session 续跑证据，**不是相同条件的崩溃、重启或断电恢复试验**。

独立计量复核：16 个已受理请求、32 条累计 usage 帧，16 条重复帧各自只结算一次；各阶段 Provider／host／SDK 计数完全一致。实际总量 **34,738**，无待结算请求、无计量异常、未触及预算。每请求保留 body SHA256、模型／thinking／输出上限／工具名的安全投影和原始数字 usage；不记录凭据、headers 或请求正文。

本轮顺序为 Pi 首段＋续跑，然后 OpenCode 首段＋续跑，没有多轮随机化；同模型小样本、缓存和负载未控制，不能据此改变通用成功率或性能排名。当前继续保留 `auto → OpenCode` 的工程交付默认，Pi 为实验性可选引擎。上次 Pi 分析题的语义失败仍保留，上次被重复计量截断的续跑不会被追溯改写，只由本轮新增证据补齐。

复核证据（私有目录 `/private/tmp/hara-controlled-benchmark.0r4hAu`）：

- `runs/live-ledger-01/results.json` SHA256：`324d7fc13c94806221d9dbe6681c19ca27c246616ffe8051ff300374fdf7b4e3`
- `benchmark-ledger-05` SHA256：`1145b3b0c853c55957c93cbe9448bad58eb7861971e78beb945b99437803601f`
- `run-benchmark.mjs` SHA256：`b12b59d148a913ace94d24a6febed65eb2b20037996f2340ce4146d274d01646`
- `transport.mjs` SHA256：`a31db3053b497c297e22314432818a9adb55e44b2b886c660b59ec90748312bb`
- 原两份结果的 SHA256 前后不变。付费前的实际双 SDK 离线四阶段通过；`scripts/benchmark-usage.mjs` 的 9 项仓内回归和私有 transport 的非法尾事件／缺失 DONE 等 5 项回归通过。usage helper 是 benchmark 工具，不代表生产 Provider 曾以相同方式重复累加。
