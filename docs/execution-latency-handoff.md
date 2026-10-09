# Hara 执行延迟：诊断、已完成的优化与交接（给 Codex）

> 日期：2026-10-05
> 作者：Claude Code（应 Jeff 要求做的 review 和优化）
> 状态：代码已改在 `hara-cli` 工作树里，全量测试通过，已用真实模型实测。**未提交、未改版本号、未写 CHANGELOG。**
> 范围：只有 `hara-cli`。Desktop / Mobile 没有改；Serve 协议只多了一个可选字段。

> Codex 发布候选补充（2026-10-05）：0.183.3 单独隔离执行延迟相关改动，不包含原工作树的
> Computer Use / Laya / Agent 创建改动。已补被拒回执的实时与保存历史保护、结构化回复共用的
> 凭据纠正预算，以及 CLI/Serve write-ahead 插话撤销 carry。18 项正式新增回归通过；
> 发版门槛和公开产物仍按实际验证结果记录，以下 Claude 原始测量与交接正文保留，不外推收益。

## 一句话结论

Hara 慢在**根 Agent 循环的模型往返**，不在"谁来写代码"。OpenCode 委派换的是执行者，没有碰这条路径，
而且在 Jeff 的机器上从未被调用过。这次把同一个小任务从 6 次往返压到 4 次，墙钟时间从平均 10.8 秒降到
6.7 秒。

## 实测结果

同一个任务（改一个函数的返回值，再跑测试确认），`hara -p --approval full-auto`，
火山 coding plan 的 `deepseek-v4-1-flash-260910`，直连，隔离的临时 HOME，各跑 3 次。
基线是 `git archive HEAD`（0.183.2，不含任何未提交改动）的干净构建。

| | 基线 0.183.2 | 当前工作树 |
| --- | ---: | ---: |
| 模型往返次数 | 6 / 6 / 6 | 4 / 4 / 4 |
| 墙钟时间 | 10.1 / 10.3 / 11.9 s | 6.7 / 7.0 / 6.5 s |
| 输入 token 合计 | 约 76.5k | 约 51.9k |
| 其中缓存命中 | 36–37% | 73–79% |
| 请求里 system 的不同版本数 | 6（每次都变） | 1 |

基线的轮次：读文件 → `task_intake` → `edit_file` → `bash` → `task_checkpoint` → 最终文字。
现在的轮次：读文件 → `task_intake` + `edit_file` → `bash` → `task_checkpoint`（带最终回复）。

两点要如实说明：

- 样本只有一个任务、一个模型、每边 3 次。它证明机制在真实模型上生效，不代表所有任务都省三分之一。
- 单轮首 token 时间在这个上下文规模（约 1.2 万 token）下**没有可测量的变化**，都是 1.0–1.2 秒。
  缓存修复目前能确认的收益是少计费、少占配额；对延迟的帮助要在 3 万 token 以上的真实会话里再量。

## 诊断依据

来自 `~/.hara/sessions/*.journal` 的 `runtime.item` 事件：2026-09-13 至 09-30，版本 0.178–0.182，
57 个用户回合，374 次 provider 往返。

| 项目 | 耗时 | 占比 |
| --- | ---: | ---: |
| 等模型 | 4085s | 87% |
| 工具真正执行 | 588s | 13% |

| 轮次类型 | 轮数 | 模型时间占比 |
| --- | ---: | ---: |
| 有实际工作 | 198 | 59% |
| 纯记账（只有 `task_intake` / `task_checkpoint` / `todo_write`） | 105 | 32% |
| 工具全部被拒或失败 | 30 | 4% |
| 最终文字回复 | 41 | 4% |

每个用户回合的往返次数：中位 7，p90 12，最大 20。

各模型单轮耗时：

