# Hara 分层记忆与同事名册设计

状态：**设计待审，审阅通过前不实现记忆存储、索引或同事合并功能。** 本文仅使用合成示例，不包含用户数据、真实同事名册或内部运维信息。

本次独立修复会加入“查找 1–2 次仍无法确定就提问”的系统规则，并启用既有的持久化提问路径。它不构成本文记忆架构已启用的证明。所有验证使用隔离数据；不修改日常 `~/.hara`。

## 1. 现状与目标

- `src/memory/store.ts` 已有 Markdown 记忆、关键词搜索及摘要。非 Workspace 模式的 `global` 指本机用户记忆；进入 `WorkspaceResourceStorage` 后，同名 `global` 实际位于当前 Workspace 的资源目录中，**不是所有 Workspace 共享的本机全局记忆**。
- `WorkspaceResources.memory` 在已绑定的资源上下文中运行；`workspace_memory_search` 只返回当前 Workspace 的历史文本。不能通过移除这个绑定来“恢复全局搜索”。
- `WorkspaceAgentStore` 已有稳定 ID、配置 revision、lifecycle epoch、改资料及归档；目前没有正式的别名/改名历史/合并映射，也没有允许任意跨 Workspace 读取的名册。
- 目标是让授权范围内的记忆和同事生命周期可查，准确区分“不存在”“有多个候选”和“当前不可见”，避免把陌生人名当成文件名或近音功能盲搜。
- 社区本地使用继续无需登录。本文不引入云同步，不改变工具、文件、模型连接或帐号区域权限。

## 2. 两层记忆与授权

| 层 | 内容与归属 | 默认可见性 | 写入权限 |
| --- | --- | --- | --- |
| 本机个人全局 | 用户明确保存的偏好、跨任务事实、本人同事目录引用 | 仅同一安装/本机个人主体；个人 Workspace 经 Host 明确绑定后可读最小摘要 | 明确“记住”或设置操作；模型只提出候选 |
| Workspace | 该 Workspace 的决策、项目事实、同事生命周期与会话摘要 | 原有资源绑定、成员关系、generation 和权限检查 | 该 Workspace 的授权用户/Host |

团队 Workspace 默认不继承个人全局正文。用户可挑选条目，批准复制到团队范围；复制生成新条目及来源引用，不能保留可绕过权限的全局文件路径。团队会话也不能把内容自动写回个人全局。个人 Workspace 被删除、换人、换帐号/区域或资源 generation 改变时，旧 grant 失效。

Host 注入不可序列化的读取能力，冻结主体、范围、区域、revision 与 generation；工具输入中的 `scope` 只是缩小查询的筛选器。Renderer/模型不能提供 home 路径、主账号 ID 或其它 Workspace ID 来获得权限。异步查询结束及提交前再次核验绑定。全局不可用时返回可见性不足，不回退扫描 home 或相邻 Workspace。

CN/GLOBAL、不同帐号和不同本机主体的数据、索引与向量库分开。区域变化不触发复制；既有跨区迁移门禁继续适用。没有帐号的本地身份绑定安装主体，不能与随后登录的帐号自动合并。

## 3. 条目、来源与写入

拟议条目（非已实现 schema）：

```ts
type MemoryRecord = {
  id: string;
  scope: "personal" | "workspace";
  binding: { principal: string; workspace?: string; region?: "CN" | "GLOBAL"; generation: string };
  kind: "preference" | "decision" | "fact" | "task_summary";
  subject?: { type: "colleague"; id: string };
  text: string;
  aliases: string[];
  revision: number;
  source: { kind: "user_confirmed" | "approved_lifecycle"; ref: string };
  createdAt: string;
  updatedAt: string;
  verifiedAt: string;
  expiresAt: string | null;
  status: "active" | "stale" | "deleted";
};
```

写入流程：候选 → 来源与凭据/提示注入扫描 → 用户确认适用范围 → CAS 提交 → 更新派生索引。用户直接保存的动作仍需通过相同扫描、大小与路径边界。工具输出、网页、附件、模型推测只可成为待确认候选，不能自发升级为事实或许可；不保存凭据、认证头、私钥、会话令牌或整段私密对话。条目不是工具授权，也不是已完成操作的证据。

去重键为“绑定范围 + kind + 规范化 subject + 内容摘要”。同范围完全相同内容幂等；相同 subject 的矛盾事实保留版本和来源，提示用户确认，不按“最新模型文本”覆盖。跨范围相同内容仍是独立条目。写入与删除使用现有私有状态文件、CAS 和身份围栏；索引失败只标记待重建，不回滚唯一正文或悄悄丢弃写入。

