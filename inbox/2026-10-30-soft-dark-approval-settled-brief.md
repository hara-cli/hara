# Soft Dark 建同事确认卡过期／拒绝态 — brief（Jeff t1060u）

时间：2026-10-30 Asia/Taipei  
授权：Jeff t1060u「可以，继续把一些优化完」＋已锁 OpenMaus 选型切片②（`inbox/2026-10-29-soft-dark-openmaus-raft-create-runtime-choice.md` §6.2）；**合／装／正式闸／PEM／tag／candidate／live 一律不碰**  
前置：切片① Core #23 每轮 `agent_create`≤1 已合 `8357c14`；本机 Soft Dark 可测。

## 产品缺口

确认卡寿命绑 run 预算（`expiresAt = attempt.startedAt + budget.timeoutMs`）。用户离开／超时／点「暂不建立」后：
- 卡从 `approvals[]` 消失；
- Core `agent_create` **throw**「同事建立未獲確認；沒有建立 Agent」；
- Soft Dark brief 下只剩错误操作条（或几乎看不见），**没有**流内「已过期／已拒绝，可请同事重新提一次」的结算态。

Raft 对齐：卡可 dismissable 坐着；Hara 不延长授权、不自动重提——只把结算说清楚。

## 产品句（钉死）

1. **过期／拒绝／中止**后，流内出现**只读结算卡**（无确认／拒绝按钮）：说明未建立同事，并提示「可请 Hara 同事重新提一次」。
2. **不**自动重提、**不**延长 `expiresAt`、**不**改人确认语义、**不** auto-approve。
3. 文案面只用「Hara 同事」／「同事」；勿写 Agent／runtime／pi 当面。
4. 与每轮上限软拒同形：失败用**结构化 JSON**，勿再靠 throw 文案当 UX 真源。

## 实现范围

### Core（小；与 #23 同文件族）

Worktree：`/Users/zhujianbo/work/projects/hara/.worktrees/core-agent-create-approval-settled-20261030`  
Branch：`feat/core-agent-create-approval-settled-20261030`  
Base：`29c567f`（= origin/main）  
Repo：`git@github.com:hara-cli/hara.git`

1. `src/workspace/local-host.ts` `approval()`／`finish`：区分 `declined`（人点否）／`expired`（timer）／`aborted`（signal／离线交互关）。
2. `agent_create`：`!approved` 时 **return**  
   `JSON.stringify({ created:false, humanConfirmed:false, approvalState:"declined"|"expired"|"aborted" })`  
   **不要 throw**「同事建立未獲確認…」（保留／更新提示词：未确认＝未建立；可请人再提一次；勿自行重弹卡除非人再要求）。
3. `answerApproval` 仍可在过期卡上 throw（防重放）；本刀不改授权校验。
4. 测：覆盖 declined／expired（及必要时 aborted）返回结构化字段、`created:false`、无新同事；turn_limit 路径保持。

### Desktop

Worktree：`/Users/zhujianbo/work/projects/hara/.worktrees/desktop-soft-dark-approval-settled-20261030`  
Branch：`feat/soft-dark-approval-settled-20261030`  
Base：`8f31198`（= origin/main）  
Repo：`git@github.com:hara-cli/hara-desktop.git`

1. i18n（en／简／繁）：`ws.approval.settledExpired`／`settledDeclined`／`settledAborted`（或合并一条带 reason）——语义：「邀请 {name} 已过期／已取消；没有建立同事。可请 Hara 同事重新提一次。」
2. Soft Dark 流内：在 Transcript／聊天列对 `agent_create` 工具结果若 `created===false` 且带 `approvalState`，渲染**只读结算卡**（复用 `wsd-approval` 外观去按钮，或轻量 status card）；brief 下即使藏成功操作条，**结算卡仍要可见**（勿塞进仅 detailed 的 ops 条）。
3. 可选：对话框打开时卡已不在 → 现有 `ws.approval.stale` 保持。
4. 测：结算卡文案三语／无按钮；`created:true` 路径不出现结算卡；brief 成功 ops 仍隐藏。

Do NOT 用脏 `hara-desktop`＠`feat/codex-model-setting-*`；Do NOT 碰安装 worktree／candidate／live。

## 验收

- Core：定向测绿（含既有 turn_cap）；`npm run build` 若惯例。
- Desk：相关 test 绿；`npx tsc --noEmit` 若惯例。
- 各开 **1 个 PR→main**（Core＋Desk）；**不要 merge**；正文写明合／装另批。
- inbox impl＋sha256（主仓 `inbox/`）。

## 明确不做

- 合／装／正式闸／PEM／tag／candidate／live／改 `~/.hara`
- 侧栏「＋」、异步委派、真实用量读取器、CloudAgent
- 延长卡寿命／auto-approve／改每轮上限数字

## 提交建议

- Core：`fix(workspace): soft-refuse agent_create when approval expires or declines`
- Desk：`fix(workspace): show Soft Dark settled approval card after expire/decline`