| 模型 | 轮数 | 首 token 中位 / p90 | 单轮中位 / p90 / 最长 | 输入 token 中位 |
| --- | ---: | --- | --- | ---: |
| MiniMax-M3 | 211 | 1.4s / 2.7s | 3.3s / 7.9s / 30s | 29412 |
| qwen3.8-max | 130 | 2.9s / 5.3s | 13.3s / 57.7s / 289s | 36362 |
| auto（火山 agent plan） | 23 | 2.5s / 3.5s | 7.4s / 17.7s / 21s | 33517 |
| deepseek-v4-1-flash | 10 | 1.5s / 1.8s | 2.6s / 5.5s / 5s | 35528 |

被拒绝的工具调用，按持久化历史里的拒绝文案统计：

| 次数 | 工具 | 原因 |
| ---: | --- | --- |
| 136 | `bash` | Understanding gate：还没有 brief 就做副作用 |
| 67 | `bash` | Capability preflight gate：声明了能力但没先记录 |
| 47 | `bash` | brief 的 intent 是 answer / investigate，却要做副作用 |
| 16 | `task_checkpoint` | 完成回执没有独占一轮 |

**更正**：我第一版交接文档写的是"cron 没有审批通道，模型反复撞审批拒绝"。这是错的。数据显示拒绝几乎全部来自
理解门禁本身，和审批通道无关。每次这类拒绝在旧流程里要花两轮才能恢复（先补 `task_intake` 或 checkpoint，
再重发动作）。

## 原因

1. **记账协议强制多轮。** `task_intake` 独占一轮，同批的副作用被拒；能力预检要先单独 checkpoint；
   完成回执独占一轮，之后再来一轮才能出最终回复。
2. **每轮重新处理整段历史。** 秒级时钟、brief、checkpoint 在 system 末尾，每次请求都变，前缀缓存只能
   覆盖 system 前半段。实测基线只有 37% 命中。
3. **模型长尾。** `qwen3.8-max` 的 p90 是 58 秒。轮数多，长尾就被放大。
4. **代理路由（有条件）。** 环境里设了 `HTTP_PROXY=127.0.0.1:18888` 时，Hara 的模型请求也走它。
   到火山的首字节：直连约 0.06 秒，走这个代理 1.5–1.9 秒，同一个任务墙钟从约 8 秒变成 16–22 秒。
   常驻的 gateway、Desktop serve、cron 进程没有这些变量，走的是直连，所以这不是主因；
   但从带代理的终端（例如 Codex 或 Claude Code 的 shell）里启动的 `hara` 会中招。

## OpenCode 为什么没解决

- `opencode` 不在 Jeff 机器的 PATH，`/Applications/Hara.app` 里也没有打包的 code runtime。
- `src/subagent/team.ts` 的 `AgentRuntime` 只有 `hara | codex | claude`，b625ef5 的 `codingRuntimes`
  只给 `["codex", "claude"]`，自动路由里没有它。
- `external_agent` 自动选择顺序是 claude → codex → opencode，这台机器前两个都装了。
- 所有 journal 里 `external_agent` 和 `tool_search` 的调用次数都是 0。
- 即使调用也更慢：deferred 工具要先 `tool_search`，外部信任边界要先 `task_intake` 并人工批准，
  每次冷启动一个进程，gated 模式下 `bash: deny`，验证仍回到根循环。

建议：先别再往 OpenCode 上投入。它解决的不是这个问题。

## 已完成的改动

### 1. 每轮变化的上下文移到请求尾部

- `composeSystem()` 不变。`runAgent` 发请求前把 `stability === "turn"` 的部分（brief、checkpoint、时钟）
  拆出来，system 只带稳定部分；变化部分用 `wrapTurnContext()` 包成一条 `<system-reminder>` 用户消息，
  追加到本次请求的历史末尾。这条消息不进入持久历史。
- 只对声明了 `trailingTurnContext: true` 的 provider 生效。三个内置 provider 已声明，`routingProvider`
  要求主备都声明，`organization-bound` 透传。自定义 provider 和测试替身保持原来的单条 system。
- `HARA_TURN_CONTEXT_PLACEMENT=system` 对所有 provider 恢复旧布局，可用于 A/B。实测开了它之后缓存命中
  回到 36%。