待审默认有效期：任务摘要 7 天；时效性事实 90 天后标 stale；偏好与明确决策不自动到期但展示 verifiedAt。过期条目退出默认摘要，按明确历史查询才能返回并带过期标记。用户删除优先于 TTL；删除同步清除正文/索引/向量，保留不含正文的最小删除标记以防旧索引复活。备份删除策略与产品保留政策单独审定。

## 4. 同事名册与生命周期

同事 ID 是身份，显示名、用户名、别名、拼音不是权限或身份。为现有名册增加追加式生命周期事件：

```ts
type ColleagueEvent = {
  id: string;
  kind: "renamed" | "merged" | "archived" | "restored";
  colleagueId: string;
  targetColleagueId?: string; // merged only; same authorized scope
  oldNames: string[];
  newName?: string;
  revision: number;
  occurredAt: string;
  approvedBy: string; // internal identity reference, not a display name
};
```

- 改名：保留 ID，把原名称纳入该身份的历史别名；旧任务绑定继续按既有 revision/epoch 围栏处理，不能自动改绑正在运行的任务。
- 合并：须明确批准源 ID 和目标 ID。CAS 一次提交历史记录及源状态；禁止自环、环路、跨范围或已不可访问目标。查询给出 `alias → currentColleagueId` 的可核查链，不自动搬会话、文件、凭据或未完成任务。
- 归档：保留 ID、历史名称与原因；默认不作为可委派对象。精确查询可以说明“已归档”，不能因为未列在活动表就重新创建同事。恢复保留同一 ID，重新校验 epoch。
- 重复名称或一条别名命中多个目标时返回 ambiguous；不凭向量相似度选定目标。可见性不足时不泄露另一范围同事是否存在。
- 别名和合并记录不按普通记忆 TTL 到期；在同事保留期内持续可查。删除同事后按隐私策略保留最小防复活记录，不无限保留可识别人名。

合成例：`Mori（旧称） → Mira（当前同事）` 只可由明确批准的生命周期记录建立，不能由聊天中的一句推测自动写入。若当前身份已不可访问，只说明当前授权范围无法确定。

## 5. 索引与排序

第一阶段复用现有搜索接口，增加按绑定范围隔离的关键词/别名倒排索引；不新增外部服务。正文仍是事实源，索引可从通过扫描的记录重建。

规范化只用于检索：NFKC、空白处理、拉丁字母大小写折叠、中文分词、拼音全拼/首字母字段。保留原始名称显示；拼音多音字、同音字与首字母命中只生成候选。不得自动翻译/改写专名后连续扩大搜索。拼音实现及字典版本须锁定并单独评审依赖许可与平台支持。

排序：同 ID/精确当前名 → 精确历史别名/合并记录 → 关键词匹配 → 拼音候选 → 可选向量候选。范围、可见性、stale 状态在排序前过滤；命中带来源、revision、可见性和置信类别。项目条目不会凭相似度覆盖名册的身份结论。

向量为后续可选增强，默认关闭；本机生成、按主体/区域/Workspace 隔离，不将个人记忆发送给外部嵌入服务。向量记录使用 entry ID + revision，删除及权限撤回后立即排除。向量库缺失或索引过期时降为有界关键词检索，不无限重试，也不扩大授权。

## 6. 接口草案（待审，未实现）

保留现有工具名，添加字段前通过协议能力声明；旧客户端继续使用既有形状。

```ts
// query is optional; historical names require includeHistory, not implicit file scanning.
agent_list({ query?: string, includeHistory?: boolean })
// Existing default stays workspace-only; personal visibility requires a Host-owned grant.
workspace_memory_search({ query: string, scope?: "workspace" | "personal" | "visible" })

// Proposed bounded response; never a credential/path to dereference.
{
  resolution: "resolved" | "ambiguous" | "not_found" | "visibility_limited",
  visibility: "complete_for_bound_scope" | "limited",
  candidates: [{ id, currentName, matchedAlias, state, sourceRef, revision }],
  hits: [{ id, scope, title, snippet, stale, sourceRef, revision }]
}
```

每次至多 5 个候选、5 条短记忆，查询长度/响应字符数沿用现有有界工具原则。名册历史只在当前授权范围投影，不返回完整跨范围名册。读取全局摘要需 Host 已发放的只读能力；接口筛选器不发放能力。创建、改名、合并、归档沿用单独的人类批准，不复用一次查询的权限。