- Anthropic：`applyCacheControl()` 的滚动断点现在跳过尾部这条每轮都变的消息，落在它前面最后一个持久块上。

### 2. task state 和依赖它的动作可以同一条响应

模型在一条响应里同时给出 `task_intake`（或带 `capabilities` 的 `task_checkpoint`）和真正的工具调用时，
引擎把它拆成两个闭合轮：

1. 第一轮只含 state 调用。照常执行、写入历史、在闭合轮边界调用 `onUpdate` / `onCheckpoint` 落盘。
2. 第二轮是其余调用，**不再请求模型**，直接进入正常的规划、门禁、审批和执行，按已经落盘的新 brief 判定。

实现是 `splitTaskStateTransition()` 加循环里的 `carriedToolRound`。要点：

- 原有不变量都成立：副作用前 brief 已持久化；持久化只发生在闭合的工具轮之后；改小权限的 brief 修订
  不会让旧 brief 的权限延续到同批动作（有测试）。
- brief 被拒时，同批的其余调用整体丢弃，并在结果里说明。
- 两轮之间如果用户插话（`pendingInput` 有消息），丢弃其余调用，让模型先看到用户输入。
- 完成回执永远留在第二轮，不会被提前。
- 第二轮不产生 provider runtime item，不计 `providerCalls`，但计入 `life.rounds`。
- DeepSeek 风格的 `chat_reasoning` 续接状态会复制到第二轮的助手消息上；Responses 的 reasoning items
  带唯一 id，只留在第一轮。
- 三条门禁拒绝文案加了一句"可以和 task_intake / checkpoint 同一条响应重发"。旧流程里要两轮才能恢复的拒绝
  现在一轮就够。

### 3. 收尾一轮结束

- 完成回执可以和 `todo_write` 同轮，其他工具仍被拒。`todo_write` 不再使已有回执失效。
- `task_checkpoint.completion` 新增可选字段 `final_answer`。回执被接受时，引擎把它作为一条普通的助手消息
  写入历史并输出，回合结束，不再请求模型。它不进入 checkpoint 状态。gateway / cron 下照样过凭据索取检查。
- 如果模型把最终回复写成响应文字而不是 `final_answer`，同样在这一轮结束。
- 回执被拒时，随它一起来的回复不显示，循环继续。
- 旧流程（回执一轮、回复再一轮）仍然可用。

### 4. 提示词

去掉"`task_intake` 必须独占一轮"，改为鼓励和第一批动作同发；要求进度记账随工作调用一起发；
要求用 `completion.final_answer` 收尾。`task_intake` / `task_checkpoint` 的工具描述同步更新。

### 5. journal 记录缓存命中

provider 的 runtime item 多了可选的 `cachedInputTokens`。经过 `loop.ts` 的类型、`session/store.ts` 的
校验和三处拷贝、`serve/protocol.ts` 的注释规范。校验器不拒绝未知字段，旧版本读新 journal 不受影响。

### 改动的文件

- `src/agent/loop.ts`、`src/agent/reminders.ts`：主要逻辑。
- `src/providers/types.ts`、`openai.ts`、`responses.ts`、`anthropic.ts`、`organization-bound.ts`、
  `src/agent/route.ts`：能力标记，以及 Anthropic 断点。
- `src/session/store.ts`、`src/serve/protocol.ts`：`cachedInputTokens`。
- 测试：`test/task-intake.test.mjs`、`test/turn-context-cache.test.mjs`（新）、
  `test/anthropic-cache.test.mjs`、`test/session.test.mjs`。
- 文档：本文、`CLAUDE.md`、`AGENTS.md`、`.learnings/LEARNINGS.md`。

工作树里同时有 Codex 未提交的改动。`loop.ts` 和几个 provider 文件两边都改了，我的改动叠在上面，
没有动 Codex 的内容，也没有审那部分。

## 验证

- `npm run build` 通过；`npm run eval:feedback` 9/9。
- `node --import ./test/setup-isolated-home.mjs --test --test-concurrency=4 --test-timeout=120000 test/*.test.mjs`：
  1927 个测试全部通过，约 127 秒，Node v24.15.0。
- 新增 15 个用例，覆盖 system 逐字节稳定、未声明能力的 provider 不受影响、回退开关、真实 chat provider 的
  线上前缀只追加不改写、拆分的各条边界、`final_answer`、Anthropic 断点。另在既有的 journal 用例里加了
  `cachedInputTokens` 的断言。
- 改了 3 个既有用例的断言：它们原本断言"与 `task_intake` 同批的动作必须被拒"，这正是这次改掉的契约。
  其中"修订 brief 不能继承旧权限"那条的安全性质保留，只是拒绝原因从"等下一轮"变成"intent 不允许"。
- 没有跑 Windows、Docker、standalone binary 这些 CI 独有的 lane。

## 需要 review 的行为变化

1. 同一条响应里的 `task_intake` 和副作用不再被拒，而是拆成两轮执行。这是对"理解→执行"边界最大的一处改动。
2. 对内置 provider，brief、checkpoint、时钟和 intake 规则从 system 移到了请求尾部。门禁是确定性的，
   安全性不依赖位置；模型遵从度在 deepseek flash 上实测正常，其他模型没测。
3. `task_checkpoint.completion.final_answer` 是新的模型可见字段；回合可能以引擎写入的助手消息结束，
   或以工具结果结束（模型用响应文字收尾时）。Desktop / Mobile 的渲染没有验证。
4. `todo_write` 不再使完成回执失效。
5. change 任务里随回执一起来的文字不再在工具执行前显示。
6. `Provider` 多了可选字段 `trailingTurnContext`；runtime item 多了可选字段 `cachedInputTokens`。

## 我决定不做的两项

- **压缩基线 token**（静态提示词和 34 个常驻 schema 各约 7k token）。前缀缓存生效后，这部分是每次请求里
  最便宜的；而删提示词或把更多工具改成 deferred 会直接影响模型行为，没有数据支持盲改。
- **调低 `HARA_STALL_TIMEOUT`**。374 轮里首 token 最长 13 秒，没有观察到一次卡死；改默认值没有依据。

## 留给 Codex 的事

1. **review 上面 6 处行为变化**，尤其是第 1 处，然后决定提交和发版。发版需要 CHANGELOG 和版本号。
2. **在其他模型上重复实测。** MiniMax-M3 和 qwen3.8-max 是历史上用得最多的，它们是否会把 intake 和动作
   同发、是否会填 `final_answer`，决定这次优化在它们身上有多大收益。
3. **验证 Desktop / Mobile** 对"引擎写入的收尾助手消息"和"没有 provider 父项的助手 message item"的渲染。
4. **大上下文下的延迟。** 用新的 `cachedInputTokens` 在真实长会话里看首 token 时间是否随缓存命中下降。
5. **代理绕过。** 决定是否对国内模型端点默认绕过环境代理，或者至少在诊断输出里提示"模型流量正在走代理"。
   这是网络策略决定，我没有动。
6. **减少 intent 填错。** 47 次拒绝来自 brief 的 intent 填成 answer / investigate 之后又要改东西。
   现在一轮能恢复，但更好的是让模型第一次就填对。
7. **收紧 `evals/feedback` 的轮次预算**，把这次的收益固化成回归门槛。

## 附录：复现

历史统计：逐行解析 `~/.hara/sessions/*.journal`，只看 `type == "runtime.item"`。`kind == "provider"` 的
`started` / `streaming` / `completed` 按 `itemId` 配对得到首 token 和单轮耗时；一次 provider `started` 到
下一次之间的工具事件算一轮；工具名全在 `{task_intake, task_checkpoint, todo_write}` 内算纯记账。