## 7. 有界澄清：查 1–2 次就停

1. “某同事不见了”或名词不确定时，先查当前名册/可见生命周期记录；有需要再查授权记忆。提示中先说明当前范围，不宣称能看见所有个人/团队同事。
2. 同一个指代最多两次名册/记忆查询，合并计算，改拼写、翻页或并行不能重置次数。一次已明确有歧义即可提问，不要求凑够两次。明确唯一匹配则直接按证据回答，不重复索取确认。
3. 两次仍无结果或仍有多个候选时，停止所有用于猜测指代的搜索；不读项目文件、shell、收据或其它 Workspace 来补猜测。
4. `ask_user` 提一个简短问题，不设 default；只列已有证据的候选，不虚构合并/归档事实。示例：“你指的是哪位同事，还是某个功能？请确认名称或补充说明。”
5. 问题持久化为 `awaiting_user` + `material_choice`，展示问题并结束回复中状态。该批其它工具不执行；重启只读恢复等待状态，不自动追问、续搜或重放副作用。用户下一条答复才可在原权限范围继续。

本片先在共享系统提示中加入此规则，并给 Workspace 开放既有 `ask_user` 持久化分支，使用合成 provider 验证 1/2 次查找后的暂停、歧义与同批工具不执行。**这验证的是提示规则及真实 governor 的暂停路径，不能声称已证明任意真实模型都服从提示。** 本文后续解析器实施时还应把 `referenceId + lookupCount + resolution` 作为 Host 所有的 checkpoint 状态，确定性拒绝第三次解析查询；模型输入不能清零计数。这部分属于待审记忆实现。

已识别的正常文件任务不受“同事指代澄清两次”的限制；它仍受原轮数/工具数/时限和 token 预算约束。澄清不是要求用户代替同事执行已获授权的工作。

## 8. 摘要、预算与诊断

摘要按来源和范围分配固定字符预算，个人偏好不能挤掉 Workspace 当前任务。只注入已授权的少量当前身份/别名与记忆摘要，大段内容通过有界工具查；历史记忆不是新鲜执行证据。去重提示快照，避免同一条事实在个人/Workspace 摘要重复注入。

传输 input/output 与 cachedInput 保留原始含义，不冒充计费数据。本片选择调整**新普通任务默认上限**以容纳重复固定提示，保留既有任务/委派树冻结预算和验收专用上限；不按字符估算扣 token、不伪造缓存节省。后续若要独立计费/推理预算，须先审定精确计数规则及持久化兼容性。

执行诊断只记录模型/工具调用起止、耗时、重试数量、有限重试元数据及错误类别，不包含正文、参数、模型推理、凭据或异常原文。诊断不可作为记忆候选源。查询诊断也只统计范围、命中类别与次数，不记录原始名字、问题或全局路径。

## 9. 迁移与验收计划

设计批准后分三片：A. 范围与来源模型、名册生命周期、确定性解析/澄清计数；B. 关键词/别名/拼音索引及兼容接口；C. 可选本机向量。每片独立审查，不把“写好设计”记成已启用。

旧 Markdown 与名册保留原状，先在合成副本上 dry-run 清单；个人全局与已有 scoped `global` 分别导入，不按同名目录自动混合。需真实迁移时另获授权，先保留只读快照、逐项预览，审批后才幂等写入。缺失历史关系保持 unknown，禁止从旧聊天自动推导“已合并”。

必测：

- 个人/团队、主体/帐号、区域、generation 并发隔离；撤权/换区/符号链接/CAS 失效后不读不写。
- 改名旧称可查、合并链可追溯、环路与跨范围拒绝、归档不重建、重名/同音/拼音碰撞必须澄清。
- 0/1/多个命中、全局不可见、一次/两次后提问、第三次拒绝、并行/变体/重启不可重置计数；唯一匹配不多问。
- 幂等去重、矛盾保留、来源伪造、注入/凭据候选拒绝、到期标 stale、删除及旧索引防复活。
- 索引重建/过期/损坏、向量不可用、响应与摘要上限；诊断不含合成敏感标记。

待审定：个人全局给个人 Workspace 的默认可见范围；团队选条分享流程；事实 TTL 与删除保留策略；拼音依赖/字典；接口能力版本与迁移批准步骤。审定前维持现有隔离，不实施上述记忆功能。