线上实测：用 `node --import <hook>` 预加载一个包住 `globalThis.fetch` 的记录器，对每次模型请求记录
system 的哈希、输入项哈希、首字节时间，以及流里 `response.completed` 的 `usage`。注意两点：
火山 coding plan 走的是 Responses 协议（`instructions` + `input`），不是 chat completions；
环境里有代理变量时 Hara 改走 undici，不经过 `globalThis.fetch`，所以要先 unset。
基线用 `git archive HEAD | tar -x` 到临时目录后 `tsc` 构建。

## Codex 后续验收 — 2026-10-05

- 新的默认 feedback gate 保留原 9 条历史回执，再运行 8 个隔离的当前引擎场景。标准任务实际
  `provider.turn`、stats、runtime item、session journal 四份计数一致：0.183.3 为 4 个请求、5 个逻辑回合；
  同一自适应 mock 在 0.183.2 完成同样产物需 6 个请求。错误 intent、只读、能力未知、拒绝 brief 和用户
  插话仍阻止或丢弃相应动作。这不是在线模型速度或首次 intent 正确率的测量。
- 方舟默认 DeepSeek 的合成代码长上下文重复测试通过：两次实际 input 都是 97,835，第二次 reported
  cachedInput 为 97,792；均成功返回 fixture marker，零重试。首次字节约 6,504/5,580 ms，正文首字约
  6,652/5,711 ms；每次 output 上限 1,024。这是一次 first-observed（不保证冷缓存）与相同请求重复，
  不能当作显著提速或跨供应商性能结论。保持原 HTTP(S)_PROXY 路由，禁用脚本内重试/重定向；实际
  SDK fetch 计数为 2，无真实历史数据、未经过上下文压缩，也没有修改用户配置。
- 两处 intent 提示改为按用户授权的终局选类型；先检查不意味着只能 investigate，但想调用某工具也
  不能新增 change 权限。新提示并未改变 enum、审批或 dispatch gate。
- doctor 增加离线有效网络路由说明，隐藏 endpoint、proxy、bypass 规则和过期组织 gateway 地址。
  网络错误恢复只接受 Engine 生成的固定语法，不能靠相同前缀伪造“安全”错误。代理选择策略不变。
- 实际 Desktop React 组件的实时/历史/恢复/重连测试通过；官方 0.183.3 mock Serve 的九组 capture
  又通过实际 Desktop SSR 和 Mobile SessionScreen。无 provider-parent 的 carried-round 消息不会丢失
  终局回复。该结果不等于浏览器布局、Tauri 全壳、移动真机或公网 Relay 全链路验收。
- 方舟 Coding Plan 上的 MiniMax-M3 限额代码测试未获得完整通过结论：初次 4 个请求已改动并验证合成
  parser，但缺少已接受的完成回执；后续出现流式错误。没有自动重试直到成功，没有改用户网络或跨供应商
  复用密钥。Qwen3.8-max 本机缺可用 Personal 配置，不能标为已验收。

方法更正：provider started→streaming 反映任何模型活动，**不是可见正文首 token**。缓存缺失记为 unknown，
不能当作 0；transport token 也不是订阅账单。代理流量不会经过 globalThis.fetch，验收应在 SDK 的
实际自定义 fetch 上计时，保留用户的 effective proxy，不建议为了收集计时而直接 unset 用户网络变量。
长上下文只发送合成代码，并以最终 provider usage 的实际 input 而非字符估算证明超过 30k。

## 任务收尾与参考源码复核 — 2026-10-09（未发布候选）

本次针对“需要反复催继续”“上传已做但没有明确闭环”的反馈，只验证引擎契约与合成任务，
没有再次上传真实视频，也没有据模型自述认定 yhq 的原任务已交付。

### 源码依据

- OpenBot 干净工作树快进：`ca8d51c3` → `aff4981e`（87 个提交）；复核工具结果按 call ID 配对、
  先保存回答再转发、失败与等待分开。其全部 channel 实现并非一致，不照搬未核实的自动恢复逻辑。
- OpenAI Codex 干净工作树快进：`d4e11a9b` → `f90a578f`（1247 个提交）；复核 turn/input fence、
  有界继续、保留最后非空回复、失败/中断状态以及缺失工具结果处理。协议回合结束不等于业务验收完成。
- 上述为 2026-10-09 本机检查时的提交；没有执行上游脚本或改变 Pi/OpenCode 运行时锁定版本。
  今后研究参考仓前先检查本地修改并更新远端，不能强制覆盖用户工作。

### 候选变更

- 已接受且仍新鲜的完成回执即使没有 `final_answer`，也能用持久化任务状态生成普通助手收尾消息，
  不为补一句结束语再请求模型，不重做上传或发送。
- 未完成 todo 和 `awaiting_user` 优先于模型的成功措辞；恢复等待、真实用户选择和安全边界不被绕过。
- 暂停/错误保留已登记步骤、产物和剩余核验，明确“不等于全部完成”，并提醒先核对回执。
  显式取消不追加收尾；旧 task/turn 不向新回合写入回复或轮次用量。
- Serve 的 RPC、`event.text`、`event.turn_end.reply` 与恢复历史共享同一收尾文本；待用户或仍有
  未完成步骤的已接受回执保持 paused。Desktop 补齐 `completion_verification` 类型并测试丢帧恢复。
- 提示将交付与通知拆为独立验收步骤，先留成功回执，只重试未完成阶段。本次不是新的强类型上传
  工作流，不能据此声称所有渠道已有持久化、自动重试或 exactly-once 交付。

### 验证与剩余边界

- 私有临时候选编译通过，CLI/Serve 定向回归 123/123；其中覆盖缺失/空白收尾、矛盾成功措辞、
  等待用户、未完成清单、脱敏、陈旧 turn、错误、取消，以及 loopback Serve 的单次合成写入。
- 最终私有候选 `npm test` 通过：2397/2397，0 fail/cancel/skip，约 169 秒，Node 22.23.1。
  中间 checkpoint 的崩溃窗口已补逐快照断言；原有 CLI/Serve 夹具保留审批/取消/冷恢复检查，
  将结束语移入接受回执，区分会话命名请求，并对拒绝审批保留 blocked capability 和 paused 状态。
- Desktop 客户端、终局回复恢复、错误文案、审批与手动操作定向回归 28/28；这是传输与 reducer
  验证，`tsc --noEmit` 通过；不是 Tauri 全壳、移动真机或公网 Relay 验收。
- `hara-control` 的仓库候选对自动告警静默收单，指纹重复在 ACK 前过滤，终态和 claim 优先；
  静默收单不伪造已发送确认，自动告警重试耗尽只留 BLOCKED 记录，不逐条发例行失败通知。
  15 个离线策略用例与 2 个 Node 用例通过，未发群消息。
- 没有更新装机全局监听、替换正在运行的引擎、打包或发布。原视频任务仍需核对实际上传/通知回执，
  再由原反馈者做一次有界复测。不要为验收重复上传已成功的文件。

## 运行时收敛复核 — 2026-10-09（后续未发布候选）

本轮只处理已经复现的重复控制流，不整体替换 Hara 的多供应商运行时。参考仓复核提交为
OpenBot `aff4981e0734f15ff2fc68c86a32f765e0cae2b2` 与 Codex
`d570b3632b100e36f931797cdbdb8906d0fcafa8`（Codex 在上节复核后由 `f90a578f` 快进）；
没有改变 Pi/OpenCode 锁定版本或执行上游脚本。

### 本轮变更

- 删除独立 Todo 停滞计时和按同类工具次数判断的 Gateway 提醒。统一依据持久化进展判断；
  连续正常写文件不再因工具同名被催促换策略，带未完成 Todo 的前台任务仍能获得一次停滞提醒。
- 真实插话才重开提醒窗口；内部 reminder 不会伪装成用户介入。后台安静运行仍保留确定性停止，
  不注入聊天提醒。原权限、超时、预算及无进展停止边界不变，原生图片不可见的专项诊断仍保留。
- 重复失败共用分类、计数和重置规则，但警告的作用域生命周期与硬停止的单次运行生命周期继续隔离。
  不因新开一次运行继承旧硬停止计数，也不靠无关成功清除权限问题。
- 补齐等待用户时的人工操作、核验和恢复说明，执行命令只作展示/复制，不自动执行。
  过长或多行命令不展示成可误执行的截断片段，敏感内容继续脱敏。
- Provider 错误保持错误 RPC 和 blocked 任务状态，不误报成可继续的普通暂停；
  Serve 终态保留本回合已输出的收尾文本，不再以空 reply 擦除它。

### 验证与发布边界

- 私有隔离候选使用 Node 22.23.1 编译通过；完整 `npm test`：2425 项，2424 通过、0 失败、
  0 取消、1 跳过，约 186 秒。唯一跳过项是测试 PATH 没有 Bun 时的启动兼容性用例；
  加入本机已有 Bun 路径后单独补测，自启动用例 3/3 通过，无跳过。
- 合成回归覆盖健康连续写入、真实停滞、重复提醒抑制、两种用户插话入口、内部 reminder、
  安静子任务、失败阈值与重置、人工等待、错误终态，以及不额外请求模型/不重做已成功写入。
  该结果不是在线模型 token/速度、订阅计费、真实上传或公网全链路验收。
- 开发自检已报告到 Hara 反馈群，消息 ID `om_x100b63b9c8e488a4b11b880035cd5be`。
  没有重复确认已经确认的旧反馈，也没有关闭原上传任务工单。
- 未修改装机监听、构建正式安装包、替换正在运行的 Hara 或发布。后续发布前仍需按完整候选
  检查版本/更新链与 Desktop 对接；原任务必须凭实际回执单独验收。

## Desktop 联调与发布门禁 — 2026-10-09（CLI 0.185.0 未发布候选）

- Desktop 在缺失最后任务状态帧时按显式终态正确保留 paused；当前 turn 归属检查先于所有
  终态副作用，旧 turn 不能清除新任务、卡片或回复。RPC 失败仅在同一请求已有安全终态通知时
  抑制重复，不向普通聊天追加原始错误，也不伪造未确认用户消息的 accepted 状态或自动重发。
- 内部 reminder 的 returned/write-ahead 两种入口均不会丢弃已接受的 intake 后续动作，
  合成回归确认只执行一次、无额外模型请求；真实用户插话仍丢弃原排队动作。
- Windows 修订后 CLI 0.185.0 私有候选完整 `npm test`：2,483 通过、0 失败/取消、1 个 Windows 专项
  条件跳过（共 2,484 项，约 191 秒）。Desktop 457/457、production build 与本机 locked
  cargo check 通过；这是源码/宿主检查，不是完整 App 或移动公网验收。
- 真实 npm 包的 283 个公开文件、隔离安装、CLI/Pi API 与 OpenCode 原生执行通过；保留同一
  tarball 和 SHA-512 receipt，上传前复核且不重新打包。compiled Pi 的认证 Serve、读工具、
  同会话续跑与计量，以及已 ad-hoc 签名 Mac ARM 产物的四项 smoke 均通过。
- 发布门禁现要求 npm 等待完整跨平台 reusable CI，Linux ARM64 用自己的原生 runner；
  Mac ARM 的本机结果不能冒充 Windows、Linux、musl、Intel、Developer ID 公证或稳定 CDN 验证。
  当前尚未发布/替换装机，也没有关闭原上传工单；必须先发布并验证新 CLI，再将 Desktop
  stamp 锁到新版本的精确提交，单独走其保护环境、签名和稳定更新链。
- 首轮远端 main CI 的 Windows npm 安装超时和 Pi failed 阻止了创建 tag。已补 Windows
  工作树路径身份回归与有界 npm 安装诊断，新提交必须重新经过同样跨平台门禁；详情见
  [coding-executors-acceptance.md](coding-executors-acceptance.md#windows-远端门禁阻止发布及修订)。
