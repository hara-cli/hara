Token Plan 是阿里云百炼推出的 AI 大模型订阅服务，以 Credits 统一计量，支持多种 AI 编程和智能体工具。Token Plan 提供个人版和团队版两个版本，满足从个人开发者到企业团队的不同需求。

**说明**Token Plan 目前仅支持**华北2（北京）**地域，请在[百炼控制台](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan)左上角将地域切换至**华北2（北京）**后购买并使用。

## 产品简介

Token Plan 采用 Credits 统一抵扣机制，一份订阅即可在 Claude Code、Cursor、Qwen Code、Codex、Qoder、Qoder CN、OpenClaw 等主流 AI 编程和智能体工具中使用。支持文本生成、图像生成、视频生成、语音识别、实时语音对话等多种模型，以及联网搜索、代码解释器等 Harness 工具。

Token Plan 兼容 OpenAI 和 Anthropic 接口协议，任何支持自定义 **Base URL** 和 **API Key** 的工具均可接入，判定标准是 API 协议兼容性，而非工具的界面形态。不调用标准 API 的自研工具无法配置专属 API Key，因此不能抵扣 Token Plan 套餐额度，此类场景建议改用以 `sk-` 或 `sk-ws-` 开头的按量付费 API Key。

-   **个人版**：面向个人开发者，提供 Lite、Standard、Pro 三档套餐，设有 7 天的 Credits 限额，档位越高额度越大。
-   **团队版**：面向团队和企业，提供标准座席、高级座席、尊享座席三个档位，支持多席位管理、用量分析，承诺不使用数据训练模型。

## 个人版

|     | **Lite 套餐** | **Standard 套餐** | **Pro 套餐** | **用量包** |
| --- | --- | --- | --- | --- |
| **定价** | 原价 60 元/月 限时 **39 元/月** | 原价 180 元/月 限时 **139 元/月** | 原价 600 元/月 限时 **499 元/月** | 100 元/个/月 20,000 Credits/个 |
| **每 7 天限额** | 2,500 Credits | 10,000 Credits | 40,000 Credits | 无限制 |
| **并发 Agent** | 1-2 个 | 3-4 个 | 6-8 个 | \\- |
| **购买条件** | \\- |   |   | 需有效订阅，最多 5 个 |
| **模型** | 支持文本生成、图像生成、视频生成、语音识别、实时语音对话等多种模型（[查看完整列表](/zh/model-studio/token-plan-personal-overview#tpp01-h-models)） |   |   |   |
| **Harness 工具** | 支持多种 Harness 工具，以 Credits 统一抵扣（[查看详情](/zh/model-studio/token-plan-personal-overview#tpp01-h-harness)） |   |   |   |

## 团队版

|     | **标准座席 Standard** | **高级座席 Pro** | **尊享座席 Max** | **共享用量包 Extra Bundle** |
| --- | --- | --- | --- | --- |
| **定价** | 原价 198 元/座席/月 限时 **150 元/座席/月** | 原价 698 元/座席/月 限时 **550 元/座席/月** | **1,398 元/座席/月** | 5,000 元/个/月 |
| **每月总额度** | 25,000 Credits/座席/月 | 100,000 Credits/座席/月 | 250,000 Credits/座席/月 | 625,000 Credits/个 |
| **7 天限额** | 无限制 |   |   |   |
| **模型** | 支持文本生成、图像生成、视频生成、语音识别、实时语音对话等多种模型（[查看完整列表](/zh/model-studio/token-plan-team-overview#tpt01-h-models)） |   |   |   |
| **Harness 工具** | 支持多种 Harness 工具，以 Credits 统一抵扣（[查看详情](/zh/model-studio/token-plan-harness-tool#tpws-h-models-team)） |   |   |   |
| **团队管理** | 支持多席位管理和用量分析（[团队管理](/zh/model-studio/token-plan-team-management)） |   |   |   |

## 套餐限额

### 个人版

个人版采用 7 天固定窗口限额，限额单位为 Credits：

-   **7 天限额**：自首次调用起开启 7 天计时窗口，窗口期内累计消耗达到限额后暂停服务，需等待满 7 天后额度重置。

限额触顶即暂停服务，可购买用量包补充额度继续使用，或等待窗口周期结束后额度重置。窗口期内未用完的额度不结转至下一周期。

### 团队版

团队版采用月度总额度制，无 7 天窗口限额。每个座席的月度额度在计费周期内可用，到期未使用的额度不结转。超出月度总额度后调用将被阻断，可购买共享用量包补充额度。计费周期按订购日起算（订阅月，非自然月）。例如 6 月 4 日订阅，则本计费周期有效期至下月 4 日。订阅后，系统按订阅月一次性发放全量月度额度，而非按天发放。续费仅延长订阅有效期，不会为当前计费周期叠加补充额度。

## 常见问题

### 个人版和团队版可以同时购买吗？

可以。同一阿里云账号可以同时持有个人版和团队版，各自独立计费。

### 关于 Coding Plan

Coding Plan 和 Token Plan 是两个独立的订阅产品，两者之间无法迁移或升级。Coding Plan Lite 已于 2026 年 3 月 20 日停止新购，2026 年 4 月 13 日停止续费和升级；Coding Plan Pro 为限量抢购，库存售罄后不再补充。推荐使用 **Token Plan**，支持更多模型和 Harness 工具。

### 为什么自研工具界面和官方工具相似，却不能用 Token Plan？

Token Plan 通过以 `sk-sp-` 开头的专属 API Key 和自定义 **Base URL** 抵扣套餐额度，工具必须支持 OpenAI 或 Anthropic 接口协议才能接入，界面相似不代表协议兼容。不调用标准 API 的自研工具请改用以 `sk-` 或 `sk-ws-` 开头的按量付费 API Key。

Token Plan 个人版 是面向个人开发者的 AI 大模型订阅服务，以 Credits 统一计量，支持文本、多模态模型及 Harness 工具，适配主流 AI 编程和智能体工具。

**说明**Token Plan 个人版目前仅支持**华北2（北京）**地域。

## 核心特性

-   **Credits 统一计量**：通过 Credits 统一抵扣不同模型和 Harness 工具的费用。
-   **多模态模型支持**：覆盖文本生成、推理、视觉理解、图片生成、语音合成、实时语音对话、语音识别、视频生成等能力。
-   **Harness 工具集成**：支持联网搜索、文搜图、图搜图、网页抓取、代码解释器。
-   **用量包**：超出限额后可购买用量包，不受限制继续使用。
-   **兼容多种工具**：适配 Claude Code、Cursor、Qwen Code、Qoder、Qoder CN、OpenClaw 等主流 AI 编程和智能体工具。

## 套餐档位与定价

|     | **Lite 套餐** | **Standard 套餐** | **Pro 套餐** | **用量包** |
| --- | --- | --- | --- | --- |
| **定价** | 原价 60 元/月 限时 **39 元/月** | 原价 180 元/月 限时 **139 元/月** | 原价 600 元/月 限时 **499 元/月** | 100 元/个/月 20,000 Credits/个 |
| **每 7 天限额** | 2,500 Credits | 10,000 Credits | 40,000 Credits | 无限制 |
| **并发 Agent** | 1-2 个 | 3-4 个 | 6-8 个 | \\- |
| **权益** | 文本、视觉等多模态模型 联网搜索等 Harness 工具 适配主流工具并持续扩展 | 享受 Lite 套餐所有权益 4x Lite 套餐用量 | 享受 Standard 套餐所有权益 16x Lite 套餐用量 更高的并发上限 | 不受限额约束 需先订阅套餐后购买 最多同时持有 5 个 |

-   **每 7 天限额**：自首次调用起开启 7 天计时窗口，窗口期内累计消耗达到限额后暂停服务，需等待满 7 天后额度重置。此处的"首次"指每个 7 天计量周期内的第一次调用（首个周期为购买套餐后的第一次调用，其后各周期为额度重置后的第一次调用），并非仅指购买套餐后的第一次调用。

限额触顶即暂停服务，可购买用量包补充额度继续使用，或等待窗口周期结束后额度重置。窗口期内未用完的额度不结转至下一周期。

## Credits 计费机制

**说明**不同模型按分档抵扣系数计费，视频生成等多模态模型的单次消耗明显高于文本对话，使用时需重点关注以下两点：

-   **单次消耗高**：视频生成的 Credits 随时长和分辨率上升，可能在短时间内占用较多限额。建议首次使用时以较短时长、较低分辨率试跑，通过控制台订阅页用量详情确认单次实际消耗后，再决定后续用量。
-   **异步任务集中结算**：视频生成等异步任务的 Credits 在任务完成后统一结算，而非提交时立即扣除。短时间内提交多个异步任务时，集中结算的 Credits 可能导致限额快速触顶。

### 计费说明

单次消耗的 Credits 由模型类型、Token 用量、思考模式及工具调用等动态决定，实际消耗以[控制台订阅页](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal)用量详情为准。

### 抵扣顺序

1.  每次调用消耗的 Credits 计入每 7 天限额。
2.  任一限额触顶后，服务暂停，可购买用量包补充额度、使用额度重置功能、升级至更高档位套餐，或等待对应窗口周期结束后额度自动重置。

### 额度重置

可自主使用额度重置功能，将 7 天限额归零重新计算。额度重置后，当前窗口内已消耗的 Credits 清零，限额从零开始重新累计。

额度重置需消耗重置次数。2026 年 8 月 5 日前订阅的用户，将于 8 月 5 日起获发 1 次 7 天额度重置权益，可在权益有效期内按需使用，详见[个人版用户权益升级公告](https://www.aliyun.com/notice/118513)。后续重置次数请关注官方公告或活动。

## 支持的模型

**重要**个人版部分模型享有以下限时权益：

-   **qwen3.8-max 限时夜间五折**：每晚 22:00 - 次日 08:00 期间调用 qwen3.8-max 模型，Credits 消耗享 5 折优惠。
-   **deepseek-v4-pro-0813 限时夜间五折**：每晚 22:00 - 次日 08:00 期间调用 deepseek-v4-pro-0813 模型，Credits 消耗享 5 折优惠。

阿里云百炼有权根据运营情况对活动进行变更或调整，包括不限于活动内容和有效期等，请以页面最新内容或阿里云通知为准。

qwen3.8-max-preview 已结束预览并正式下线。原有的模型 ID qwen3.8-max-preview 仍可正常调用，请求会自动路由至正式版 qwen3.8-max，Credits 抵扣和用量统计均按 qwen3.8-max 计算。建议将配置中的模型 ID 更新为 qwen3.8-max。

| **品牌** | **模型 ID（Model ID）** | **模型能力** |
| --- | --- | --- |
| 千问  | qwen3.8-max NEW | 推理模型、视觉理解、文本生成 |
| qwen3.8-flash NEW | 推理模型、视觉理解、文本生成 |
| qwen3.7-max | 推理模型、文本生成 |
| qwen3.7-plus | 推理模型、视觉理解、文本生成 |
| qwen3.6-flash | 推理模型、视觉理解、文本生成 |
| qwen-image-3.0-pro NEW | 图片生成 |
| qwen-audio-3.0-tts-plus | 语音合成 |
| qwen-audio-3.0-realtime-plus NEW | 实时语音对话 |
| qwen-audio-3.0-asr-flash NEW | 语音识别 |
| 万相  | wan2.7-image | 图片生成 |
| wan2.7-image-pro | 图片生成 |
| DeepSeek | deepseek-v4-pro | 推理模型、文本生成 |
| deepseek-v4-pro-0813 NEW | 推理模型、文本生成 |
| deepseek-v4-flash-0731 | 推理模型、文本生成 |
| 智谱 AI | glm-5.2 | 推理模型、文本生成 |
| HappyHorse | happyhorse-1.1-i2v | 视频生成 |
| happyhorse-1.1-t2v | 视频生成 |
| happyhorse-1.1-r2v | 视频生成 |

## 支持的 Harness 工具

| **工具能力** | **工具名称** |
| --- | --- |
| 联网搜索 | web\\_search |
| 文搜图 | t2i\\_search |
| 图搜图 | i2i\\_search |
| 网页抓取 | web\\_extractor |
| 代码解释器 | code\\_interpreter |

## 订阅管理

### 升级

支持从低档位升级到更高档位。升级按剩余时长补缴差价，升级后限额立即提升至新档位对应额度。

升级（含席位升级场景）发放的 Credits 并非新档位的全额周期额度，而是按实付补差金额和当前订阅周期的实际剩余有效时长折算得出，折算公式如下。

```
折算 Credits = (升级总差额 ÷ 30 天) × 实际剩余有效时长
```

例如：从 Lite 套餐升级到 Standard 套餐补缴差价 100 元，当前订阅周期剩余 15 天，则本次折算发放的 Credits 对应金额为 (100 ÷ 30) × 15 = 50 元，而非新档位当期的全额 Credits。

### 续费

续费支持切换续费周期，也可一次续费多个周期。

-   **手动续费**：支持选择不同续费时长，可续费多个周期。
-   **自动续费**：开启后到期前系统自动扣款续费。

续费仅延长订阅有效期，不会叠加补充至当前计费周期的额度。

### 其他

-   个人版暂不支持退订。
-   订阅到期后重新购买，API Key 会发生变更，需在工具中重新配置。新 API Key 可在控制台[**我的订阅**](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal)页面的 API Key 区域获取。

## 订阅前须知

1.  **严禁 API 调用**：仅限在编程工具和智能体工具（如 Claude Code、Cursor、Qwen Code、Qoder、Qoder CN、OpenClaw 等）中使用，禁止以 API 调用的形式用于自动化脚本、自定义应用程序后端或任何非交互式批量调用场景。将套餐 API Key 用于允许范围之外的调用将被视为违规或滥用，可能会导致订阅被暂停或 API Key 被封禁。
2.  **数据使用授权**：使用 Token Plan 个人版期间，模型输入以及模型生成的内容将用于服务改进与模型优化。停止使用 Token Plan 个人版服务可终止后续数据授权，但终止授权的范围不涵盖已授权使用的数据。详细条款请参见[阿里云百炼服务协议](https://terms.alicdn.com/legal-agreement/terms/common_platform_service/20230728213935489/20230728213935489.html)第 5.2 条。
3.  **账号使用规范**：套餐为订阅人专享使用，禁止共享。账号共享可能导致订阅权益受限。
4.  **购买限制**：同一实名认证主体限购一份，可同时购买个人版和团队版。
5.  **多设备使用说明**：Token Plan 个人版可将同一个 API Key 配置到您本人的多台设备（如家庭电脑和公司电脑）上使用，但仅限本人使用。将 API Key 共享给他人使用可能被判定为违规并导致封禁。
6.  **RAM 子账号无需单独实名认证**：只要主账号已完成实名认证，并为 RAM 子账号分配了席位及 API 调用权限，该 RAM 子账号即可正常使用 Token Plan，无需单独实名认证。

三步完成 Token Plan 个人版订阅和接入：选择套餐、获取 API Key、配置 AI 工具。

## 步骤一：订阅 Token Plan 个人版

访问 [Token Plan 个人版购买页面](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/overview)，选择套餐档位和订阅周期，完成订阅。

购买须知：

-   **RAM 用户授权**：RAM 用户使用 Token Plan 前，需由主账号完成以下授权：

    1.  在 [RAM 控制台](https://ram.console.aliyun.com/)为该 RAM 用户授予 `AliyunTokenPlanReadOnlyAccess`（只读）或 `AliyunTokenPlanFullAccess`（管理）系统策略，同时授予 `AliyunBSSReadOnlyAccess` 系统策略。
    2.  在百炼控制台[账号管理](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/uac-admin/organization/members/list)页面，为该 RAM 用户分配管理员或订阅套餐权限。

## 步骤二：获取 API Key 和 Base URL

-   **API Key**：订阅完成后，在 Token Plan 控制台的**我的订阅**页面生成 API Key。API Key 仅在生成时完整显示一次，请立即复制并妥善保存。
-   **Base URL**：根据 AI 工具支持的协议，选择对应的 Base URL。

| **协议** | **Base URL** |
| --- | --- |
| OpenAI 兼容 | `[https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1](https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1)` |
| Anthropic 兼容 | `[https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic](https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic)` |

**重要**Token Plan 的 API Key 以 `sk-sp-` 开头，与百炼通用 API Key（`sk-` 开头）格式不同，两者不可混用。Token Plan、Coding Plan 和按量付费的 API Key 与 Base URL 完全隔离，必须配套使用。

## 步骤三：接入 AI 工具

将 API Key 和 Base URL 配置到 AI 工具中，即可开始使用。

| ![](https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openclaw-color.svg)**[OpenClaw](/zh/model-studio/openclaw)** 开源、自托管个人 AI 助手 | ![](https://unpkg.com/@lobehub/icons-static-svg@latest/icons/nousresearch.svg)**[Hermes Agent](/zh/model-studio/hermes-agent)** 开源 AI 代理框架，内置自学习循环 | ![](https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude-color.svg)**[Claude Code](/zh/model-studio/claude-code)** AI 终端编码助手，支持自然语言编程 |
| --- | --- | --- |
| ![](https://unpkg.com/@lobehub/icons-static-svg@latest/icons/opencode.svg)**[OpenCode](/zh/model-studio/opencode)** 开源 AI 编程代理工具 | ![](https://unpkg.com/@lobehub/icons-static-svg@latest/icons/cursor.svg)**[Cursor](/zh/model-studio/cursor)** AI 原生代码编辑器 | ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[Codex](/zh/model-studio/codex)** OpenAI 推出的命令行编程工具 |
| ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[Qwen Code](/zh/model-studio/qwen-code)** 开源命令行 AI 编码工具 | ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[QwenPaw](/zh/model-studio/qwenpaw)** 开源个人 AI 助手，支持本地与云端部署 | ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[Cherry Studio](/zh/model-studio/cherry-studio)** 多模型桌面客户端 |
| ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[Chatbox](https://help.aliyun.com/zh/model-studio/cline-tool)** 跨平台 AI 桌面客户端 | ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[Cline](/zh/model-studio/cline)** VS Code 扩展，智能代码补全和调试 | ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[Qoder](/zh/model-studio/qoder-agent)** 面向真实软件开发的 Agentic 编码平台 |
| ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[Lingma](/zh/model-studio/lingma-agent)** 阿里云智能编码助手，提供独立 IDE | ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[Kilo CLI](/zh/model-studio/kilo-cli)** 轻量高性能命令行编程工具 | ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[DeepSeek Harness](/zh/model-studio/deepseek-harness)** DeepSeek 开源 AI Agent 框架 |
| ![](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=)**[千问办公助理](/zh/model-studio/qwen-office-assistant)** 千问 APP 办公助理，处理文档、表格等办公任务 | **[更多工具](/zh/model-studio/more-tools)** 其他编程工具 |     |

## 可选：接入多模态生成模型

Token Plan 个人版支持多模态生成模型（wan2.7-image、happyhorse-1.1-t2v 等）。多模态生成模型不兼容标准文本生成端点（`/api/v1/services/aigc/text-generation/generation`）和 OpenAI 兼容端点（`/compatible-mode/v1/chat/completions`），需使用专用端点调用。视频生成模型（如 happyhorse-1.1-t2v）使用 `/api/v1/services/aigc/video-generation/video-synthesis` 端点。通过 AI 工具的 Skill 或扩展机制接入，详见[接入多模态生成模型](/zh/model-studio/token-plan-multimodal-gen)。

### 常见问题

**调用多模态模型返回 url error 或 model\_not\_supported 怎么办？**

多模态生成模型不支持标准文本生成端点和 OpenAI 兼容端点。使用错误端点会返回 `InvalidParameter`：`url error` 或 `model_not_supported` 错误。请切换到专用端点：视频生成模型使用 `/api/v1/services/aigc/video-generation/video-synthesis`，图片生成模型使用 `/api/v1/services/aigc/image-generation/generation`。

## 可选：接入 Harness 工具

部分 Qwen 模型（qwen3.7、qwen3.8 系列）内置 Harness 工具，可在对话中扩展联网搜索、文搜图、图搜图、网页抓取、代码解释器等能力。Harness 工具仅支持通过 Responses API 调用，按成功调用次数从套餐 Credits 中抵扣。详见[接入 Harness 工具](/zh/model-studio/token-plan-harness-tool)。

**重要**Harness 工具需通过 **Responses API** 调用才会自动触发。若所用 AI 工具仅支持 Chat Completions 协议，模型可正常响应，但不会自动调用 Harness 工具，相关请求将按量付费计费，不消耗套餐 Credits 中的 Harness 工具额度。如需使用 Harness 工具，请选择兼容 Responses API 的 AI 工具（详见[接入 Harness 工具](/zh/model-studio/token-plan-harness-tool)）。

Token Plan 个人版的额度、购买、订阅和接入常见问题。

## 额度与限额

### 5 小时/7 天限额是什么意思？

Token Plan 个人版采用每 5 小时滚动窗口和每 7 天固定窗口双重限额，限额单位为 Credits。任一窗口累计消耗达到限额后暂停服务，需等待对应窗口结束后额度重置。窗口期内未用完的额度不结转至下一周期。**其中每 5 小时限额当前限时取消，暂不限制。**

例如：Standard 套餐的 7 天限额为 10,000 Credits。您在 7 月 20 日首次调用，系统开启窗口（7 月 20 日 ~ 7 月 27 日）。7 月 20 日消耗 4,000 Credits，7 月 22 日消耗 6,000 Credits，累计 10,000 Credits 触顶暂停。需等到 7 月 27 日窗口结束，额度重置为 10,000 Credits，服务恢复。

各档位限额如下：

| **档位** | **5 小时限额** | **7 天限额** |
| --- | --- | --- |
| Lite 套餐 | 700 Credits 限时 **无限制** | 2,500 Credits |
| Standard 套餐 | 3,000 Credits 限时 **无限制** | 10,000 Credits |
| Pro 套餐 | 12,000 Credits 限时 **无限制** | 40,000 Credits |

### 7 天限额是固定日期重置吗？

不是。7 天限额采用固定窗口机制，自首次调用起计时 7 天，到期后额度重置。重置时间取决于您首次调用的时间，而非固定的日历日期（如每周一）。

### 额度用完了怎么办？

限额用完后调用会被阻断，不会按量计费。恢复方式：

-   等待额度释放。
-   升级套餐。
-   购买用量包，获得不受限额约束的额外额度。

### 什么是重置卡？如何使用？

重置卡是 Token Plan 个人版订阅用户的一次性额度重置权益。在 Token Plan 订阅页面的套餐额度区域，可以看到**重置限额**按钮，按钮旁标注剩余可用次数（如“1 次可用”），单击旁边的 info 图标可查看提示“使用重置卡可立即重置套餐额度”。单击**重置限额**按钮即可立即重置套餐额度。该权益为一次性发放，非定期发放，发放时不单独发送邮件通知。

### 开通 Token Plan 后为什么仍产生按量扣费？

开通 Token Plan 后仍看到按量扣费，通常是以下原因导致：

-   **生效前调用**：开通 Token Plan 之前发生的调用属于独立计费，无法被套餐抵扣。
-   **配置错误**：未使用 Token Plan 专属 API Key 和 Base URL（例如误用百炼通用 dashscope.aliyuncs.com 或 Coding Plan 的 Key），导致请求走按量计费通道。
-   **模型不支持**：调用了 Token Plan 白名单之外的模型（如 Qwen3-VL-Plus 及部分子型号）。

已产生的按量费用无法通过 Credits 事后抵扣或退款。请立即检查并更正 API Key 和 Base URL 配置，确保后续调用正常抵扣。

### 用量包和套餐是什么关系？需要先买套餐吗？

用量包是套餐的补充，提供不受套餐限额约束的额外 Credits，需先订阅有效套餐后才能购买，最多同时持有 5 个。

### 用量包的额度有窗口限制吗？

没有。用量包额度不受套餐的 5 小时和 7 天窗口限额约束，购买后即可使用。

### 用量包有效期多久？

用量包有效期为 1 个月，到期后未使用的额度自动作废，不支持退款。

### Token Plan 的用量在哪里查看？

在[百炼控制台](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan)的 **Token Plan > 我的订阅** 页面查看当前订阅的 Credits 额度及消耗情况。

### 为什么账单/插件统计的 Credits 消耗与预期不一致？

Credits 消耗与账单或插件统计出现差异，常见原因：

-   **上下文缓存命中**：命中缓存时抵扣系数较低，未命中时抵扣系数较高。
-   **模型系列差异**：不同模型（如 Qwen 系列与 GLM 系列）的 Credits 抵扣系数不同。
-   **功能模式影响**：频繁切换工具调用或思考模式可能影响计费。

验证方法：对比具体时间段内的抵扣记录，通过“抵扣 Credits ÷ 消耗 Token”计算实际系数进行核实。

### Token Plan 是否提供免费试用额度或赠送 Token？

Token Plan 套餐本身不提供试用额度，也不包含免费赠送的 Token 额度。百炼平台针对部分模型提供独立的免费额度，可以在控制台查询可用免费额度的模型列表。

### 如何减少 Token Plan 的 Credits 消耗？

-   压缩历史消息或新开对话窗口，避免长上下文累积消耗。
-   关闭思考模式（Thinking Mode）以降低推理开销。
-   非复杂任务场景下切换至轻量模型（如 qwen3.6-plus 替代 qwen3.7-max）。
-   利用缓存机制，缓存命中的 Token 计费价格低于正常 Input Token。
-   通过**用量分析**页面监控消耗明细，及时调整使用策略。

### 为什么第三方工具（如 Claude Code）显示的 Token 用量与百炼控制台统计不一致？

-   **统计口径不同**：第三方工具仅显示模型层面的输入输出 Token；百炼控制台统计包含完整消耗项。
-   **隐藏消耗项**：系统提示词、工具定义（Schema）、用户配置、项目约定、多轮对话历史累积、工具调用参数与返回结果、模型内部推理内容（reasoning）等，均会计入 Credits 消耗但不在第三方工具中显示。
-   **模型单价影响**：Credits 消耗与模型抵扣系数相关，高价模型（如 qwen3.7-max）会导致相同 Token 数下 Credits 消耗更高。
-   **优化建议**：通过百炼控制台 Token Plan 订阅页的**用量分析**查看官方统计；使用 `/compact` 压缩历史消息或 `/clear` 新开对话以减少上下文累积。

## 接入报错

### 常见报错及解决方案

| **报错信息** | **可能原因** | **解决方案** |
| --- | --- | --- |
| 401 InvalidApiKey: No API-key provided. | 请求头中未携带 API Key | 生成 API Key 并在工具中完成配置 |
| 401 InvalidApiKey: Invalid API-key provided. | 误用了按量计费的 API Key 或 Coding Plan 的 Key；订阅过期；Key 复制不完整 | 确认使用 Token Plan 个人版 API Key，确保完整且无空格 |
| 404 model\\_not\\_found: Model not exist. | 模型名称拼写错误或不在支持列表 | 确认模型名称区分大小写，与套餐支持的模型 ID 一致。 |
| 403 AccessDenied.Unpurchased: Access to model denied. | 调用的模型仅团队版支持，个人版不支持 | 改用个人版支持的模型，或使用 Token Plan 团队版 |
| 401 invalid access token or token expired | 误用了 Coding Plan 或其他计费模式的 Base URL | 使用 Token Plan 个人版 Base URL |
| 401 Incorrect API key provided | 误用了百炼通用 Base URL（dashscope.aliyuncs.com） | 使用 Token Plan 个人版 Base URL |
| 429 Requests rate limit exceeded | 短时间内请求过于密集 | 等待一分钟后重试，降低请求频率 |
| 429 Allocated quota exceeded | 5 小时或 7 天限额用尽 | 等待窗口释放额度 |
| 400 invalid\\_parameter\\_error: Unexpected item type in content. | 向纯文本模型传入了图像等非文本内容 | 改用支持该模态的模型，或确认请求内容与模型能力匹配 |
| 502 Bad Gateway | 服务端偶发异常 | 稍后重试 |

### Token Plan 用量显示为 0 或调用仍扣费/欠费怎么办？

-   用量显示为 0 通常是因为尚未产生实际消耗，或使用了非 Token Plan 专属 API Key。
-   调用仍扣余额或产生欠费，是因为配置了普通 API Key 而非套餐专属 Key。

## 并发与性能

### 最多支持多少个 Agent 并发？

并发能力与套餐档位相关：

| **档位** | **建议并发** |
| --- | --- |
| Lite 套餐 | 可同时支持 1-2 个 Agent 并发运行 |
| Standard 套餐 | 可同时支持 3-4 个 Agent 并发运行 |
| Pro 套餐 | 可同时支持 6-8 个 Agent 并发运行 |

### 高峰期响应会变慢吗？

高峰期可能出现排队等待。如需更稳定的吞吐，可升级到更高档位或使用团队版。

### Token Plan 的限流阈值（TPM/RPM）是多少？能否提升？

官方未公开具体的 TPM/TPS/RPM 数值，限流阈值会根据整体负载动态调整以保障服务稳定性。套餐限流额度不支持提升。

优化建议：精简上下文、降低任务复杂度以减少单次输入 Token 数量；遇到限流时等待约 1 分钟后重试。

## 使用规则

### "禁止 API 生产自动化调用"具体是什么意思？

Token Plan 个人版仅供个人通过官方指定工具（如 Cursor、Claude Code、Windsurf 等）进行交互式开发。不允许将 API Key 用于生产环境的自动化服务、批量脚本或后台定时任务等非交互场景。

### 多人共用一个账号可以吗？

不可以。Token Plan 个人版限单人使用，不允许多人共用同一账号或 API Key。如需多人协作，请使用 Token Plan 团队版。

### 可以在多台设备上使用同一个 API Key 吗？

可以。Token Plan 个人版每个订阅对应一个专属 API Key，生成后请立即复制并妥善保存。您可以将同一个 API Key 配置到多台设备（如家庭电脑和公司电脑）上使用，无需为每台设备重新生成。

**重要**重置 API Key 会使旧 Key 立即失效，届时需在所有设备上更新为新 Key。建议仅在 Key 泄露时才重置。

## 购买与订阅

### RAM 用户可以使用 Token Plan 吗？

可以，需由主账号完成以下授权：

1.  在 [RAM 控制台](https://ram.console.aliyun.com/)为该 RAM 用户授予 `AliyunTokenPlanReadOnlyAccess`（只读）或 `AliyunTokenPlanFullAccess`（管理）系统策略，同时授予 `AliyunBSSReadOnlyAccess` 系统策略。
2.  在百炼控制台[账号管理](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/uac-admin/organization/members/list)页面，为该 RAM 用户分配管理员或订阅套餐权限。

### 可以升配吗？升配后额度怎么算？

支持从低档位升级到更高档位。升级按剩余时长补缴差价，升级后限额立即提升至新档位对应额度。

### 可以降配吗？

不支持降配。如需更换为更低档位，可在订阅到期后重新购买。

### 自动续费怎么取消？

登录[百炼控制台 Token Plan](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan) 页面，在订阅管理中关闭自动续费。

### 如何查看 Token Plan 套餐的生效时间和剩余天数？

-   **生效时间查看路径**：登录[百炼控制台](https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan)的 **Token Plan** 页面查看套餐生效时间。
-   **剩余天数显示逻辑**：控制台显示的剩余天数为向下取整后的完整 24 小时周期数，实际有效期以具体结束时间戳为准（例如剩余 22 天 20 小时会显示为 22 天），属正常显示逻辑。

### Token Plan 是否支持学生代金券购买？

不支持。学生代金券仅适用于活动界面指定的产品，不能用于购买 Token Plan。



模型调用默认 按量计费 ，涵盖各类模型的计费规则与价格。

**说明**本文仅展示模型调用**原价**，请前往[百炼控制台](https://bailian.console.aliyun.com/cn-beijing?tab=model#/model-market/all)查看活动优惠。

**说明**部分模型支持**上下文缓存**（显式缓存、隐式缓存）。缓存命中的输入 Token 及创建显式缓存的 Token 采用与标准输入不同的计费单价（例如显式缓存创建按标准输入单价的 125% 计费、命中按 10% 计费），本文价格表中的输入单价**不含**缓存单价。缓存的计费规则、单价折扣及支持的模型请参见[上下文缓存](/zh/model-studio/context-cache)。

## 阶梯计费规则

百炼部分模型实行阶梯计费。单价取决于单次请求的输入 Token 总量。该请求的所有 Token 均按对应阶梯的单价结算。

计费区间中的 K 表示 1,000，M 表示 1,000,000。例如，128K 即 128,000 Token，256K 即 256,000 Token，1M 即 1,000,000 Token。

例如，某模型设有两档计费区间：0 < Token ≤ 32K 和 32K < Token ≤ 128K。若输入 100K Token，因数值落在第二区间（32K < 100K ≤ 128K），所有 Token 均按第二档单价结算。

## 文本生成-千问

### 千问Max

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费；若模型支持[上下文缓存](/zh/model-studio/context-cache)，仅输入Token享有折扣。两者不能同时生效。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-max-prime > 更多详情参考[优速模式（Prime）](/zh/model-studio/fast-mode) | 非思考和思考模式 | 0<Token≤1M | 24元 | 72元 | 无免费额度 |
| qwen3.8-max > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 | 100万Token |
| qwen3.7-max > 当前能力等同于qwen3.7-max-2026-05-20 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤1M | 原价12元**（限时5折）** | 原价36元**（限时5折）** | 100万Token |
| qwen3.7-max-2026-06-08 | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 | 100万Token |
| qwen3.7-max-2026-05-20 | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 | 100万Token |
| qwen3.7-max-preview > 当前能力等同于qwen3.7-max-2026-05-17 | 仅思考模式 | 0<Token≤1M | 12元 | 36元 | 100万Token |
| qwen3.7-max-2026-05-17 | 仅思考模式 | 0<Token≤1M | 12元 | 36元 | 100万Token |
| qwen3.6-max-preview > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤128K | 9元  | 54元 | 100万Token |
| 128K<Token≤256K | 15元 | 90元 |
| qwen3-max > 当前能力等同于qwen3-max-2026-01-23 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤32K | 2.5元 | 10元 | 100万Token |
| 32K<Token≤128K | 4元  | 16元 |
| 128K<Token≤256K | 7元  | 28元 |
| qwen3-max-2026-01-23 | 非思考和思考模式 | 0<Token≤32K | 2.5元 | 10元 | 100万Token |
| 32K<Token≤128K | 4元  | 16元 |
| 128K<Token≤256K | 7元  | 28元 |
| qwen3-max-2025-09-23 | 仅非思考模式 | 0<Token≤32K | 6元  | 24元 | 100万Token |
| 32K<Token≤128K | 10元 | 40元 |
| 128K<Token≤256K | 15元 | 60元 |
| qwen3-max-preview > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤32K | 6元  | 24元 | 100万Token |
| 32K<Token≤128K | 10元 | 40元 |
| 128K<Token≤256K | 15元 | 60元 |

##### 更多模型

| **模型 ID（Model ID）** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| qwen-max | 仅非思考模式 | 无阶梯计价 | 2.4元 | 9.6元 | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-max > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 |
| qwen3.7-max > 当前能力等同于qwen3.7-max-2026-05-20 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 原价12元**（限时5折）** | 原价36元**（限时5折）** |
| qwen3.7-max-us > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 美国  | 非思考和思考模式 | 0<Token≤1M | 原价18.736元**（限时5折）** | 原价56.207元**（限时5折）** |
| qwen3.7-max-2026-06-08 | 全球  | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 |
| qwen3.7-max-2026-05-20 | 全球  | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 |
| qwen3-max > 当前能力等同于qwen3-max-2026-01-23 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 仅非思考模式 | 0<Token≤32K | 2.5元 | 10元 |
| 32K<Token≤128K | 4元  | 16元 |
| 128K<Token≤256K | 7元  | 28元 |
| qwen3-max-2025-09-23 | 全球  | 仅非思考模式 | 0<Token≤32K | 6元  | 24元 |
| 32K<Token≤128K | 10元 | 40元 |
| 128K<Token≤256K | 15元 | 60元 |
| qwen3-max-preview > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 6元  | 24元 |
| 32K<Token≤128K | 10元 | 40元 |
| 128K<Token≤256K | 15元 | 60元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-max > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤1M | 14.988元 | 44.965元 |
| qwen3.7-max > 当前能力等同于qwen3.7-max-2026-05-20 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤1M | 原价18.736元**（限时5折）** | 原价56.207元**（限时5折）** |
| qwen3.7-max-2026-06-08 | 国际  | 非思考和思考模式 | 0<Token≤1M | 18.736元 | 56.207元 |
| qwen3.7-max-2026-05-20 | 国际  | 非思考和思考模式 | 0<Token≤1M | 18.736元 | 56.207元 |
| qwen3.6-max-preview > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤128K | 9.742元 | 58.455元 |
| 128K<Token≤256K | 14.988元 | 89.93元 |
| qwen3-max > 当前能力等同于qwen3-max-2026-01-23 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤32K | 8.807元 | 44.035元 |
| 32K<Token≤128K | 17.614元 | 88.071元 |
| 128K<Token≤256K | 22.018元 | 110.089元 |
| qwen3-max-2026-01-23 | 国际  | 非思考和思考模式 | 0<Token≤32K | 8.807元 | 44.035元 |
| 32K<Token≤128K | 17.614元 | 88.071元 |
| 128K<Token≤256K | 22.018元 | 110.089元 |
| qwen3-max-2025-09-23 | 国际  | 仅非思考模式 | 0<Token≤32K | 8.807元 | 44.035元 |
| 32K<Token≤128K | 17.614元 | 88.071元 |
| 128K<Token≤256K | 22.018元 | 110.089元 |
| qwen3-max-preview > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤32K | 8.807元 | 44.035元 |
| 32K<Token≤128K | 17.614元 | 88.071元 |
| 128K<Token≤256K | 22.018元 | 110.089元 |

##### 更多模型

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- | --- | --- |
| qwen-max > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 国际  | 仅非思考模式 | 无阶梯计价 | 11.743元 | 46.971元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-max > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 |
| qwen3.7-max > 当前能力等同于qwen3.7-max-2026-05-20 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 原价12元**（限时5折）** | 原价36元**（限时5折）** |
| qwen3.7-max-2026-06-08 | 全球  | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 |
| qwen3.7-max-2026-05-20 | 全球  | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 |
| qwen3-max > 当前能力等同于qwen3-max-2026-01-23 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 仅非思考模式 | 0<Token≤32K | 2.5元 | 10元 |
| 32K<Token≤128K | 4元  | 16元 |
| 128K<Token≤256K | 7元  | 28元 |
| qwen3-max > 当前能力等同于qwen3-max-2026-01-23 | 欧盟  | 非思考和思考模式 | 0<Token≤32K | 8.993元 | 44.965元 |
| 32K<Token≤128K | 17.986元 | 89.93元 |
| 128K<Token≤256K | 22.483元 | 112.413元 |
| qwen3-max-2026-01-23 | 欧盟  | 非思考和思考模式 | 0<Token≤32K | 8.993元 | 44.965元 |
| 32K<Token≤128K | 17.986元 | 89.93元 |
| 128K<Token≤256K | 22.483元 | 112.413元 |
| qwen3-max-2025-09-23 | 全球  | 仅非思考模式 | 0<Token≤32K | 6元  | 24元 |
| 32K<Token≤128K | 10元 | 40元 |
| 128K<Token≤256K | 15元 | 60元 |
| qwen3-max-preview > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 6元  | 24元 |
| 32K<Token≤128K | 10元 | 40元 |
| 128K<Token≤256K | 15元 | 60元 |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-max > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 |
| qwen3.7-max > 当前能力等同于qwen3.7-max-2026-05-20 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 原价12元**（限时5折）** | 原价36元**（限时5折）** |
| qwen3.7-max-2026-05-20 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 |

### 千问Plus

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.7-plus > 当前能力等同于qwen3.7-plus-2026-05-26 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 0<Token≤256K | 原价2元**（限时8折）** | 原价8元**（限时8折）** | 原价8元**（限时8折）** | 100万Token |
| 256K<Token≤1M | 原价6元**（限时8折）** | 原价24元**（限时8折）** | 原价24元**（限时8折）** |
| qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 0<Token≤256K | 2元  | 8元  | 8元  | 100万Token |
| 256K<Token≤1M | 6元  | 24元 | 24元 |
| qwen3.6-plus > 当前能力等同于qwen3.6-plus-2026-04-02 | 0<Token≤256K | 2元  | 12元 | 12元 | 100万Token |
| 256K<Token≤1M | 8元  | 48元 | 48元 |
| qwen3.6-plus-2026-04-02 | 0<Token≤256K | 2元  | 12元 | 12元 | 100万Token |
| 256K<Token≤1M | 8元  | 48元 | 48元 |
| qwen3.5-plus > 当前能力等同于qwen3.5-plus-2026-02-15 | 0<Token≤128K | 0.8元 | 4.8元 | 4.8元 | 100万Token |
| 128K<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 4元  | 24元 | 24元 |
| qwen3.5-plus-2026-04-20 | 0<Token≤128K | 0.8元 | 4.8元 | 4.8元 | 100万Token |
| 128K<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 4元  | 24元 | 24元 |
| qwen3.5-plus-2026-02-15 | 0<Token≤128K | 0.8元 | 4.8元 | 4.8元 | 100万Token |
| 128K<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 4元  | 24元 | 24元 |
| qwen-plus > 当前能力等同于qwen-plus-2025-12-01 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 0<Token≤128K | 0.8元 | 2元  | 8元  | 100万Token |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-latest > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 0<Token≤128K | 0.8元 | 2元  | 8元  | 100万Token |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-2025-12-01 | 0<Token≤128K | 0.8元 | 2元  | 8元  | 100万Token |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-2025-09-11 | 0<Token≤128K | 0.8元 | 2元  | 8元  | 100万Token |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-2025-07-28 | 0<Token≤128K | 0.8元 | 2元  | 8元  | 100万Token |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-2025-07-14 | 无阶梯计价 | 0.8元 | 2元  | 8元  | 100万Token |
| qwen-plus-2025-04-28 | 无阶梯计价 | 0.8元 | 2元  | 8元  | 100万Token |

##### 更多模型

| **模型 ID（Model ID）** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| qwen-plus-2025-01-25 | 无阶梯计价 | 0.8元 | 2元  | 100万Token |
| qwen-plus-2025-01-12 | 无阶梯计价 | 0.8元 | 2元  | 100万Token |
| qwen-plus-2024-12-20 | 无阶梯计价 | 0.8元 | 2元  | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.7-plus > 当前能力等同于qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 0<Token≤256K | 原价2元**（限时8折）** | 原价8元**（限时8折）** | 原价8元**（限时8折）** |
| 256K<Token≤1M | 原价6元**（限时8折）** | 原价24元**（限时8折）** | 原价24元**（限时8折）** |
| qwen3.7-plus-us > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 美国  | 0<Token≤256K | 原价2.998元**（限时8折）** | 原价11.991元**（限时8折）** | 原价11.991元**（限时8折）** |
| 256K<Token≤1M | 原价8.993元**（限时8折）** | 原价35.972元**（限时8折）** | 原价35.972元**（限时8折）** |
| qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 0<Token≤256K | 2元  | 8元  | 8元  |
| 256K<Token≤1M | 6元  | 24元 | 24元 |
| qwen3.6-plus > 当前能力等同于qwen3.6-plus-2026-04-02 | 全球  | 0<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 8元  | 48元 | 48元 |
| qwen3.6-plus-2026-04-02 | 全球  | 0<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 8元  | 48元 | 48元 |
| qwen3.5-plus > 当前能力等同于qwen3.5-plus-2026-02-15 | 全球  | 0<Token≤128K | 0.8元 | 4.8元 | 4.8元 |
| 128K<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 4元  | 24元 | 24元 |
| qwen3.5-plus-2026-02-15 | 全球  | 0<Token≤128K | 0.8元 | 4.8元 | 4.8元 |
| 128K<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 4元  | 24元 | 24元 |
| qwen-plus > 当前能力等同于qwen-plus-2025-12-01 | 全球  | 0<Token≤128K | 0.8元 | 2元  | 8元  |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-us > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 美国  | 0<Token≤256K | 2.936元 | 8.807元 | 29.357元 |
| 256K<Token≤1M | 8.807元 | 26.421元 | 88.071元 |
| qwen-plus-2025-12-01 | 全球  | 0<Token≤128K | 0.8元 | 2元  | 8元  |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-2025-12-01-us | 美国  | 0<Token≤256K | 2.936元 | 8.807元 | 29.357元 |
| 256K<Token≤1M | 8.807元 | 26.421元 | 88.071元 |
| qwen-plus-2025-09-11 | 全球  | 0<Token≤128K | 0.8元 | 2元  | 8元  |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-2025-07-28 | 全球  | 0<Token≤128K | 0.8元 | 2元  | 8元  |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.7-plus > 当前能力等同于qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 0<Token≤256K | 原价2.998元**（限时8折）** | 原价11.991元**（限时8折）** | 原价11.991元**（限时8折）** |
| 256K<Token≤1M | 原价8.993元**（限时8折）** | 原价35.972元**（限时8折）** | 原价35.972元**（限时8折）** |
| qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 0<Token≤256K | 2.998元 | 11.991元 | 11.991元 |
| 256K<Token≤1M | 8.993元 | 35.972元 | 35.972元 |
| qwen3.6-plus > 当前能力等同于qwen3.6-plus-2026-04-02 | 国际  | 0<Token≤256K | 3.7471元 | 22.4826元 | 22.4826元 |
| 256K<Token≤1M | 14.9884元 | 44.965元 | 44.965元 |
| qwen3.6-plus-2026-04-02 | 国际  | 0<Token≤256K | 3.7471元 | 22.4826元 | 22.4826元 |
| 256K<Token≤1M | 14.9884元 | 44.965元 | 44.965元 |
| qwen3.5-plus > 当前能力等同于qwen3.5-plus-2026-02-15 | 国际  | 0<Token≤256K | 2.936元 | 17.614元 | 17.614元 |
| 256K<Token≤1M | 3.67元 | 22.018元 | 22.018元 |
| qwen3.5-plus-2026-04-20 | 国际  | 0<Token≤256K | 2.936元 | 17.614元 | 17.614元 |
| 256K<Token≤1M | 3.67元 | 22.018元 | 22.018元 |
| qwen3.5-plus-2026-02-15 | 国际  | 0<Token≤256K | 2.936元 | 17.614元 | 17.614元 |
| 256K<Token≤1M | 3.67元 | 22.018元 | 22.018元 |
| qwen-plus > 当前能力等同于qwen-plus-2025-12-01 | 国际  | 0<Token≤256K | 2.936元 | 8.807元 | 29.357元 |
| 256K<Token≤1M | 8.807元 | 26.421元 | 88.071元 |
| qwen-plus-latest | 国际  | 0<Token≤256K | 2.936元 | 8.807元 | 29.357元 |
| 256K<Token≤1M | 8.807元 | 26.421元 | 88.071元 |
| qwen-plus-2025-12-01 | 国际  | 0<Token≤256K | 2.936元 | 8.807元 | 29.357元 |
| 256K<Token≤1M | 8.807元 | 26.421元 | 88.071元 |
| qwen-plus-2025-09-11 | 国际  | 0<Token≤256K | 2.936元 | 8.807元 | 29.357元 |
| 256K<Token≤1M | 8.807元 | 26.421元 | 88.071元 |
| qwen-plus-2025-07-28 | 国际  | 0<Token≤256K | 2.936元 | 8.807元 | 29.357元 |
| 256K<Token≤1M | 8.807元 | 26.421元 | 88.071元 |
| qwen-plus-2025-07-14 | 国际  | 无阶梯计价 | 2.936元 | 8.807元 | 29.357元 |
| qwen-plus-2025-04-28 | 国际  | 无阶梯计价 | 2.936元 | 8.807元 | 29.357元 |

##### 更多模型

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- | --- |
| qwen-plus-2025-01-25 | 国际  | 无阶梯计价 | 2.936元 | 8.807元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.7-plus > 当前能力等同于qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 0<Token≤256K | 原价2元**（限时8折）** | 原价8元**（限时8折）** | 原价8元**（限时8折）** |
| 256K<Token≤1M | 原价6元**（限时8折）** | 原价24元**（限时8折）** | 原价24元**（限时8折）** |
| qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 0<Token≤256K | 2元  | 8元  | 8元  |
| 256K<Token≤1M | 6元  | 24元 | 24元 |
| qwen3.6-plus > 当前能力等同于qwen3.6-plus-2026-04-02 | 全球  | 0<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 8元  | 48元 | 48元 |
| qwen3.6-plus-2026-04-02 | 全球  | 0<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 8元  | 48元 | 48元 |
| qwen3.5-plus > 当前能力等同于qwen3.5-plus-2026-02-15 | 全球  | 0<Token≤128K | 0.8元 | 4.8元 | 4.8元 |
| 128K<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 4元  | 24元 | 24元 |
| qwen3.5-plus-2026-02-15 | 全球  | 0<Token≤128K | 0.8元 | 4.8元 | 4.8元 |
| 128K<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 4元  | 24元 | 24元 |
| qwen-plus > 当前能力等同于qwen-plus-2025-12-01 | 全球  | 0<Token≤128K | 0.8元 | 2元  | 8元  |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus > 当前能力等同于qwen-plus-2025-12-01 | 欧盟  | 0<Token≤256K | 2.998元 | 8.993元 | 29.977元 |
| 256K<Token≤1M | 8.993元 | 26.979元 | 89.93元 |
| qwen-plus-2025-12-01 | 全球  | 0<Token≤128K | 0.8元 | 2元  | 8元  |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-2025-12-01 | 欧盟  | 0<Token≤256K | 2.998元 | 8.993元 | 29.977元 |
| 256K<Token≤1M | 8.993元 | 26.979元 | 89.93元 |
| qwen-plus-2025-09-11 | 全球  | 0<Token≤128K | 0.8元 | 2元  | 8元  |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |
| qwen-plus-2025-07-28 | 全球  | 0<Token≤128K | 0.8元 | 2元  | 8元  |
| 128K<Token≤256K | 2.4元 | 20元 | 24元 |
| 256K<Token≤1M | 4.8元 | 48元 | 64元 |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.7-plus > 当前能力等同于qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 日本  | 0<Token≤256K | 2.998元 | 11.991元 | 11.991元 |
| 256K<Token≤1M | 8.993元 | 35.972元 | 35.972元 |
| qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 日本  | 0<Token≤256K | 2.998元 | 11.991元 | 11.991元 |
| 256K<Token≤1M | 8.993元 | 35.972元 | 35.972元 |
| qwen3.7-plus > 当前能力等同于qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 0<Token≤256K | 原价2元**（限时8折）** | 原价8元**（限时8折）** | 原价8元**（限时8折）** |
| 256K<Token≤1M | 原价6元**（限时8折）** | 原价24元**（限时8折）** | 原价24元**（限时8折）** |
| qwen3.7-plus-2026-05-26 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 0<Token≤256K | 2元  | 8元  | 8元  |
| 256K<Token≤1M | 6元  | 24元 | 24元 |
| qwen3.6-plus > 当前能力等同于qwen3.6-plus-2026-04-02 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 0<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 8元  | 48元 | 48元 |
| qwen3.6-plus-2026-04-02 | 全球  | 0<Token≤256K | 2元  | 12元 | 12元 |
| 256K<Token≤1M | 8元  | 48元 | 48元 |

### 千问Flash

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费；若模型支持[上下文缓存](/zh/model-studio/context-cache)，仅输入Token享有折扣。两者不能同时生效。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤1M | 0.8元 | 2.7元 | 100万Token |
| qwen3.7-flash > 当前能力等同于qwen3.7-flash-2026-07-15 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤32K | 0.2元 | 0.8元 | 100万Token |
| 32K<Token≤256K | 0.6元 | 2.4元 |
| 256K<Token≤1M | 1.2元 | 4.8元 |
| qwen3.7-flash-2026-07-15 | 非思考和思考模式 | 0<Token≤32K | 0.2元 | 0.8元 | 100万Token |
| 32K<Token≤256K | 0.6元 | 2.4元 |
| 256K<Token≤1M | 1.2元 | 4.8元 |
| qwen3.6-flash > 当前能力等同于qwen3.6-flash-2026-04-16 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤256K | 1.2元 | 7.2元 | 100万Token |
| 256K<Token≤1M | 4.8元 | 28.8元 |
| qwen3.6-flash-2026-04-16 | 非思考和思考模式 | 0<Token≤256K | 1.2元 | 7.2元 | 100万Token |
| 256K<Token≤1M | 4.8元 | 28.8元 |
| qwen3.5-flash > 当前能力等同于qwen3.5-flash-2026-02-23 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤128K | 0.2元 | 2元  | 100万Token |
| 128K<Token≤256K | 0.8元 | 8元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen3.5-flash-2026-02-23 | 非思考和思考模式 | 0<Token≤128K | 0.2元 | 2元  | 100万Token |
| 128K<Token≤256K | 0.8元 | 8元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen-flash > 当前能力等同于qwen-flash-2025-07-28 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤128K | 0.15元 | 1.5元 | 100万Token |
| 128K<Token≤256K | 0.6元 | 6元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen-flash-2025-07-28 | 非思考和思考模式 | 0<Token≤128K | 0.15元 | 1.5元 | 100万Token |
| 128K<Token≤256K | 0.6元 | 6元  |
| 256K<Token≤1M | 1.2元 | 12元 |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 0.8元 | 2.7元 |
| qwen3.7-flash > 当前能力等同于qwen3.7-flash-2026-07-15 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 0.2元 | 0.8元 |
| 32K<Token≤256K | 0.6元 | 2.4元 |
| 256K<Token≤1M | 1.2元 | 4.8元 |
| qwen3.6-flash > 当前能力等同于qwen3.6-flash-2026-04-16 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤256K | 1.2元 | 7.2元 |
| 256K<Token≤1M | 4.8元 | 28.8元 |
| qwen3.6-flash-2026-04-16 | 全球  | 非思考和思考模式 | 0<Token≤256K | 1.2元 | 7.2元 |
| 256K<Token≤1M | 4.8元 | 28.8元 |
| qwen3.6-flash-us | 美国  | 非思考和思考模式 | 0<Token≤256K | 1.87355元 | 11.2413元 |
| 256K<Token≤1M | 7.4942元 | 29.9758元 |
| qwen3.5-flash > 当前能力等同于qwen3.5-flash-2026-02-23 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤128K | 0.2元 | 2元  |
| 128K<Token≤256K | 0.8元 | 8元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen3.5-flash-2026-02-23 | 全球  | 非思考和思考模式 | 0<Token≤128K | 0.2元 | 2元  |
| 128K<Token≤256K | 0.8元 | 8元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen-flash > 当前能力等同于qwen-flash-2025-07-28 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤128K | 0.15元 | 1.5元 |
| 128K<Token≤256K | 0.6元 | 6元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen-flash-us > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 美国  | 非思考和思考模式 | 0<Token≤256K | 0.367元 | 2.936元 |
| 256K<Token≤1M | 1.835元 | 14.678元 |
| qwen-flash-2025-07-28 | 全球  | 非思考和思考模式 | 0<Token≤128K | 0.15元 | 1.5元 |
| 128K<Token≤256K | 0.6元 | 6元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen-flash-2025-07-28-us | 美国  | 非思考和思考模式 | 0<Token≤256K | 0.367元 | 2.936元 |
| 256K<Token≤1M | 1.835元 | 14.678元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤1M | 1.094元 | 3.427元 |
| qwen3.7-flash > 当前能力等同于qwen3.7-flash-2026-07-15 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤32K | 0.225元 | 0.974元 |
| 32K<Token≤256K | 0.749元 | 2.998元 |
| 256K<Token≤1M | 1.499元 | 5.995元 |
| qwen3.7-flash-2026-07-15 | 国际  | 非思考和思考模式 | 0<Token≤32K | 0.225元 | 0.974元 |
| 32K<Token≤256K | 0.749元 | 2.998元 |
| 256K<Token≤1M | 1.499元 | 5.995元 |
| qwen3.6-flash > 当前能力等同于qwen3.6-flash-2026-04-16 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤256K | 1.87355元 | 11.2413元 |
| 256K<Token≤1M | 7.4942元 | 29.9758元 |
| qwen3.6-flash-2026-04-16 | 国际  | 非思考和思考模式 | 0<Token≤256K | 1.87355元 | 11.2413元 |
| 256K<Token≤1M | 7.4942元 | 29.9758元 |
| qwen3.5-flash > 当前能力等同于qwen3.5-flash-2026-02-23 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤1M | 0.734元 | 2.936元 |
| qwen3.5-flash-2026-02-23 | 国际  | 非思考和思考模式 | 0<Token≤1M | 0.734元 | 2.936元 |
| qwen-flash > 当前能力等同于qwen-flash-2025-07-28 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤256K | 0.367元 | 2.936元 |
| 256K<Token≤1M | 1.835元 | 14.678元 |
| qwen-flash-2025-07-28 | 国际  | 非思考和思考模式 | 0<Token≤256K | 0.367元 | 2.936元 |
| 256K<Token≤1M | 1.835元 | 14.678元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 0.8元 | 2.7元 |
| qwen3.7-flash > 当前能力等同于qwen3.7-flash-2026-07-15 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 0.2元 | 0.8元 |
| 32K<Token≤256K | 0.6元 | 2.4元 |
| 256K<Token≤1M | 1.2元 | 4.8元 |
| qwen3.7-flash-2026-07-15 | 全球  | 非思考和思考模式 | 0<Token≤32K | 0.2元 | 0.8元 |
| 32K<Token≤256K | 0.6元 | 2.4元 |
| 256K<Token≤1M | 1.2元 | 4.8元 |
| qwen3.6-flash > 当前能力等同于qwen3.6-flash-2026-04-16 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤256K | 1.2元 | 7.2元 |
| 256K<Token≤1M | 4.8元 | 28.8元 |
| qwen3.6-flash-2026-04-16 | 全球  | 非思考和思考模式 | 0<Token≤256K | 1.2元 | 7.2元 |
| 256K<Token≤1M | 4.8元 | 28.8元 |
| qwen3.5-flash > 当前能力等同于qwen3.5-flash-2026-02-23 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤128K | 0.2元 | 2元  |
| 128K<Token≤256K | 0.8元 | 8元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen3.5-flash > 当前能力等同于qwen3.5-flash-2026-02-23 | 欧盟  | 非思考和思考模式 | 0<Token≤1M | 0.749元 | 2.998元 |
| qwen3.5-flash-2026-02-23 | 全球  | 非思考和思考模式 | 0<Token≤128K | 0.2元 | 2元  |
| 128K<Token≤256K | 0.8元 | 8元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen3.5-flash-2026-02-23 | 欧盟  | 非思考和思考模式 | 0<Token≤1M | 0.749元 | 2.998元 |
| qwen-flash > 当前能力等同于qwen-flash-2025-07-28 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤128K | 0.15元 | 1.5元 |
| 128K<Token≤256K | 0.6元 | 6元  |
| 256K<Token≤1M | 1.2元 | 12元 |
| qwen-flash-2025-07-28 | 全球  | 非思考和思考模式 | 0<Token≤128K | 0.15元 | 1.5元 |
| 128K<Token≤256K | 0.6元 | 6元  |
| 256K<Token≤1M | 1.2元 | 12元 |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤1M | 0.8元 | 2.7元 |
| qwen3.7-flash > 当前能力等同于qwen3.7-flash-2026-07-15 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 0.2元 | 0.8元 |
| 32K<Token≤256K | 0.6元 | 2.4元 |
| 256K<Token≤1M | 1.2元 | 4.8元 |
| qwen3.7-flash-2026-07-15 | 全球  | 非思考和思考模式 | 0<Token≤32K | 0.2元 | 0.8元 |
| 32K<Token≤256K | 0.6元 | 2.4元 |
| 256K<Token≤1M | 1.2元 | 4.8元 |
| qwen3.6-flash > 当前能力等同于qwen3.6-flash-2026-04-16 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤256K | 1.2元 | 7.2元 |
| 256K<Token≤1M | 4.8元 | 28.8元 |
| qwen3.6-flash-2026-04-16 | 全球  | 非思考和思考模式 | 0<Token≤256K | 1.2元 | 7.2元 |
| 256K<Token≤1M | 4.8元 | 28.8元 |

### 千问Turbo

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen-turbo | 非思考和思考模式 | 0.3元 | 0.6元 | 3元  | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen-turbo > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 国际  | 非思考和思考 | 0.367元 | 1.468元 | 3.67元 |

### QwQ

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| qwq-plus | 仅思考模式 | 1.6元 | 4元  | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- | --- |
| qwq-plus | 国际  | 仅思考模式 | 5.871元 | 17.614元 |

### 千问Long

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen-long > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 0.5元 | 2元  | 100万Token |
| qwen-long-latest | 0.5元 | 2元  | 100万Token |
| qwen-long-2025-01-25 | 0.5元 | 2元  | 100万Token |

### 千问Omni

计费规则：按输入Token和输出Token计费。不同模态的Token计算规则请参见[计费与限流](/zh/model-studio/qwen-omni#a9018938d3niq)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** |   | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **文本/图片/视频** | **音频** | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-omni-plus > 当前能力等同于qwen3.5-omni-plus-2026-03-15 | 7元  | 53元 | 40元 | 213元 | 100万Token |
| qwen3.5-omni-plus-2026-03-15 | 7元  | 53元 | 40元 | 213元 | 100万Token |
| qwen3.5-omni-flash > 当前能力等同于qwen3.5-omni-flash-2026-03-15 | 2.2元 | 18元 | 13.3元 | 72元 | 100万Token |
| qwen3.5-omni-flash-2026-03-15 | 2.2元 | 18元 | 13.3元 | 72元 | 100万Token |

更多模型

| **模型 ID（Model ID）** | **模式** | **输入单价（每百万Token）** |   |   | **输出单价（每百万Token）** |   |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **文本** | **音频** | **图片/视频** | **文本** > 仅纯文本输入 | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3-omni-flash > 当前能力等同于qwen3-omni-flash-2025-12-01 | 非思考和思考模式 | 1.8元 | 15.8元 | 3.3元 | 6.9元 | 12.7元 | 62.6元 | 100万Token |
| qwen3-omni-flash-2025-12-01 | 非思考和思考模式 | 1.8元 | 15.8元 | 3.3元 | 6.9元 | 12.7元 | 62.6元 | 100万Token |
| qwen3-omni-flash-2025-09-15 | 非思考和思考模式 | 1.8元 | 15.8元 | 3.3元 | 6.9元 | 12.7元 | 62.6元 | 100万Token |
| qwen-omni-turbo > 当前能力等同于qwen-omni-turbo-2025-03-26 | 非思考模式 | 0.4元 | 25元 | 1.5元 | 1.6元 | 4.5元 | 50元 | 100万Token |
| qwen-omni-turbo-latest | 非思考模式 | 0.4元 | 25元 | 1.5元 | 1.6元 | 4.5元 | 50元 | 100万Token |
| qwen-omni-turbo-2025-03-26 | 非思考模式 | 0.4元 | 25元 | 1.5元 | 1.6元 | 4.5元 | 50元 | 100万Token |
| qwen-omni-turbo-2025-01-19 | 非思考模式 | 0.4元 | 25元 | 1.5元 | 1.6元 | 4.5元 | 50元 | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** |   | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **文本/图片/视频** | **音频** | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-omni-plus > 当前能力等同于qwen3.5-omni-plus-2026-03-15 | 国际  | 10.49元 | 82.44元 | 62.2元 | 329.74元 |
| qwen3.5-omni-plus-2026-03-15 | 国际  | 10.49元 | 82.44元 | 62.2元 | 329.74元 |
| qwen3.5-omni-flash > 当前能力等同于qwen3.5-omni-flash-2026-03-15 | 国际  | 3元  | 22.48元 | 16.49元 | 89.18元 |
| qwen3.5-omni-flash-2026-03-15 | 国际  | 3元  | 22.48元 | 16.49元 | 89.18元 |

更多模型

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** |   |   | **输出单价（每百万Token）** |   |   |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **文本** | **音频** | **图片/视频** | **文本** > 仅纯文本输入 | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3-omni-flash > 当前能力等同于qwen3-omni-flash-2025-12-01 | 国际  | 非思考和思考模式 | 3.156元 | 27.962元 | 5.725元 | 12.183元 | 22.458元 | 110.896元 |
| qwen3-omni-flash-2025-12-01 | 国际  | 非思考和思考模式 | 3.156元 | 27.962元 | 5.725元 | 12.183元 | 22.458元 | 110.896元 |
| qwen3-omni-flash-2025-09-15 | 国际  | 非思考和思考模式 | 3.156元 | 27.962元 | 5.725元 | 12.183元 | 22.458元 | 110.896元 |
| qwen-omni-turbo > 当前能力等同于qwen-omni-turbo-2025-03-26 | 国际  | 非思考模式 | 0.514元 | 32.586元 | 1.541元 | 1.982元 | 4.624元 | 65.246元 |
| qwen-omni-turbo-latest | 国际  | 非思考模式 | 0.514元 | 32.586元 | 1.541元 | 1.982元 | 4.624元 | 65.246元 |
| qwen-omni-turbo-2025-03-26 | 国际  | 非思考模式 | 0.514元 | 32.586元 | 1.541元 | 1.982元 | 4.624元 | 65.246元 |

### 千问Omni-Realtime

计费规则：按输入Token和输出Token计费。不同模态的Token计算规则请参见[计费与限流](/zh/model-studio/realtime#cb5caf6a0dg4k)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** |   | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **文本/图片** | **音频** | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-omni-plus-realtime > 当前能力等同于qwen3.5-omni-plus-realtime-2026-03-15 | 10元 | 80元 | 60元 | 300元 | 100万Token |
| qwen3.5-omni-plus-realtime-2026-03-15 | 10元 | 80元 | 60元 | 300元 | 100万Token |
| qwen3.5-omni-flash-realtime > 当前能力等同于qwen3.5-omni-flash-realtime-2026-03-15 | 3.3元 | 27元 | 20元 | 107元 | 100万Token |
| qwen3.5-omni-flash-realtime-2026-03-15 | 3.3元 | 27元 | 20元 | 107元 | 100万Token |

更多模型

| **模型 ID（Model ID）** | **输入单价（每百万Token）** |   |   | **输出单价（每百万Token）** |   |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **文本** | **音频** | **图片** | **文本** > 仅纯文本输入 | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3-omni-flash-realtime > 当前能力等同于qwen3-omni-flash-realtime-2025-12-01 | 2.2元 | 18.9元 | 3.9元 | 8.3元 | 15.2元 | 75.1元 | 100万Token |
| qwen3-omni-flash-realtime-2025-12-01 | 2.2元 | 18.9元 | 3.9元 | 8.3元 | 15.2元 | 75.1元 | 100万Token |
| qwen3-omni-flash-realtime-2025-09-15 | 2.2元 | 18.9元 | 3.9元 | 8.3元 | 15.2元 | 75.1元 | 100万Token |
| qwen-omni-turbo-realtime > 当前能力等同于qwen-omni-turbo-realtime-2025-05-08 | 1.6元 | 25元 | 6元  | 6.4元 | 18元 | 50元 | 100万Token |
| qwen-omni-turbo-realtime-latest | 1.6元 | 25元 | 6元  | 6.4元 | 18元 | 50元 | 100万Token |
| qwen-omni-turbo-realtime-2025-05-08 | 1.6元 | 25元 | 6元  | 6.4元 | 18元 | 50元 | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** |   | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **文本/图片** | **音频** | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-omni-plus-realtime > 当前能力等同于qwen3.5-omni-plus-realtime-2026-03-15 | 国际  | 15.74元 | 123.65元 | 92.93元 | 464.64元 |
| qwen3.5-omni-plus-realtime-2026-03-15 | 国际  | 15.74元 | 123.65元 | 92.93元 | 464.64元 |
| qwen3.5-omni-flash-realtime > 当前能力等同于qwen3.5-omni-flash-realtime-2026-03-15 | 国际  | 4.12元 | 33.72元 | 24.73元 | 132.65元 |
| qwen3.5-omni-flash-realtime-2026-03-15 | 国际  | 4.12元 | 33.72元 | 24.73元 | 132.65元 |

更多模型

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** |   |   | **输出单价（每百万Token）** |   |   |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **文本** | **音频** | **图片** | **文本** > 仅纯文本输入 | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen3-omni-flash-realtime > 当前能力等同于qwen3-omni-flash-realtime-2025-12-01 | 国际  | 3.816元 | 33.54元 | 6.899元 | 14.605元 | 26.935元 | 133.06元 |
| qwen3-omni-flash-realtime-2025-12-01 | 国际  | 3.816元 | 33.54元 | 6.899元 | 14.605元 | 26.935元 | 133.06元 |
| qwen3-omni-flash-realtime-2025-09-15 | 国际  | 3.816元 | 33.54元 | 6.899元 | 14.605元 | 26.935元 | 133.06元 |
| qwen-omni-turbo-realtime > 当前能力等同于qwen-omni-turbo-realtime-2025-05-08 | 国际  | 1.982元 | 32.586元 | 6.165元 | 7.853元 | 18.495元 | 65.246元 |
| qwen-omni-turbo-realtime-latest | 国际  | 1.982元 | 32.586元 | 6.165元 | 7.853元 | 18.495元 | 65.246元 |
| qwen-omni-turbo-realtime-2025-05-08 | 国际  | 1.982元 | 32.586元 | 6.165元 | 7.853元 | 18.495元 | 65.246元 |

### QVQ

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qvq-max | 8元  | 32元 | 100万Token |
| qvq-plus | 2元  | 5元  | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- |
| qvq-max | 国际  | 8.807元 | 35.228元 |

### 千问VL

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| qwen3-vl-plus > 当前能力等同于qwen3-vl-plus-2025-12-19 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤32K | 1元  | 10元 | 100万Token |
| 32K<Token≤128K | 1.5元 | 15元 |
| 128K<Token≤256K | 3元  | 30元 |
| qwen3-vl-plus-2025-12-19 | 非思考和思考模式 | 0<Token≤32K | 1元  | 10元 | 100万Token |
| 32K<Token≤128K | 1.5元 | 15元 |
| 128K<Token≤256K | 3元  | 30元 |
| qwen3-vl-plus-2025-09-23 | 非思考和思考模式 | 0<Token≤32K | 1元  | 10元 | 100万Token |
| 32K<Token≤128K | 1.5元 | 15元 |
| 128K<Token≤256K | 3元  | 30元 |
| qwen3-vl-flash > 当前能力等同于qwen3-vl-flash-2026-01-22 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤32K | 0.15元 | 1.5元 | 100万Token |
| 32K<Token≤128K | 0.3元 | 3元  |
| 128K<Token≤256K | 0.6元 | 6元  |
| qwen3-vl-flash-2026-01-22 | 非思考和思考模式 | 0<Token≤32K | 0.15元 | 1.5元 | 100万Token |
| 32K<Token≤128K | 0.3元 | 3元  |
| 128K<Token≤256K | 0.6元 | 6元  |
| qwen3-vl-flash-2025-10-15 | 非思考和思考模式 | 0<Token≤32K | 0.15元 | 1.5元 | 100万Token |
| 32K<Token≤128K | 0.3元 | 3元  |
| 128K<Token≤256K | 0.6元 | 6元  |

##### 更多模型

| **模型 ID（Model ID）** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| qwen-vl-max > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 无阶梯计价 | 1.6元 | 4元  | 100万Token |
| qwen-vl-plus > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 无阶梯计价 | 0.8元 | 2元  | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3-vl-flash > 当前能力等同于qwen3-vl-flash-2025-10-15 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 0.15元 | 1.5元 |
| 32K<Token≤128K | 0.3元 | 3元  |
| 128K<Token≤256K | 0.6元 | 6元  |
| qwen3-vl-flash-us > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 美国  | 非思考和思考模式 | 0<Token≤32K | 0.367元 | 2.936元 |
| 32K<Token≤128K | 0.55元 | 4.404元 |
| 128K<Token≤256K | 0.881元 | 7.046元 |
| qwen3-vl-flash-2026-01-22-us | 美国  | 非思考和思考模式 | 0<Token≤32K | 0.367元 | 2.936元 |
| 32K<Token≤128K | 0.55元 | 4.404元 |
| 128K<Token≤256K | 0.881元 | 7.046元 |
| qwen3-vl-flash-2025-10-15 | 全球  | 非思考和思考模式 | 0<Token≤32K | 0.15元 | 1.5元 |
| 32K<Token≤128K | 0.3元 | 3元  |
| 128K<Token≤256K | 0.6元 | 6元  |
| qwen3-vl-flash-2025-10-15-us | 美国  | 非思考和思考模式 | 0<Token≤32K | 0.367元 | 2.936元 |
| 32K<Token≤128K | 0.55元 | 4.404元 |
| 128K<Token≤256K | 0.881元 | 7.046元 |
| qwen3-vl-plus > 当前能力等同于qwen3-vl-plus-2025-12-19 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 1元  | 10元 |
| 32K<Token≤128K | 1.5元 | 15元 |
| 128K<Token≤256K | 3元  | 30元 |
| qwen3-vl-plus-2025-09-23 | 全球  | 非思考和思考模式 | 0<Token≤32K | 1元  | 10元 |
| 32K<Token≤128K | 1.5元 | 15元 |
| 128K<Token≤256K | 3元  | 30元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- | --- | --- |
| qwen3-vl-plus > 当前能力等同于qwen3-vl-plus-2025-12-19 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤32K | 1.468元 | 11.743元 |
| 32K<Token≤128K | 2.202元 | 17.614元 |
| 128K<Token≤256K | 4.404元 | 35.228元 |
| qwen3-vl-plus-2025-12-19 | 国际  | 非思考和思考模式 | 0<Token≤32K | 1.468元 | 11.743元 |
| 32K<Token≤128K | 2.202元 | 17.614元 |
| 128K<Token≤256K | 4.404元 | 35.228元 |
| qwen3-vl-plus-2025-09-23 | 国际  | 非思考和思考模式 | 0<Token≤32K | 1.468元 | 11.743元 |
| 32K<Token≤128K | 2.202元 | 17.614元 |
| 128K<Token≤256K | 4.404元 | 35.228元 |
| qwen3-vl-flash > 当前能力等同于qwen3-vl-flash-2026-01-22 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤32K | 0.367元 | 2.936元 |
| 32K<Token≤128K | 0.55元 | 4.404元 |
| 128K<Token≤256K | 0.881元 | 7.046元 |
| qwen3-vl-flash-2026-01-22 | 国际  | 非思考和思考模式 | 0<Token≤32K | 0.367元 | 2.936元 |
| 32K<Token≤128K | 0.55元 | 4.404元 |
| 128K<Token≤256K | 0.881元 | 7.046元 |
| qwen3-vl-flash-2025-10-15 | 国际  | 非思考和思考模式 | 0<Token≤32K | 0.367元 | 2.936元 |
| 32K<Token≤128K | 0.55元 | 4.404元 |
| 128K<Token≤256K | 0.881元 | 7.046元 |

##### 更多模型

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token数** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- | --- |
| qwen-vl-max > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 无阶梯计价 | 5.871元 | 23.486元 |
| qwen-vl-plus > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 无阶梯计价 | 1.541元 | 4.624元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3-vl-flash > 当前能力等同于qwen3-vl-flash-2025-10-15 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 0.15元 | 1.5元 |
| 32K<Token≤128K | 0.3元 | 3元  |
| 128K<Token≤256K | 0.6元 | 6元  |
| qwen3-vl-flash > 当前能力等同于qwen3-vl-flash-2026-01-22 | 欧盟  | 非思考和思考模式 | 0<Token≤32K | 0.375元 | 2.998元 |
| 32K<Token≤128K | 0.562元 | 4.497元 |
| 128K<Token≤256K | 0.899元 | 7.194元 |
| qwen3-vl-flash-2026-01-22 | 欧盟  | 非思考和思考模式 | 0<Token≤32K | 0.375元 | 2.998元 |
| 32K<Token≤128K | 0.562元 | 4.497元 |
| 128K<Token≤256K | 0.899元 | 7.194元 |
| qwen3-vl-flash-2025-10-15 | 全球  | 非思考和思考模式 | 0<Token≤32K | 0.15元 | 1.5元 |
| 32K<Token≤128K | 0.3元 | 3元  |
| 128K<Token≤256K | 0.6元 | 6元  |
| qwen3-vl-flash-2025-10-15 | 欧盟  | 非思考和思考模式 | 0<Token≤32K | 0.375元 | 2.998元 |
| 32K<Token≤128K | 0.562元 | 4.497元 |
| 128K<Token≤256K | 0.899元 | 7.194元 |
| qwen3-vl-plus > 当前能力等同于qwen3-vl-plus-2025-12-19 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 1元  | 10元 |
| 32K<Token≤128K | 1.5元 | 15元 |
| 128K<Token≤256K | 3元  | 30元 |
| qwen3-vl-plus | 欧盟  | 非思考和思考模式 | 0<Token≤32K | 1.499元 | 11.991元 |
| 32K<Token≤128K | 2.248元 | 17.986元 |
| 128K<Token≤256K | 4.497元 | 35.972元 |
| qwen3-vl-plus-2025-09-23 | 全球  | 非思考和思考模式 | 0<Token≤32K | 1元  | 10元 |
| 32K<Token≤128K | 1.5元 | 15元 |
| 128K<Token≤256K | 3元  | 30元 |
| qwen3-vl-plus-2025-09-23 | 欧盟  | 非思考和思考模式 | 0<Token≤32K | 1.499元 | 11.991元 |
| 32K<Token≤128K | 2.248元 | 17.986元 |
| 128K<Token≤256K | 4.497元 | 35.972元 |

### 千问OCR

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3.5-ocr | 0.5元 | 2元  | 100万Token |
| qwen-vl-ocr > 当前能力等同于qwen-vl-ocr-2025-11-20 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 0.3元 | 0.5元 | 100万Token |
| qwen-vl-ocr-latest > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 0.3元 | 0.5元 | 100万Token |
| qwen-vl-ocr-2025-11-20 | 0.3元 | 0.5元 | 100万Token |
| qwen-vl-ocr-2025-08-28 | 5元  | 5元  | 100万Token |
| qwen-vl-ocr-2025-04-13 | 5元  | 5元  | 100万Token |
| qwen-vl-ocr-2024-10-28 | 5元  | 5元  | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- |
| qwen-vl-ocr > 当前能力等同于qwen-vl-ocr-2025-11-20 | 全球  | 0.3元 | 0.5元 |
| qwen-vl-ocr-2025-11-20 | 全球  | 0.3元 | 0.5元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- |
| qwen-vl-ocr > 当前能力等同于qwen-vl-ocr-2025-11-20 | 国际  | 0.514元 | 1.174元 |
| qwen-vl-ocr-2025-11-20 | 国际  | 0.514元 | 1.174元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- |
| qwen-vl-ocr > 当前能力等同于qwen-vl-ocr-2025-11-20 | 全球  | 0.3元 | 0.5元 |
| qwen-vl-ocr-2025-11-20 | 全球  | 0.3元 | 0.5元 |

### 千问Audio

计费规则：按输入Token和输出Token计费。

音频Token计算规则：每一秒钟的音频对应25个Token。若音频时长不足1秒，则按25个Token计算。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen-audio-turbo | 目前仅供免费体验。 > 免费额度用完后不可调用，推荐使用[全模态（Qwen-Omni）](/zh/model-studio/qwen-omni)作为替代模型 |   | 10万Token |
| qwen-audio-turbo-latest |

### 千问数学模型

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen-math-plus | 4元  | 12元 | 100万Token |
| qwen-math-turbo | 2元  | 6元  |

### 千问Coder

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[上下文缓存](/zh/model-studio/context-cache)，仅输入Token享有折扣。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| qwen3-coder-plus > 当前能力等同于qwen3-coder-plus-2025-09-23 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 0<Token≤32K | 4元  | 16元 | 100万Token |
| 32K<Token≤128K | 6元  | 24元 |
| 128K<Token≤256K | 10元 | 40元 |
| 256K<Token≤1M | 20元 | 200元 |
| qwen3-coder-plus-2025-09-23 | 0<Token≤32K | 4元  | 16元 | 100万Token |
| 32K<Token≤128K | 6元  | 24元 |
| 128K<Token≤256K | 10元 | 40元 |
| 256K<Token≤1M | 20元 | 200元 |
| qwen3-coder-plus-2025-07-22 | 0<Token≤32K | 4元  | 16元 | 100万Token |
| 32K<Token≤128K | 6元  | 24元 |
| 128K<Token≤256K | 10元 | 40元 |
| 256K<Token≤1M | 20元 | 200元 |
| qwen3-coder-flash > 当前能力等同于qwen3-coder-flash-2025-07-28 | 0<Token≤32K | 1元  | 4元  | 100万Token |
| 32K<Token≤128K | 1.5元 | 6元  |
| 128K<Token≤256K | 2.5元 | 10元 |
| 256K<Token≤1M | 5元  | 25元 |
| qwen3-coder-flash-2025-07-28 | 0<Token≤32K | 1元  | 4元  | 100万Token |
| 32K<Token≤128K | 1.5元 | 6元  |
| 128K<Token≤256K | 2.5元 | 10元 |
| 256K<Token≤1M | 5元  | 25元 |

##### 更多模型

| **模型 ID（Model ID）** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| qwen-coder-plus | 无阶梯计价 | 3.5元 | 7元  | 100万Token |
| qwen-coder-turbo | 无阶梯计价 | 2元  | 6元  | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token数** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- | --- |
| qwen3-coder-plus > 当前能力等同于qwen3-coder-plus-2025-09-23 | 全球  | 0<Token≤32K | 4元  | 16元 |
| 32K<Token≤128K | 6元  | 24元 |
| 128K<Token≤256K | 10元 | 40元 |
| 256K<Token≤1M | 20元 | 200元 |
| qwen3-coder-plus-2025-09-23 | 全球  | 0<Token≤32K | 4元  | 16元 |
| 32K<Token≤128K | 6元  | 24元 |
| 128K<Token≤256K | 10元 | 40元 |
| 256K<Token≤1M | 20元 | 200元 |
| qwen3-coder-plus-2025-07-22 | 全球  | 0<Token≤32K | 4元  | 16元 |
| 32K<Token≤128K | 6元  | 24元 |
| 128K<Token≤256K | 10元 | 40元 |
| 256K<Token≤1M | 20元 | 200元 |
| qwen3-coder-flash > 当前能力等同于qwen3-coder-flash-2025-07-28 | 全球  | 0<Token≤32K | 1元  | 4元  |
| 32K<Token≤128K | 1.5元 | 6元  |
| 128K<Token≤256K | 2.5元 | 10元 |
| 256K<Token≤1M | 5元  | 25元 |
| qwen3-coder-flash-2025-07-28 | 全球  | 0<Token≤32K | 1元  | 4元  |
| 32K<Token≤128K | 1.5元 | 6元  |
| 128K<Token≤256K | 2.5元 | 10元 |
| 256K<Token≤1M | 5元  | 25元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token数** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- | --- |
| qwen3-coder-plus > 当前能力等同于qwen3-coder-plus-2025-09-23 | 国际  | 0<Token≤32K | 7.339元 | 36.696元 |
| 32K<Token≤128K | 13.211元 | 66.053元 |
| 128K<Token≤256K | 22.018元 | 110.089元 |
| 256K<Token≤1M | 44.035元 | 440.354元 |
| qwen3-coder-plus-2025-09-23 | 国际  | 0<Token≤32K | 7.339元 | 36.696元 |
| 32K<Token≤128K | 13.211元 | 66.053元 |
| 128K<Token≤256K | 22.018元 | 110.089元 |
| 256K<Token≤1M | 44.035元 | 440.354元 |
| qwen3-coder-plus-2025-07-22 | 国际  | 0<Token≤32K | 7.339元 | 36.696元 |
| 32K<Token≤128K | 13.211元 | 66.053元 |
| 128K<Token≤256K | 22.018元 | 110.089元 |
| 256K<Token≤1M | 44.035元 | 440.354元 |
| qwen3-coder-flash > 当前能力等同于qwen3-coder-flash-2025-07-28 | 国际  | 0<Token≤32K | 2.202元 | 11.009元 |
| 32K<Token≤128K | 3.67元 | 18.348元 |
| 128K<Token≤256K | 5.871元 | 29.357元 |
| 256K<Token≤1M | 11.743元 | 70.457元 |
| qwen3-coder-flash-2025-07-28 | 国际  | 0<Token≤32K | 2.202元 | 11.009元 |
| 32K<Token≤128K | 3.67元 | 18.348元 |
| 128K<Token≤256K | 5.871元 | 29.357元 |
| 256K<Token≤1M | 11.743元 | 70.457元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token数** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- | --- |
| qwen3-coder-plus > 当前能力等同于qwen3-coder-plus-2025-09-23 | 全球  | 0<Token≤32K | 4元  | 16元 |
| 32K<Token≤128K | 6元  | 24元 |
| 128K<Token≤256K | 10元 | 40元 |
| 256K<Token≤1M | 20元 | 200元 |
| qwen3-coder-plus-2025-09-23 | 全球  | 0<Token≤32K | 4元  | 16元 |
| 32K<Token≤128K | 6元  | 24元 |
| 128K<Token≤256K | 10元 | 40元 |
| 256K<Token≤1M | 20元 | 200元 |
| qwen3-coder-plus-2025-07-22 | 全球  | 0<Token≤32K | 4元  | 16元 |
| 32K<Token≤128K | 6元  | 24元 |
| 128K<Token≤256K | 10元 | 40元 |
| 256K<Token≤1M | 20元 | 200元 |
| qwen3-coder-flash > 当前能力等同于qwen3-coder-flash-2025-07-28 | 全球  | 0<Token≤32K | 1元  | 4元  |
| 32K<Token≤128K | 1.5元 | 6元  |
| 128K<Token≤256K | 2.5元 | 10元 |
| 256K<Token≤1M | 5元  | 25元 |
| qwen3-coder-flash-2025-07-28 | 全球  | 0<Token≤32K | 1元  | 4元  |
| 32K<Token≤128K | 1.5元 | 6元  |
| 128K<Token≤256K | 2.5元 | 10元 |
| 256K<Token≤1M | 5元  | 25元 |

### 千问翻译模型

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen-mt-plus | 1.8元 | 5.4元 | 100万Token |
| qwen-mt-flash | 0.7元 | 1.95元 | 100万Token |
| qwen-mt-lite | 0.6元 | 1.6元 | 100万Token |
| qwen-mt-turbo | 0.7元 | 1.95元 | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- |
| qwen-mt-flash | 全球  | 0.7元 | 1.95元 |
| qwen-mt-lite | 全球  | 0.6元 | 1.6元 |
| qwen-mt-lite-us | 美国  | 0.881元 | 2.642元 |
| qwen-mt-plus | 全球  | 1.8元 | 5.4元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- |
| qwen-mt-plus | 国际  | 18.055元 | 54.09元 |
| qwen-mt-flash | 国际  | 1.174元 | 3.596元 |
| qwen-mt-lite | 国际  | 0.881元 | 2.642元 |
| qwen-mt-turbo | 国际  | 1.174元 | 3.596元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- |
| qwen-mt-plus | 全球  | 1.8元 | 5.4元 |
| qwen-mt-flash | 全球  | 0.7元 | 1.95元 |
| qwen-mt-lite | 全球  | 0.6元 | 1.6元 |

### 千问数据挖掘模型

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| qwen-doc-turbo | 0.6元 | 1元  | 无免费额度 |

### 千问深入研究模型

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| qwen-deep-research | 54元 | 163元 | 无免费额度 |
| qwen-deep-research-2025-12-15 | 79元 | 236元 | 无免费额度 |

### 通义晓蜜对话分析模型

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费；若模型支持[上下文缓存](/zh/model-studio/context-cache)，仅输入Token享有折扣。两者不能同时生效。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| tongyi-xiaomi-analysis-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 0.2元 | 0.4元 | 100万Token |
| tongyi-xiaomi-analysis-pro > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 1.0元 | 2.7元 | 100万Token |

## 文本生成-千问-开源版

### Qwen3.8

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-2.4t-a95b > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤1M | 12元 | 36元 | 100万Token |
| qwen3.8-27b > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 0<Token≤1M | 3元  | 12元 | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- | --- |
| qwen3.8-2.4t-a95b > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤1M | 14.988元 | 44.965元 |
| qwen3.8-27b > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 非思考和思考模式 | 0<Token≤1M | 3.646元 | 21.875元 |

### Qwen3.6

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.6-35b-a3b | 0<Token≤256K | 1.8元 | 10.8元 | 10.8元 | 100万Token |
| qwen3.6-27b | 0<Token≤256K | 3元  | 18元 | 18元 | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.6-35b-a3b | 全球  | 0<Token≤256K | 1.8元 | 10.8元 | 10.8元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.6-35b-a3b | 国际  | 0<Token≤256K | 2.810325元 | 16.86195元 | 16.86195元 |
| qwen3.6-27b | 国际  | 0<Token≤256K | 4.49652元 | 26.97912元 | 26.97912元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.6-35b-a3b | 全球  | 0<Token≤256K | 1.8元 | 10.8元 | 10.8元 |

### Qwen3.5

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-397b-a17b | 0<Token≤128K | 1.2元 | 7.2元 | 7.2元 | 100万Token |
| 128K<Token≤256K | 3元  | 18元 | 18元 |
| qwen3.5-122b-a10b | 0<Token≤128K | 0.8元 | 6.4元 | 6.4元 | 100万Token |
| 128K<Token≤256K | 2元  | 16元 | 16元 |
| qwen3.5-27b | 0<Token≤128K | 0.6元 | 4.8元 | 4.8元 | 100万Token |
| 128K<Token≤256K | 1.8元 | 14.4元 | 14.4元 |
| qwen3.5-35b-a3b | 0<Token≤128K | 0.4元 | 3.2元 | 3.2元 | 100万Token |
| 128K<Token≤256K | 1.6元 | 12.8元 | 12.8元 |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-397b-a17b | 全球  | 0<Token≤128K | 1.2元 | 7.2元 | 7.2元 |
| 128K<Token≤256K | 3元  | 18元 | 18元 |
| qwen3.5-122b-a10b | 全球  | 0<Token≤128K | 0.8元 | 6.4元 | 6.4元 |
| 128K<Token≤256K | 2元  | 16元 | 16元 |
| qwen3.5-27b | 全球  | 0<Token≤128K | 0.6元 | 4.8元 | 4.8元 |
| 128K<Token≤256K | 1.8元 | 14.4元 | 14.4元 |
| qwen3.5-35b-a3b | 全球  | 0<Token≤128K | 0.4元 | 3.2元 | 3.2元 |
| 128K<Token≤256K | 1.6元 | 12.8元 | 12.8元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-397b-a17b | 国际  | 0<Token≤256K | 4.404元 | 26.421元 | 26.421元 |
| qwen3.5-122b-a10b | 国际  | 0<Token≤256K | 2.936元 | 23.486元 | 23.486元 |
| qwen3.5-27b | 国际  | 0<Token≤256K | 2.202元 | 17.614元 | 17.614元 |
| qwen3.5-35b-a3b | 国际  | 0<Token≤256K | 1.835元 | 14.678元 | 14.678元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-397b-a17b | 全球  | 0<Token≤128K | 1.2元 | 7.2元 | 7.2元 |
| 128K<Token≤256K | 3元  | 18元 | 18元 |
| qwen3.5-122b-a10b | 全球  | 0<Token≤128K | 0.8元 | 6.4元 | 6.4元 |
| 128K<Token≤256K | 2元  | 16元 | 16元 |
| qwen3.5-27b | 全球  | 0<Token≤128K | 0.6元 | 4.8元 | 4.8元 |
| 128K<Token≤256K | 1.8元 | 14.4元 | 14.4元 |
| qwen3.5-35b-a3b | 全球  | 0<Token≤128K | 0.4元 | 3.2元 | 3.2元 |
| 128K<Token≤256K | 1.6元 | 12.8元 | 12.8元 |

### Qwen3

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3-next-80b-a3b-thinking | 仅思考模式 | 1元  | \\- | 10元 | 100万Token |
| qwen3-next-80b-a3b-instruct | 仅非思考模式 | 1元  | 4元  | \\- | 100万Token |
| qwen3-235b-a22b-thinking-2507 | 仅思考模式 | 2元  | \\- | 20元 | 100万Token |
| qwen3-235b-a22b-instruct-2507 | 仅非思考模式 | 2元  | 8元  | \\- | 100万Token |
| qwen3-30b-a3b-thinking-2507 | 仅思考模式 | 0.75元 | \\- | 7.5元 | 100万Token |
| qwen3-30b-a3b-instruct-2507 | 仅非思考模式 | 0.75元 | 3元  | \\- | 100万Token |
| qwen3-235b-a22b | 非思考和思考模式 | 2元  | 8元  | 20元 | 100万Token |
| qwen3-32b | 非思考和思考模式 | 2元  | 8元  | 20元 | 100万Token |
| qwen3-30b-a3b | 非思考和思考模式 | 0.75元 | 3元  | 7.5元 | 100万Token |
| qwen3-14b | 非思考和思考模式 | 1元  | 4元  | 10元 | 100万Token |
| qwen3-8b | 非思考和思考模式 | 0.5元 | 2元  | 5元  | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3-next-80b-a3b-thinking | 全球  | 仅思考模式 | 1元  | \\- | 10元 |
| qwen3-next-80b-a3b-instruct | 全球  | 仅非思考模式 | 1元  | 4元  | \\- |
| qwen3-235b-a22b-thinking-2507 | 全球  | 仅思考模式 | 1.688元 | \\- | 16.88元 |
| qwen3-235b-a22b-instruct-2507 | 全球  | 仅非思考模式 | 1.688元 | 6.752元 | \\- |
| qwen3-30b-a3b-thinking-2507 | 全球  | 仅思考模式 | 0.75元 | \\- | 7.5元 |
| qwen3-30b-a3b-instruct-2507 | 全球  | 仅非思考模式 | 0.75元 | 3元  | \\- |
| qwen3-235b-a22b | 全球  | 非思考和思考模式 | 2元  | 8元  | 20元 |
| qwen3-32b | 全球  | 非思考和思考模式 | 1.174元 | 4.697元 | 4.697元 |
| qwen3-30b-a3b | 全球  | 非思考和思考模式 | 0.75元 | 3元  | 7.5元 |
| qwen3-14b | 全球  | 非思考和思考模式 | 1元  | 4元  | 10元 |
| qwen3-8b | 全球  | 非思考和思考模式 | 0.5元 | 2元  | 5元  |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- | --- |
| qwen3-next-80b-a3b-thinking | 国际  | 仅思考模式 | 1.101元 | \\- | 8.807元 | 无免费额度 |
| qwen3-next-80b-a3b-instruct | 国际  | 仅非思考模式 | 1.101元 | 8.807元 | \\- | 无免费额度 |
| qwen3-235b-a22b-thinking-2507 | 国际  | 仅思考模式 | 1.688元 | \\- | 16.88元 | 无免费额度 |
| qwen3-235b-a22b-instruct-2507 | 国际  | 仅非思考模式 | 1.688元 | 6.752元 | \\- | 无免费额度 |
| qwen3-30b-a3b-thinking-2507 | 国际  | 仅思考模式 | 1.468元 | \\- | 17.614元 | 无免费额度 |
| qwen3-30b-a3b-instruct-2507 | 国际  | 仅非思考模式 | 1.468元 | 5.871元 | \\- | 无免费额度 |
| qwen3-235b-a22b | 国际  | 非思考和思考模式 | 5.137元 | 20.55元 | 61.65元 | 无免费额度 |
| qwen3-32b | 国际  | 非思考和思考模式 | 1.174元 | 4.697元 | 4.697元 | 无免费额度 |
| qwen3-30b-a3b | 国际  | 非思考和思考模式 | 1.468元 | 5.871元 | 17.614元 | 无免费额度 |
| qwen3-14b | 国际  | 非思考和思考模式 | 2.569元 | 10.275元 | 30.825元 | 无免费额度 |
| qwen3-8b | 国际  | 非思考和思考模式 | 1.321元 | 5.137元 | 15.412元 | 无免费额度 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **非思考模式** | **思考模式（思维链+回答）** |
| --- | --- | --- | --- | --- | --- |
| qwen3-next-80b-a3b-thinking | 全球  | 仅思考模式 | 1元  | \\- | 10元 |
| qwen3-next-80b-a3b-instruct | 全球  | 仅非思考模式 | 1元  | 4元  | \\- |
| qwen3-235b-a22b-thinking-2507 | 全球  | 仅思考模式 | 1.688元 | \\- | 16.88元 |
| qwen3-235b-a22b-instruct-2507 | 全球  | 仅非思考模式 | 1.688元 | 6.752元 | \\- |
| qwen3-30b-a3b-thinking-2507 | 全球  | 仅思考模式 | 0.75元 | \\- | 7.5元 |
| qwen3-30b-a3b-instruct-2507 | 全球  | 仅非思考模式 | 0.75元 | 3元  | \\- |
| qwen3-235b-a22b | 全球  | 非思考和思考模式 | 2元  | 8元  | 20元 |
| qwen3-32b | 全球  | 非思考和思考模式 | 1.174元 | 4.697元 | 4.697元 |
| qwen3-30b-a3b | 全球  | 非思考和思考模式 | 0.75元 | 3元  | 7.5元 |
| qwen3-14b | 全球  | 非思考和思考模式 | 1元  | 4元  | 10元 |
| qwen3-8b | 全球  | 非思考和思考模式 | 0.5元 | 2元  | 5元  |

### Qwen-Omni

计费规则：按输入Token和输出Token计费。不同模态的Token计算规则请参见[计费与限流](/zh/model-studio/qwen-omni#a9018938d3niq)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** |   |   | **输出单价（每百万Token）** |   |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **文本** | **音频** | **图片/视频** | **文本** > 仅纯文本输入 | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen2.5-omni-7b | 0.6元 | 38元 | 2元  | 2.4元 | 6元  | 76元 | 100万Token（不区分模态） |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** |   |   | **输出单价（每百万Token）** |   |   |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **文本** | **音频** | **图片/视频** | **文本** > 仅纯文本输入 | **文本** > 多模态输入 | **文本+音频** > 仅音频计费 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen2.5-omni-7b | 国际  | 0.734元 | 49.613元 | 2.055元 | 2.936元 | 6.165元 | 99.153元 |

### Qwen3-Omni-Captioner

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-omni-30b-a3b-captioner | 15.8元 | 12.7元 | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- |
| qwen3-omni-30b-a3b-captioner | 国际  | 27.962元 | 22.458元 |

### Qwen-VL

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| qwen3-vl-235b-a22b-thinking | 仅思考模式 | 2元  | 20元 | 100万 Token |
| qwen3-vl-235b-a22b-instruct | 仅非思考模式 | 2元  | 8元  | 100万 Token |
| qwen3-vl-32b-thinking | 仅思考模式 | 2元  | 20元 | 100万 Token |
| qwen3-vl-32b-instruct | 仅非思考模式 | 2元  | 8元  | 100万 Token |
| qwen3-vl-30b-a3b-thinking | 仅思考模式 | 0.75元 | 7.5元 | 100万 Token |
| qwen3-vl-30b-a3b-instruct | 仅非思考模式 | 0.75元 | 3元  | 100万 Token |
| qwen3-vl-8b-thinking | 仅思考模式 | 0.5元 | 5元  | 100万 Token |
| qwen3-vl-8b-instruct | 仅非思考模式 | 0.5元 | 2元  | 100万 Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- |
| qwen3-vl-235b-a22b-thinking | 全球  | 仅思考模式 | 2元  | 20元 |
| qwen3-vl-235b-a22b-instruct | 全球  | 仅非思考模式 | 2元  | 8元  |
| qwen3-vl-32b-thinking | 全球  | 仅思考模式 | 1.174元 | 4.697元 |
| qwen3-vl-32b-instruct | 全球  | 仅非思考模式 | 1.174元 | 4.697元 |
| qwen3-vl-30b-a3b-thinking | 全球  | 仅思考模式 | 0.75元 | 7.5元 |
| qwen3-vl-30b-a3b-instruct | 全球  | 仅非思考模式 | 0.75元 | 3元  |
| qwen3-vl-8b-thinking | 全球  | 仅思考模式 | 0.5元 | 5元  |
| qwen3-vl-8b-instruct | 全球  | 仅非思考模式 | 0.5元 | 2元  |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- |
| qwen3-vl-235b-a22b-thinking | 国际  | 仅思考模式 | 2.936元 | 29.357元 |
| qwen3-vl-235b-a22b-instruct | 国际  | 仅非思考模式 | 2.936元 | 11.743元 |
| qwen3-vl-32b-thinking | 国际  | 仅思考模式 | 1.174元 | 4.697元 |
| qwen3-vl-32b-instruct | 国际  | 仅非思考模式 | 1.174元 | 4.697元 |
| qwen3-vl-30b-a3b-thinking | 国际  | 仅思考模式 | 1.468元 | 17.614元 |
| qwen3-vl-30b-a3b-instruct | 国际  | 仅非思考模式 | 1.468元 | 5.871元 |
| qwen3-vl-8b-thinking | 国际  | 仅思考模式 | 1.321元 | 15.412元 |
| qwen3-vl-8b-instruct | 国际  | 仅非思考模式 | 1.321元 | 5.137元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- | --- |
| qwen3-vl-235b-a22b-thinking | 全球  | 仅思考模式 | 2元  | 20元 |
| qwen3-vl-235b-a22b-instruct | 全球  | 仅非思考模式 | 2元  | 8元  |
| qwen3-vl-32b-thinking | 全球  | 仅思考模式 | 1.174元 | 4.697元 |
| qwen3-vl-32b-instruct | 全球  | 仅非思考模式 | 1.174元 | 4.697元 |
| qwen3-vl-30b-a3b-thinking | 全球  | 仅思考模式 | 0.75元 | 7.5元 |
| qwen3-vl-30b-a3b-instruct | 全球  | 仅非思考模式 | 0.75元 | 3元  |
| qwen3-vl-8b-thinking | 全球  | 仅思考模式 | 0.5元 | 5元  |
| qwen3-vl-8b-instruct | 全球  | 仅非思考模式 | 0.5元 | 2元  |

### Qwen-Audio

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen2-audio-instruct | 目前仅供免费体验。 > 免费额度用完后不可调用，推荐使用[全模态（Qwen-Omni）](/zh/model-studio/qwen-omni)作为替代模型。 |   | 10万Token |
| qwen-audio-chat |

### Qwen-Coder

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| qwen3-coder-next | 0<Token≤32K | 1元  | 4元  | 100万Token |
| 32K<Token≤128K | 1.5元 | 6元  |
| 128K<Token≤256K | 2.5元 | 10元 |
| qwen3-coder-480b-a35b-instruct | 0<Token≤32K | 6元  | 24元 | 100万Token |
| 32K<Token≤128K | 9元  | 36元 |
| 128K<Token≤200K | 15元 | 60元 |
| qwen3-coder-30b-a3b-instruct | 0<Token≤32K | 1.5元 | 6元  | 100万Token |
| 32K<Token≤128K | 2.25元 | 9元  |
| 128K<Token≤200K | 3.75元 | 15元 |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- | --- |
| qwen3-coder-480b-a35b-instruct | 全球  | 0<Token≤32K | 6元  | 24元 |
| 32K<Token≤128K | 9元  | 36元 |
| 128K<Token≤200K | 15元 | 60元 |
| qwen3-coder-30b-a3b-instruct | 全球  | 0<Token≤32K | 1.5元 | 6元  |
| 32K<Token≤128K | 2.25元 | 9元  |
| 128K<Token≤200K | 3.75元 | 15元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- | --- |
| qwen3-coder-next | 国际  | 0<Token≤32K | 2.202元 | 11.009元 |
| 32K<Token≤128K | 3.67元 | 18.348元 |
| 128K<Token≤256K | 5.871元 | 29.357元 |
| qwen3-coder-480b-a35b-instruct | 国际  | 0<Token≤32K | 11.009元 | 55.044元 |
| 32K<Token≤128K | 19.816元 | 99.08元 |
| 128K<Token≤200K | 33.027元 | 165.133元 |
| qwen3-coder-30b-a3b-instruct | 国际  | 0<Token≤32K | 3.303元 | 16.513元 |
| 32K<Token≤128K | 5.504元 | 27.522元 |
| 128K<Token≤200K | 8.807元 | 44.035元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- | --- |
| qwen3-coder-30b-a3b-instruct | 全球  | 0<Token≤32K | 1.5元 | 6元  |
| 32K<Token≤128K | 2.25元 | 9元  |
| 128K<Token≤200K | 3.75元 | 15元 |
| qwen3-coder-480b-a35b-instruct | 全球  | 0<Token≤32K | 6元  | 24元 |
| 32K<Token≤128K | 9元  | 36元 |
| 128K<Token≤200K | 15元 | 60元 |
| qwen3-coder-next | 欧盟  | 0<Token≤32K | 2.248元 | 11.241元 |
| 32K<Token≤128K | 3.747元 | 18.736元 |
| 128K<Token≤256K | 5.995元 | 29.977元 |

## 文本生成-第三方模型

### DeepSeek

计费规则：按输入Token和输出Token计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

**说明**DeepSeek-V4-Flash-0731 已于 2026-08-17 00:00 起调整为峰谷定价模式，调整后单价可见下表，更多信息详见[DeepSeek-V4-Flash-0731 模型涨价通知](https://www.aliyun.com/notice/118555)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| deepseek-v4-pro > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 12元 | 24元 | 100万Token |
| deepseek-v4-pro-0813 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 忙时 9元 闲时 4.5元 | 忙时 27元 闲时 13.5元 | 100万Token |
| deepseek-v4-flash-0731 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 忙时 3元 闲时 1.5元 | 忙时 9元 闲时 4.5元 | 100万Token |
| deepseek-v4-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 1元  | 2元  | 100万Token |
| deepseek-v3.2 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 2元  | 3元  | 100万Token |
| deepseek-v3.2-exp | 2元  | 3元  | 100万Token |
| deepseek-v3.1 | 4元  | 12元 | 100万Token |
| deepseek-r1 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 4元  | 16元 | 100万Token |
| deepseek-r1-0528 | 4元  | 16元 | 100万Token |
| deepseek-v3 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 2元  | 8元  | 100万Token |
| deepseek-r1-distill-qwen-1.5b | 限时免费 |   |   |
| deepseek-r1-distill-qwen-7b | 0.5元 | 1元  | 100万Token |
| deepseek-r1-distill-qwen-14b | 1元  | 3元  | 100万Token |
| deepseek-r1-distill-qwen-32b | 2元  | 6元  | 100万Token |
| deepseek-r1-distill-llama-8b | 已下线 > 该模型已下线，推荐使用[深度思考](/zh/model-studio/deep-thinking)、[DeepSeek-阿里云](/zh/model-studio/deepseek-api)、[Kimi-阿里云](/zh/model-studio/kimi-api)作为替代模型。 |   |   |
| deepseek-r1-distill-llama-70b | 目前仅供免费体验 > 免费额度用完后不可调用，推荐使用[深度思考](/zh/model-studio/deep-thinking)、[DeepSeek-阿里云](/zh/model-studio/deepseek-api)、[Kimi-阿里云](/zh/model-studio/kimi-api)作为替代模型 |   | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- |
| deepseek-v4-pro > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 12元 | 24元 |
| deepseek-v4-pro-0813 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 忙时 9元 闲时 4.5元 | 忙时 27元 闲时 13.5元 |
| deepseek-v4-pro-us > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 17.986元 | 35.972元 |
| deepseek-v4-flash-0731 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 忙时 3元 闲时 1.5元 | 忙时 9元 闲时 4.5元 |
| deepseek-v4-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 1元  | 2元  |
| deepseek-v4-flash-us > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 1.499元 | 2.998元 |
| deepseek-v4-flash-0731-us > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 忙时 3.208元 闲时 1.604元 | 忙时 9.625元 闲时 4.813元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- |
| deepseek-v4-pro > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 17.986元 | 35.972元 |
| deepseek-v4-pro-0813 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 忙时 9.625元 闲时 4.813元 | 忙时 28.875元 闲时 14.438元 |
| deepseek-v4-flash-0731 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 忙时 3.208元 闲时 1.604元 | 忙时 9.625元 闲时 4.813元 |
| deepseek-v4-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 1.499元 | 2.998元 |
| deepseek-v3.2 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 国际  | 4.272元 | 12.815元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- |
| deepseek-v4-pro > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 12元 | 24元 |
| deepseek-v4-pro-0813 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 忙时 9元 闲时 4.5元 | 忙时 27元 闲时 13.5元 |
| deepseek-v4-flash-0731 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 忙时 3元 闲时 1.5元 | 忙时 9元 闲时 4.5元 |
| deepseek-v4-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 1元  | 2元  |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** |
| --- | --- | --- | --- |
| deepseek-v4-pro > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 12元 | 24元 |
| deepseek-v4-pro-0813 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 忙时 9元 闲时 4.5元 | 忙时 27元 闲时 13.5元 |
| deepseek-v4-flash-0731 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 忙时 3元 闲时 1.5元 | 忙时 9元 闲时 4.5元 |
| deepseek-v4-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 1元  | 2元  |
| deepseek-v4-pro > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 日本  | 17.986元 | 35.972元 |
| deepseek-v4-flash > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 日本  | 1.499元 | 2.998元 |
| deepseek-v4-flash-0731 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 日本  | 忙时 3.208元 闲时 1.604元 | 忙时 9.625元 闲时 4.813元 |

### DeepSeek-硅基流动

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** | **免费额度** |
| --- | --- | --- | --- |
| siliconflow/deepseek-v3.2 | 2元  | 3元  | 无   |
| siliconflow/deepseek-v3.1-terminus | 4元  | 12元 |
| siliconflow/deepseek-r1-0528 | 4元  | 16元 |
| siliconflow/deepseek-v3-0324 | 2元  | 8元  |

### DeepSeek-快手万擎

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链+回答** | **免费额度** |
| --- | --- | --- | --- |
| vanchin/deepseek-v3.2-think > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 2元  | 3元  | 无   |
| vanchin/deepseek-v3.1-terminus > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 4元  | 12元 |
| vanchin/deepseek-r1 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 4元  | 16元 |
| vanchin/deepseek-v3 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 2元  | 8元  |
| vanchin/deepseek-ocr | 0.216元 | 0.216元 |
| vanchin/deepseek-v4-pro > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 12元 | 24元 |
| vanchin/deepseek-v4-pro-0813 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 9元  | 27元 |

### Kimi

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| kimi-k3 | 仅思考模式 | 20元 | 100元 | 100万Token |
| kimi-k2.7-code | 仅思考模式 | 6.5元 | 27元 | 100万Token |
| kimi-k2.6 | 非思考和思考模式 | 6.5元 | 27元 | 100万Token |
| kimi-k2.5 | 非思考和思考模式 | 4元  | 21元 | 100万Token |
| kimi-k2-thinking | 仅思考模式 | 4元  | 16元 | 100万Token |
| Moonshot-Kimi-K2-Instruct | 非思考模式 | 4元  | 16元 | 100万Token |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- | --- |
| kimi-k3 | 全球  | 仅思考模式 | 20元 | 100元 |
| kimi-k3 | 国际  | 仅思考模式 | 21.875元 | 109.376元 |
| kimi-k2.7-code | 全球  | 仅思考模式 | 6.5元 | 27元 |
| kimi-k2.5 | 全球  | 非思考和思考模式 | 4元  | 21元 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- | --- |
| kimi-k3 | 全球  | 仅思考模式 | 20元 | 100元 |
| kimi-k2.7-code | 全球  | 仅思考模式 | 6.5元 | 27元 |
| kimi-k2.5 | 全球  | 非思考和思考模式 | 4元  | 21元 |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- | --- |
| kimi-k3 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 仅思考模式 | 20元 | 100元 |
| kimi-k2.7-code > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 仅思考模式 | 6.5元 | 27元 |
| kimi-k2.5 | 全球  | 非思考和思考模式 | 4元  | 21元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** |
| --- | --- | --- | --- | --- |
| kimi-k3 | 国际  | 仅思考模式 | 21.875元 | 109.376元 |
| kimi-k2.7-code | 国际  | 仅思考模式 | 7.119元 | 29.977元 |

### Kimi-月之暗面

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| kimi/kimi-k3 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 20元 | 100元 | 无   |
| kimi/kimi-k2.7-code-highspeed > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 13元 | 54元 |
| kimi/kimi-k2.7-code > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 6.5元 | 27元 |
| kimi/kimi-k2.6 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 6.5元 | 27元 |
| kimi/kimi-k2.5 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 4元  | 21元 |

### GLM

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| glm-5.2 | 非思考和思考模式 | 不区分阶梯 | 8元  | 28元 | 100万Token |
| glm-5.2-fast-preview | 非思考和思考模式 | 不区分阶梯 | 16元 | 56元 | 无   |
| glm-5.1 | 非思考和思考模式 | 0<Token≤32K | 6元  | 24元 | 100万Token |
| 32K<Token≤200K | 8元  | 28元 |
| glm-5 | 非思考和思考模式 | 0<Token≤32K | 4元  | 18元 | 100万Token |
| 32K<Token≤198K | 6元  | 22元 |
| glm-4.7 | 非思考和思考模式 | 0<Token≤32K | 3元  | 14元 | 100万Token |
| 32K<Token≤166K | 4元  | 16元 |
| glm-4.6 | 非思考和思考模式 | 0<Token≤32K | 3元  | 14元 | 100万Token |
| 32K<Token≤166K | 4元  | 16元 |
| glm-4.5 | 非思考和思考模式 | 0<Token≤32K | 3元  | 14元 | 100万Token |
| 32K<Token≤96K | 4元  | 16元 |
| glm-4.5-air | 非思考和思考模式 | 0<Token≤32K | 0.8元 | 6元  | 100万Token |
| 32K<Token≤96K | 1.2元 | 8元  |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** |
| --- | --- | --- | --- | --- | --- |
| glm-5.2 | 全球  | 非思考和思考模式 | 不区分阶梯 | 8元  | 28元 |
| glm-5.2-us | 国际  | 非思考和思考模式 | 不区分阶梯 | 10.492元 | 32.974元 |
| glm-5.1 | 全球  | 非思考和思考模式 | 0<Token≤32K | 6元  | 24元 |
| 32K<Token≤200K | 8元  | 28元 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- | --- |
| glm-5.2 | 国际  | 非思考和思考模式 | 不区分阶梯 | 10.492元 | 32.974元 | 100万Token |
| glm-5.2-fast-preview | 国际  | 非思考和思考模式 | 不区分阶梯 | 20.98元 | 65.95元 | 无   |
| glm-5.1 | 国际  | 非思考和思考模式 | 0<Token≤200K | 10.492元 | 32.974元 | 100万Token |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** |
| --- | --- | --- | --- | --- | --- |
| glm-5.2 | 全球  | 非思考和思考模式 | 不区分阶梯 | 8元  | 28元 |
| glm-5.1 | 全球  | 非思考和思考模式 | 0<Token≤32K | 6元  | 24元 |
| 32K<Token≤200K | 8元  | 28元 |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **模式** | **单次请求的输入Token数** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** |
| --- | --- | --- | --- | --- | --- |
| glm-5.1 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 全球  | 非思考和思考模式 | 0<Token≤32K | 6元  | 24元 |
| 32K<Token≤200K | 8元  | 28元 |

### GLM-智谱

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- | --- |
| ZHIPU/GLM-5.3 | 非思考和思考模式 | 8元  | 28元 | 无   |
| ZHIPU/GLM-5.2 | 非思考和思考模式 | 8元  | 28元 | 无   |
| ZHIPU/GLM-5.1 | 非思考和思考模式 | 8元  | 28元 | 无   |
| ZHIPU/GLM-5 | 非思考和思考模式 | 6元  | 22元 | 无   |

### MiniMax

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| MiniMax-M2.5 | 仅思考模式 | 2.1元 | 8.4元 | 100万Token |
| MiniMax-M2.1 | 仅思考模式 | 2.1元 | 8.4元 |

### MiniMax-稀宇科技

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **模式** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- | --- |
| MiniMax/MiniMax-M3 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 非思考和思考模式 | 4.2元 | 16.8元 | 无   |
| MiniMax/MiniMax-M2.7 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 仅思考模式 | 2.1元 | 8.4元 |
| MiniMax/MiniMax-M2.5 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 仅思考模式 | 2.1元 | 8.4元 |
| MiniMax/MiniMax-M2.1 > [上下文缓存](/zh/model-studio/context-cache)享有折扣 | 仅思考模式 | 2.1元 | 8.4元 |

### MiMo-小米

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入Token数量** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- | --- |
| xiaomi/mimo-v2.5-pro | 0<Token≤256K | 7元  | 21元 | 无   |
| 256K<Token≤1M | 14元 | 42元 |

### Stepfun-阶跃星辰

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| stepfun/step-3.7-flash | 1.35元 | 8.1元 | 无   |

### Unisound-云知声

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** > **思维链和回答** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| unisound/unisound-u2 | 1元  | 2元  | 无   |

## 图像生成

计费规则：按输入图像和成功生成的 **图像张数**计费。未说明输入图像价格的模型，输入不计费，仅输出计费。

计费公式：`费用 = 输入图像单价 × 输入的图像张数 + 输出图像单价 × 输出的图像张数`。

计费说明：请求失败不产生任何费用，也不消耗免费额度。

计费示例：部分图像生成失败

假设输入图像单价为0，输出图像单价为 0.10元/张。若您调用接口请求生成 4 张图像，但实际仅成功返回 3 张图像的 URL，另 1 张生成失败，系统将仅对成功生成的图像进行计费。

-   计费数量：3 张。
-   费用计算：0.1 × 3 = 0.3元。

### 千问图像生成与编辑

> 按输入输出的图像张数计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出图像分辨率** | **输入单价** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| qwen-image-3.0-pro | 1k  | 0.02元/张 | 0.25元/张 | 输入输出共10张 |
| 2k  | 0.5元/张 |
| qwen-image-3.0 | 1k  | 0.02元/张 | 0.18元/张 | 输入输出共10张 |
| 2k  | 0.18元/张 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出图像分辨率** | **输入单价** | **输出单价** |
| --- | --- | --- | --- | --- |
| qwen-image-3.0-pro | 国际  | 1k  | 0.022483元/张 | 0.299768元/张 |
| 2k  | 0.562065元/张 |
| qwen-image-3.0 | 国际  | 1k  | 0.022483元/张 | 0.224826元/张 |
| 2k  | 0.224826元/张 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出图像分辨率** | **输入单价** | **输出单价** |
| --- | --- | --- | --- | --- |
| qwen-image-3.0-pro | 全球  | 1k  | 0.02元/张 | 0.25元/张 |
| 2k  | 0.5元/张 |
| qwen-image-3.0 | 全球  | 1k  | 0.02元/张 | 0.18元/张 |
| 2k  | 0.18元/张 |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **输出图像分辨率** | **输入单价** | **输出单价** |
| --- | --- | --- | --- | --- |
| qwen-image-3.0-pro | 全球  | 1k  | 0.02元/张 | 0.25元/张 |
| 2k  | 0.5元/张 |
| qwen-image-3.0 | 全球  | 1k  | 0.02元/张 | 0.18元/张 |
| 2k  | 0.18元/张 |

### 千问文生图

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen-image-2.0-pro > 当前能力等同于qwen-image-2.0-pro-2026-04-22 | 0.5元/张 | 100张 |
| qwen-image-2.0-pro-2026-06-22 | 0.5元/张 | 100张 |
| qwen-image-2.0-pro-2026-04-22 | 0.5元/张 | 100张 |
| qwen-image-2.0-pro-2026-03-03 | 0.5元/张 | 100张 |
| qwen-image-2.0 > 当前能力等同于qwen-image-2.0-2026-03-03 | 0.2元/张 | 100张 |
| qwen-image-2.0-2026-03-03 | 0.2元/张 | 100张 |
| qwen-image-max > 当前能力等同于qwen-image-max-2025-12-30 | 0.5元/张 | 100张 |
| qwen-image-max-2025-12-30 | 0.5元/张 | 100张 |
| qwen-image-plus > 当前能力等同于qwen-image | 0.2元/张 | 100张 |
| qwen-image-plus-2026-01-09 | 0.2元/张 | 100张 |
| qwen-image | 0.25元/张 | 100张 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| qwen-image-2.0-pro > 当前能力等同于qwen-image-2.0-pro-2026-04-22 | 国际  | 0.550443元/张 |
| qwen-image-2.0-pro-2026-06-22 | 国际  | 0.550443元/张 |
| qwen-image-2.0-pro-2026-04-22 | 国际  | 0.550443元/张 |
| qwen-image-2.0-pro-2026-03-03 | 国际  | 0.550443元/张 |
| qwen-image-2.0 > 当前能力等同于qwen-image-2.0-2026-03-03 | 国际  | 0.256873元/张 |
| qwen-image-2.0-2026-03-03 | 国际  | 0.256873元/张 |
| qwen-image-max > 当前能力等同于qwen-image-max-2025-12-30 | 国际  | 0.550443元/张 |
| qwen-image-max-2025-12-30 | 国际  | 0.550443元/张 |
| qwen-image-plus > 当前能力等同于qwen-image | 国际  | 0.220177元/张 |
| qwen-image-plus-2026-01-09 | 国际  | 0.220177元/张 |
| qwen-image | 国际  | 0.256873元/张 |

### 千问图像编辑

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen-image-2.0-pro > 当前能力等同于qwen-image-2.0-pro-2026-04-22 | 0.5元/张 | 100张 |
| qwen-image-2.0-pro-2026-06-22 | 0.5元/张 | 100张 |
| qwen-image-2.0-pro-2026-04-22 | 0.5元/张 | 100张 |
| qwen-image-2.0-pro-2026-03-03 | 0.5元/张 | 100张 |
| qwen-image-2.0 > 当前能力等同于qwen-image-2.0-2026-03-03 | 0.2元/张 | 100张 |
| qwen-image-2.0-2026-03-03 | 0.2元/张 | 100张 |
| qwen-image-edit-max > 当前能力等同于qwen-image-edit-max-2026-01-16 | 0.5元/张 | 100张 |
| qwen-image-edit-max-2026-01-16 | 0.5元/张 | 100张 |
| qwen-image-edit-plus > 当前能力等同于qwen-image-edit-plus-2025-10-30 | 0.2元/张 | 100张 |
| qwen-image-edit-plus-2025-12-15 | 0.2元/张 | 100张 |
| qwen-image-edit-plus-2025-10-30 | 0.2元/张 | 100张 |
| qwen-image-edit | 0.3元/张 | 100张 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| qwen-image-2.0-pro > 当前能力等同于qwen-image-2.0-pro-2026-04-22 | 国际  | 0.550443元/张 |
| qwen-image-2.0-pro-2026-06-22 | 国际  | 0.550443元/张 |
| qwen-image-2.0-pro-2026-04-22 | 国际  | 0.550443元/张 |
| qwen-image-2.0-pro-2026-03-03 | 国际  | 0.550443元/张 |
| qwen-image-2.0 > 当前能力等同于qwen-image-2.0-2026-03-03 | 国际  | 0.256873元/张 |
| qwen-image-2.0-2026-03-03 | 国际  | 0.256873元/张 |
| qwen-image-edit-max > 当前能力等同于qwen-image-edit-max-2026-01-16 | 国际  | 0.550443元/张 |
| qwen-image-edit-max-2026-01-16 | 国际  | 0.550443元/张 |
| qwen-image-edit-plus > 当前能力等同于qwen-image-edit-plus-2025-10-30 | 国际  | 0.220177元/张 |
| qwen-image-edit-plus-2025-12-15 | 国际  | 0.220177元/张 |
| qwen-image-edit-plus-2025-10-30 | 国际  | 0.220177元/张 |
| qwen-image-edit | 国际  | 0.330266元/张 |

### 千问图像翻译

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen-mt-image-2.0 | 0.004元/张 | 100张 |
| qwen-mt-image | 0.003元/张 | 100张 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| qwen-mt-image-2.0 | 国际  | 0.004375元/张 |

### Z-Image

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| z-image-turbo | 关闭提示词改写（`prompt_extend=false`）：0.1元/张 开启提示词改写（`prompt_extend=true`）：0.2元/张 | 100张 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| z-image-turbo | 国际  | 关闭提示词改写（`prompt_extend=false`）：0.110089元/张 开启提示词改写（`prompt_extend=true`）：0.220177元/张 |

### 万相文生图

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wan2.6-t2i | 0.20元/张 | 50张 |
| wan2.5-t2i-preview | 0.20元/张 | 50张 |
| wan2.2-t2i-plus | 0.20元/张 | 100张 |
| wan2.2-t2i-flash | 0.14元/张 | 100张 |
| wanx2.1-t2i-plus | 0.20元/张 | 500张 |
| wanx2.1-t2i-turbo | 0.14元/张 | 500张 |
| wanx2.0-t2i-turbo | 0.04元/张 | 500张 |
| wanx-v1 | 0.16元/张 | 500张 |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| wan2.6-t2i | 全球  | 0.20元/张 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| wan2.6-t2i | 国际  | 0.220177元/张 |
| wan2.5-t2i-preview | 国际  | 0.220177元/张 |
| wan2.2-t2i-plus | 国际  | 0.366962元/张 |
| wan2.2-t2i-flash | 国际  | 0.183481元/张 |
| wan2.1-t2i-plus | 国际  | 0.366962元/张 |
| wan2.1-t2i-turbo | 国际  | 0.183481元/张 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| wan2.6-t2i | 全球  | 0.20元/张 |

### 万相图像生成与编辑

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wan2.7-image-pro | 0.50元/张 | 50张 |
| wan2.7-image | 0.20元/张 | 50张 |
| wan2.6-image | 0.20元/张 | 50张 |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| wan2.6-image | 全球  | 0.20元/张 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| wan2.7-image-pro | 国际  | 0.562065元/张 |
| wan2.7-image | 国际  | 0.224826元/张 |
| wan2.6-image | 国际  | 0.220177元/张 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| wan2.6-image | 全球  | 0.20元/张 |

### 万相通用图像编辑

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wan2.5-i2i-preview | 0.20元/张 | 50张 |
| wanx2.1-imageedit | 0.14元/张 | 500张 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出单价** |
| --- | --- | --- |
| wan2.5-i2i-preview | 国际  | 0.220177元/张 |

### 万相涂鸦作画

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wanx-sketch-to-image-lite | 0.06元/张 | 500张 |

### 万相图像局部重绘

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wanx-x-painting | 目前仅供免费体验。 > 免费额度用完后不可调用，推荐参考[图像编辑-千问](/zh/model-studio/qwen-image-edit-guide)或[图像编辑-万相2.1](/zh/model-studio/wanx-image-edit)获取替代方案。 | 500张 |

### 人像风格重绘

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wanx-style-repaint-v1 | 0.12元/张 | 500张 |

### 图像背景生成

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wanx-background-generation-v2 | 0.08元/张 | 500张 |

### 图像画面扩展

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| image-out-painting | 0.18元/张 | 500张 |

### 人物实例分割

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| image-instance-segmentation | 目前仅供免费体验。 > 免费额度用完后不可调用。 | 500张 |

### 图像擦除补全

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| image-erase-completion | 目前仅供免费体验。 > 免费额度用完后不可调用，推荐参考[图像编辑-千问](/zh/model-studio/qwen-image-edit-guide)或[图像编辑-万相2.1](/zh/model-studio/wanx-image-edit)获取替代方案。 | 500张 |

### 虚拟模特

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wanx-virtualmodel | 目前仅供免费体验。 > 免费额度用完后不可调用，推荐参考[图像编辑-千问](/zh/model-studio/qwen-image-edit-guide)或[图像编辑-万相2.1](/zh/model-studio/wanx-image-edit)获取替代方案。 | 各500张 |
| virtualmodel-v2 |

### 鞋靴模特

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| shoemodel-v1 | 目前仅供免费体验。 > 免费额度用完后不可调用。 | 500张 |

### 创意海报生成

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wanx-poster-generation-v1 | 目前仅供免费体验。 > 免费额度用完后不可调用，推荐参考[图像编辑-千问](/zh/model-studio/qwen-image-edit-guide)或[图像编辑-万相2.1](/zh/model-studio/wanx-image-edit)获取替代方案。 | 500张 |

### 人物写真生成-FaceChain

-   facechain-facedetect：限时免费。
-   facechain-finetune：按训练次数计费，请求失败不计费。
-   facechain-generation：输入不计费，输出计费。输出按成功生成的图片张数计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- |
| facechain-facedetect | 限时免费 | 限时免费 |
| facechain-finetune | 2.5元/次 | 50次 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| facechain-generation | 0.18元/张 | 500张 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |

### 创意文字生成-WordArt锦书

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wordart-texture | 0.08元/张 | 500张 |
| wordart-semantic | 0.24元/张 |

### AI试衣-OutfitAnyone

-   aitryon：输入不计费，输出计费。计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。
-   aitryon-plus：输入不计费，输出计费。计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。
-   aitryon-parsing-v1：输入计费，输出不计费。按输入的图像张数计费，请求失败不计费。
-   aitryon-refiner：输入不计费，输出计费。计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- |
| aitryon | 400张 |
| aitryon-plus | 400张 |
| aitryon-parsing-v1 | 400张 |
| aitryon-refiner | 100张 |

| **模型 ID（Model ID）** | **单价** | **折扣** | **阶梯层级** |
| --- | --- | --- | --- |
| aitryon | 0.20元/张 | 无   | 无   |
| aitryon-plus | 0.50元/张 | 无   | 无   |
| aitryon-parsing-v1 | 0.004元/张 | 无   | 无   |
| aitryon-refiner | 0.30元/张 | 无   | 生成数量 ≤ 25张 |
| 0.275元/张 | 9.2折 | 25张 ＜ 生成数量 ≤ 125张 |
| 0.25元/张 | 8.4折 | 125张 ＜ 生成数量 ≤ 250张 |
| 0.225元/张 | 7.5折 | 250张 ＜ 生成数量 ≤ 1250张 |
| 0.20元/张 | 6.7折 | 1250张 ＜ 生成数量 ≤ 2500张 |
| 0.175元/张 | 5.8折 | 2500张 ＜ 生成数量 ≤ 2.5万张 |
| 0.15元/张 | 5折  | 生成数量 ＞ 2.5万张 |

## 图像生成-第三方模型

### 可灵-图像生成

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出图像分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| kling/kling-v3-image-generation | 1K  | 0.2元/张 | 无免费额度 |
| 2K  | 0.2元/张 |
| kling/kling-v3-omni-image-generation | 1K  | 0.2元/张 |
| 2K  | 0.2元/张 |
| 4K  | 0.4元/张 |

### Vidu-图像生成

> 仅输出计费，计费规则请参见[图像生成](/zh/model-studio/model-pricing#26310bc5cf4do)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出图像分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| vidu/vidu-image\\_reference2image | 1K  | 0.625元/张 | 无免费额度 |
| 2K  | 1元/张 |
| 4K  | 1.46875元/张 |
| vidu/vidu-image-pro\\_reference2image | 1K  | 1.6875元/张 |
| 2K  | 3.1875元/张 |
| 4K  | 5.125元/张 |
| vidu/vidu-image-lite\\_reference2image | 1K  | 0.3125元/张 |
| 2K  | 0.34375元/张 |
| 4K  | 0.40625元/张 |
| vidu/viduq3-fast\\_reference2image | 1K  | 0.46875元/张 |
| 2K  | 0.78125元/张 |
| 4K  | 1.09375元/张 |
| vidu/viduq2-pro\\_reference2image | 1K  | 0.9375元/张 |
| 2K  | 0.9375元/张 |
| 4K  | 1.71875元/张 |
| vidu/viduq2-fast\\_reference2image | 1K  | 0.28125元/张 |

## 音乐生成

计费规则：按输出音频的秒数计费，输入不计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价（每秒）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| fun-music-preview | 0.005元 | 1,000秒 |
| fun-music-v1 | 0.002元 |

## 语音合成（文本转语音）

**字符计算规则**：本节中按字符数计费的模型（输入单价按「每万字符」计），其输入文本的字符数按以下规则统计：

-   一个汉字（包括简体汉字、繁体汉字、日文汉字和韩文汉字）计为 2 个字符。
-   其他字符（如一个英文字母、一个数字、一个标点符号、一个空格、一个日文假名、一个韩文字母）计为 1 个字符。
-   使用 SSML 时，SSML 标签本身不计入字符数，仅统计待合成的文本内容。

**示例**：“你好”为 4 个字符（2+2）；“中A文123”为 8 个字符（2+1+2+1+1+1）；“中文。”为 5 个字符（2+2+1）；“中 文。”为 6 个字符（2+1+2+1）。

### Qwen-Audio-TTS

计费规则：按输入文本的字符数计费，输出不计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen-audio-3.0-tts-plus | 1.4元 | 1万字符 |
| qwen-audio-3.0-tts-flash | 1元  | 1万字符 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| qwen-audio-3.0-tts-plus | 国际  | 1.49884元 |
| qwen-audio-3.0-tts-flash | 国际  | 1.12413元 |

### Qwen-TTS

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

#### 千问3-TTS-Instruct-Flash

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-tts-instruct-flash > 当前能力等同于qwen3-tts-instruct-flash-2026-01-26 | 0.8元 | 不计费 | 1万字符 |
| qwen3-tts-instruct-flash-2026-01-26 | 0.8元 | 不计费 | 1万字符 |

#### 千问3-TTS-VD

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-tts-vd-2026-01-26 | 0.8元 | 不计费 | 1万字符 |

#### 千问3-TTS-VC

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-tts-vc-2026-01-22 | 0.8元 | 不计费 | 1万字符 |

#### 千问3-TTS-Flash

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-tts-flash > 当前能力等同于qwen3-tts-flash-2025-11-27 | 0.8元 | 不计费 | 1万字符 |
| qwen3-tts-flash-2025-11-27 | 0.8元 | 不计费 | 1万字符 |
| qwen3-tts-flash-2025-09-18 | 0.8元 | 不计费 | 2025年11月13日0点后开通阿里云百炼：1万字符 |

#### 千问-TTS

计费规则：按输入Token和输出Token计费。

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen-tts-flash | 1.6元 | 10元 | 100万Token |
| qwen-tts-latest | 1.6元 | 10元 | 100万Token |
| qwen-tts-2025-05-22 | 1.6元 | 10元 | 100万Token |
| qwen-tts-2025-04-10 | 1.6元 | 10元 | 100万Token |

#### 新加坡

#### 千问3-TTS-Instruct-Flash

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| qwen3-tts-instruct-flash > 当前能力等同于qwen3-tts-instruct-flash-2026-01-26 | 国际  | 0.8元 |
| qwen3-tts-instruct-flash-2026-01-26 | 国际  | 0.8元 |

#### 千问3-TTS-VD

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| qwen3-tts-vd-2026-01-26 | 国际  | 0.8元 |

#### 千问3-TTS-VC

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| qwen3-tts-vc-2026-01-22 | 国际  | 0.8元 |

#### 千问3-TTS-Flash

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| qwen3-tts-flash > 当前能力等同于qwen3-tts-flash-2025-11-27 | 国际  | 0.733924元 |
| qwen3-tts-flash-2025-11-27 | 国际  | 0.733924元 |
| qwen3-tts-flash-2025-09-18 | 国际  | 0.733924元 |

### Qwen-TTS-Realtime

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

#### 千问3-TTS-Instruct-Flash-Realtime

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-tts-instruct-flash-realtime > 当前能力等同于qwen3-tts-instruct-flash-realtime-2026-01-22 | 1元  | 不计费 | 1万字符 |
| qwen3-tts-instruct-flash-realtime-2026-01-22 | 1元  | 不计费 | 1万字符 |

#### 千问3-TTS-VD-Realtime

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-tts-vd-realtime-2026-01-15 | 1元  | 不计费 | 1万字符 |
| qwen3-tts-vd-realtime-2025-12-16 | 1元  | 不计费 | 1万字符 |

#### 千问3-TTS-VC-Realtime

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-tts-vc-realtime-2026-01-15 | 1元  | 不计费 | 1万字符 |
| qwen3-tts-vc-realtime-2025-11-27 | 1万字符 |

#### 千问3-TTS-Flash-Realtime

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-tts-flash-realtime | 1元  | 不计费 | 2025年11月13日0点后开通阿里云百炼：1万字符 |
| qwen3-tts-flash-realtime-2025-11-27 | 1元  | 不计费 | 1万字符 |
| qwen3-tts-flash-realtime-2025-09-18 | 1元  | 不计费 | 2025年11月13日0点后开通阿里云百炼：1万字符 |

#### 千问-TTS-Realtime

计费规则：按输入Token和输出Token计费。

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen-tts-realtime | 2.4元 | 12元 | 100万Token |
| qwen-tts-realtime-latest | 2.4元 | 12元 | 100万Token |
| qwen-tts-realtime-2025-07-15 | 2.4元 | 12元 | 100万Token |

#### 新加坡

#### 千问3-TTS-Instruct-Flash-Realtime

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| qwen3-tts-instruct-flash-realtime > 当前能力等同于qwen3-tts-instruct-flash-realtime-2026-01-22 | 国际  | 1元  |
| qwen3-tts-instruct-flash-realtime-2026-01-22 | 国际  | 1元  |

#### 千问3-TTS-VD-Realtime

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| qwen3-tts-vd-realtime-2026-01-15 | 国际  | 0.954101元 |
| qwen3-tts-vd-realtime-2025-12-16 | 国际  | 0.954101元 |

#### 千问3-TTS-VC-Realtime

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| qwen3-tts-vc-realtime-2026-01-15 | 国际  | 0.954101元 |
| qwen3-tts-vc-realtime-2025-11-27 | 国际  |

#### 千问3-TTS-Flash-Realtime

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| qwen3-tts-flash-realtime > 当前能力等同于qwen3-tts-flash-realtime-2025-11-27 | 国际  | 0.954101元 |
| qwen3-tts-flash-realtime-2025-11-27 | 国际  | 0.954101元 |
| qwen3-tts-flash-realtime-2025-09-18 | 国际  | 0.954101元 |

### Qwen-TTS声音复刻

计费规则：按新建音色个数计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单价（每个音色）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen-voice-enrollment | 0.01元 | 1000个音色/账号 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **单价（每个音色）** |
| --- | --- | --- |
| qwen-voice-enrollment | 国际  | 0.01元 |

### Qwen-TTS声音设计

计费规则：按新建音色个数计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单价（每个音色）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen-voice-design | 0.2元 | 10个音色/账号 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **单价（每个音色）** |
| --- | --- | --- |
| qwen-voice-design | 国际  | 0.2元 |

### CosyVoice

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| cosyvoice-v3.5-plus | 1.5元 | 1万字符 |
| cosyvoice-v3.5-flash | 0.8元 | 1万字符 |
| cosyvoice-v3-plus | 2元  | 1万字符 |
| cosyvoice-v3-flash | 1元  | 1万字符 |
| cosyvoice-v2 | 2元  | 1万字符 |
| cosyvoice-v1 | 2元  | 1万字符 |

#### 新加坡

计费规则：按输入文本的字符数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每万字符）** |
| --- | --- | --- |
| cosyvoice-v3-plus | 国际  | 1.9082元 |
| cosyvoice-v3-flash | 国际  | 0.9541元 |

`CosyVoice` 模型目前仅提供按量付费模式，暂无单独的用量套餐或资源包。

### Sambert

计费规则：按输入文本的字符数计费，输出不计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每万字符）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- |
| 参见[模型列表](/zh/model-studio/sambert-java-sdk#57d33631f7doi) | 1元  | 每主账号每模型每月3万字符。 |

### MiniMax

计费规则：按输入文本的字符数计费，输出不计费。

复刻音色收取一次性费用，费用在首次使用该音色进行语音合成的时候，与语音合成的费用一同出账。

| **模型名称** | **语音合成单价（每万字符）** | [复刻一个音色](/zh/model-studio/mini-clone-api) | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| MiniMax/speech-2.8-hd | 3.5元 | 9.9元 （在首次使用复刻出来的音色进行语音合成的时候收取） | 无   |
| MiniMax/speech-02-hd | 3.5元 |
| MiniMax/speech-2.8-turbo | 2元  |
| MiniMax/speech-02-turbo | 2元  |

## 语音识别（语音转文本）与翻译（语音转成指定语种的文本）

### 千问-LiveTranslate-Flash-Realtime

计费规则：按输入Token和输出Token计费。不同模态的Token计算规则请参见[计费说明](/zh/model-studio/qwen3-5-livetranslate-flash-realtime#e02a82e668y2c)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** |   | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **输入：音频** | **输入：图片** | **输出：文本** | **输出：音频** |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-livetranslate-flash-realtime | 40元 | 3.3元 | 100元 | 160元 | 100万Token |
| qwen3.5-livetranslate-flash-realtime-2026-05-19 | 40元 | 3.3元 | 100元 | 160元 | 100万Token |
| qwen3-livetranslate-flash-realtime > 当前能力等同于qwen3-livetranslate-flash-realtime-2025-09-22 | 64元 | 8元  | 64元 | 240元 | 100万Token |
| qwen3-livetranslate-flash-realtime-2025-09-22 | 64元 | 8元  | 64元 | 240元 | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 (每百万 Token)** |   | **输出单价 (每百万 Token)** |   |
| --- | --- | --- | --- | --- | --- |
| **输入：音频** | **输入：图片** | **输出：文本** | **输出：音频** |
| --- | --- | --- | --- | --- | --- |
| qwen3.5-livetranslate-flash-realtime | 国际  | 56.207元 | 4.122元 | 149.884元 | 224.826元 |
| qwen3.5-livetranslate-flash-realtime-2026-05-19 | 国际  | 56.207元 | 4.122元 | 149.884元 | 224.826元 |
| qwen3-livetranslate-flash-realtime > 当前能力等同于qwen3-livetranslate-flash-realtime-2025-09-22 | 国际  | 73.392元 | 9.541元 | 73.392元 | 278.891元 |
| qwen3-livetranslate-flash-realtime-2025-09-22 | 国际  | 73.392元 | 9.541元 | 73.392元 | 278.891元 |

### 千问-LiveTranslate-Flash

计费规则：按输入Token和输出Token计费。不同模态的Token计算规则请参见[计费说明](/zh/model-studio/qwen3-livetranslate-flash#e02a82e668y2c)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** |   | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **输入：音频** | **输入：图片** | **输出：文本** | **输出：音频** |
| --- | --- | --- | --- | --- | --- |
| qwen3-livetranslate-flash | 10元 | 4元  | 10元 | 40元 | 100万Token |
| qwen3-livetranslate-flash-2025-12-01 | 10元 | 4元  | 10元 | 40元 | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 (每百万 Token)** |   | **输出单价 (每百万 Token)** |   |
| --- | --- | --- | --- | --- | --- |
| **输入：音频** | **输入：图片** | **输出：文本** | **输出：音频** |
| --- | --- | --- | --- | --- | --- |
| qwen3-livetranslate-flash | 国际  | 11.573元 | 4.629元 | 11.573元 | 46.292元 |
| qwen3-livetranslate-flash-2025-12-01 | 国际  | 11.573元 | 4.629元 | 11.573元 | 46.292元 |

### Qwen-Audio-3.0-ASR-Flash-Streaming

计费规则：按输入音频的秒数计费，输出不计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen-audio-3.0-asr-flash-streaming | 0.00033元/秒 | 36,000秒（10小时） |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价** |
| --- | --- | --- |
| qwen-audio-3.0-asr-flash-streaming | 国际  | 0.00066元/秒 |

### Qwen-Audio-3.0-ASR-Flash-Filetrans

计费规则：按输入音频的秒数计费，输出不计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen-audio-3.0-asr-flash-filetrans | 0.00022元/秒 | 36,000秒（10小时） |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价** |
| --- | --- | --- |
| qwen-audio-3.0-asr-flash-filetrans | 国际  | 0.00026元/秒 |

### Qwen-Audio-3.0-ASR-Flash

计费规则：按输入音频的秒数计费，输出不计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen-audio-3.0-asr-flash | 0.00022元/秒 | 36,000秒（10小时） |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价** |
| --- | --- | --- |
| qwen-audio-3.0-asr-flash | 国际  | 0.00026元/秒 |

### 千问ASR

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

计费规则：按输入音频的秒数计费，输出不计费。

| **模型 ID（Model ID）** | **输入单价** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen3-asr-flash-filetrans | 0.00022元/秒 | 不计费 | 36,000秒（10小时） |
| qwen3-asr-flash-filetrans-2025-11-17 | 36,000秒（10小时） |
| qwen3-asr-flash > 当前能力等同于qwen3-asr-flash-2025-09-08 | 36,000秒（10小时） |
| qwen3-asr-flash-2026-02-10 | 36,000秒（10小时） |
| qwen3-asr-flash-2025-09-08 | 36,000秒（10小时） |

#### 美国（弗吉尼亚）

计费规则：按输入音频的秒数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价** | **输出单价** |
| --- | --- | --- | --- |
| qwen3-asr-flash-us | 美国  | 0.000035元/秒 | 不计费 |
| qwen3-asr-flash-2025-09-08-us | 美国  | 0.000035元/秒 |

#### 新加坡

计费规则：按输入音频的秒数计费，输出不计费。

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价** | **输出单价** |
| --- | --- | --- | --- |
| qwen3-asr-flash-filetrans | 国际  | 0.00026元/秒 | 不计费 |
| qwen3-asr-flash-filetrans-2025-11-17 | 国际  | 0.00026元/秒 |
| qwen3-asr-flash > 当前能力等同于qwen3-asr-flash-2025-09-08 | 国际  | 0.00026元/秒 |
| qwen3-asr-flash-2026-02-10 | 国际  | 0.00026元/秒 |
| qwen3-asr-flash-2025-09-08 | 国际  | 0.00026元/秒 |

### 千问ASR-Realtime

计费规则：按输入音频的秒数计费，输出不计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen3-asr-flash-realtime > 当前能力等同于qwen3-asr-flash-realtime-2025-10-27 | 0.00033元/秒 | 36,000秒（10小时） |
| qwen3-asr-flash-realtime-2026-02-10 | 36,000秒（10小时） |
| qwen3-asr-flash-realtime-2025-10-27 | 36,000秒（10小时） |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价** |
| --- | --- | --- |
| qwen3-asr-flash-realtime > 当前能力等同于qwen3-asr-flash-realtime-2025-10-27 | 国际  | 0.00066元/秒 |
| qwen3-asr-flash-realtime-2026-02-10 | 国际  |
| qwen3-asr-flash-realtime-2025-10-27 | 国际  |

### Fun-ASR

#### 录音文件识别

计费规则：按输入音频的秒数计费，输出不计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| fun-asr > 当前能力等同于fun-asr-2025-11-07 | 0.00022元/秒 | 36,000秒（10小时） |
| fun-asr-2025-11-07 | 36,000秒（10小时） |
| fun-asr-2025-08-25 | 36,000秒（10小时） |
| fun-asr-mtl | 36,000秒（10小时） |
| fun-asr-mtl-2025-08-25 | 36,000秒（10小时） |
| fun-asr-flash-2026-06-15 | 0.00022元/秒 | 36,000秒（10小时） |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价** |
| --- | --- | --- |
| fun-asr > 当前能力等同于fun-asr-2025-11-07 | 国际  | 0.00026元/秒 |
| fun-asr-2025-11-07 | 国际  |
| fun-asr-2025-08-25 | 国际  |
| fun-asr-mtl | 国际  |
| fun-asr-mtl-2025-08-25 | 国际  |
| fun-asr-flash-2026-06-15 | 国际  | 0.00026元/秒 |

#### 实时语音识别

计费规则：按输入音频的秒数计费，输出不计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| fun-asr-realtime | 0.00033元/秒 | 36,000秒（10小时） |
| fun-asr-realtime-2026-02-28 | 36,000秒（10小时） |
| fun-asr-realtime-2025-11-07 | 36,000秒（10小时） |
| fun-asr-realtime-2025-09-15 | 36,000秒（10小时） |
| fun-asr-mtl-realtime | 36,000秒（10小时） |
| fun-asr-mtl-realtime-2025-12-10 | 36,000秒（10小时） |
| fun-asr-flash-8k-realtime > 当前能力等同于fun-asr-flash-8k-realtime-2026-01-28 | 0.00022元/秒 | 36,000秒（10小时） |
| fun-asr-flash-8k-realtime-2026-01-28 | 36,000秒（10小时） |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价** |
| --- | --- | --- |
| fun-asr-realtime | 国际  | 0.00066元/秒 |
| fun-asr-realtime-2025-11-07 | 国际  |

### Paraformer

#### 录音文件识别

计费规则：按输入音频的秒数计费，输出不计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- |
| paraformer-v2 | 0.00008元/秒 | 36,000秒（10小时） 每月1日0点自动发放 有效期1个月 |
| paraformer-8k-v2 |
| paraformer-v1 |
| paraformer-8k-v1 |
| paraformer-mtl-v1 |

#### 实时语音识别

计费规则：按输入音频的秒数计费，输出不计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- |
| paraformer-realtime-v2 | 0.00024元/秒 | 36,000秒（10小时） 每月1日0点自动发放 有效期1个月 |
| paraformer-realtime-v1 |
| paraformer-realtime-8k-v2 |
| paraformer-realtime-8k-v1 |

## 语音对话

### 实时语音对话

实时语音对话模型支持文本和音频的输入与输出，按输入 Token 和输出 Token 分别计费。音频 Token 按时长折算：`总 Token 数 = 音频时长（单位：秒）* 12.5`，不足 1 秒按 1 秒计算。

在多轮对话场景中，与文本大模型一致，模型会维护完整的对话上下文以保持连贯的对话能力。历史对话内容会作为后续轮次的输入处理和计费，因此每轮的输入 Token 数会随对话轮次增加而逐步增长。各类内容的具体计费方式如下：

-   **用户输入的音频和文本**：计入上下文，在后续每轮对话中作为输入计费。其中音频按音频 Token 计费，文本按文本 Token 计费。
-   **用户设置的 instructions**：按文本 Token 每轮计费一次。
-   **模型输出的文本**：按文本 Token 计入上下文，在后续每轮对话中作为输入计费。
-   **模型输出的音频**：按音频 Token 仅在输出时计费一次，不计入上下文。

> 随着对话轮次增加，上下文累积的 Token 数量会逐步增长。建议合理控制单次会话的对话轮数，或在适当时机开启新会话，以优化使用成本。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** |   | **输出单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- | --- |
| **文本** | **音频** | **文本** | **音频** |
| --- | --- | --- | --- | --- | --- |
| qwen-audio-3.0-realtime-plus | 5元  | 40元 | 40元 | 150元 | 100万Token |
| qwen-audio-3.0-realtime-flash | 3元  | 30元 | 30元 | 100元 | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** |   | **输出单价（每百万Token）** |   |
| --- | --- | --- | --- | --- | --- |
| **文本** | **音频** | **文本** | **音频** |
| --- | --- | --- | --- | --- | --- |
| qwen-audio-3.0-realtime-plus | 国际  | 5.995元 | 47.963元 | 47.963元 | 179.861元 |
| qwen-audio-3.0-realtime-flash | 国际  | 3.372元 | 33.724元 | 33.724元 | 112.413元 |

## 视频生成

计费规则：输入不计费，输出计费。输出按成功生成的 **视频秒数**计费。

计费公式：`费用 = 视频单价 × 输出的视频时长（单位：秒）`。

计费说明：

-   部分模型按**输出视频分辨率定价**。不同分辨率（480P/720P/1080P）的计费价格有差异。
-   部分模型按**输出视频模式定价**。不同视频模式（标准版/专业版）的计费价格有差异。
-   部分模型按**输出视频画幅定价**。不同视频画幅（1:1/3:4）的计费价格有差异。
-   部分模型采用**统一定价**，与分辨率、模式或画幅无关。
-   请求失败不产生任何费用，也不会消耗免费额度。

### HappyHorse-文生视频

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| happyhorse-1.1-t2v | 480P | 原价0.45元/秒**（限时6折）** | 10秒 |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |
| happyhorse-1.0-t2v | 720P | 原价0.9元/秒**（限时8折）** | 10秒 |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-t2v | 全球  | 480P | 原价0.45元/秒**（限时6折）** |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |
| happyhorse-1.0-t2v | 全球  | 720P | 原价0.9元/秒**（限时8折）** |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-t2v | 国际  | 480P | 原价0.524594元/秒**（限时6折）** |
| 720P | 原价1.049188元/秒**（限时6折）** |
| 1080P | 原价1.348956元/秒**（限时6折）** |
| happyhorse-1.0-t2v | 国际  | 720P | 原价1.049188元/秒**（限时8折）** |
| 1080P | 原价1.798608元/秒**（限时8折）** |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-t2v | 全球  | 480P | 原价0.45元/秒**（限时6折）** |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |
| happyhorse-1.0-t2v | 全球  | 720P | 原价0.9元/秒**（限时8折）** |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-t2v | 全球  | 480P | 原价0.45元/秒**（限时6折）** |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |

### HappyHorse-图生视频-基于首帧

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| happyhorse-1.1-i2v | 480P | 原价0.45元/秒**（限时6折）** | 10秒 |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |
| happyhorse-1.0-i2v | 720P | 原价0.9元/秒**（限时8折）** | 10秒 |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-i2v | 全球  | 480P | 原价0.45元/秒**（限时6折）** |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |
| happyhorse-1.0-i2v | 全球  | 720P | 原价0.9元/秒**（限时8折）** |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-i2v | 国际  | 480P | 原价0.524594元/秒**（限时6折）** |
| 720P | 原价1.049188元/秒**（限时6折）** |
| 1080P | 原价1.348956元/秒**（限时6折）** |
| happyhorse-1.0-i2v | 国际  | 720P | 原价1.049188元/秒**（限时8折）** |
| 1080P | 原价1.798608元/秒**（限时8折）** |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-i2v | 全球  | 480P | 原价0.45元/秒**（限时6折）** |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |
| happyhorse-1.0-i2v | 全球  | 720P | 原价0.9元/秒**（限时8折）** |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-i2v | 全球  | 480P | 原价0.45元/秒**（限时6折）** |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |

### HappyHorse-参考生视频

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| happyhorse-1.1-r2v | 480P | 原价0.45元/秒**（限时6折）** | 10秒 |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |
| happyhorse-1.0-r2v | 720P | 原价0.9元/秒**（限时8折）** | 10秒 |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-r2v | 全球  | 480P | 原价0.45元/秒**（限时6折）** |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |
| happyhorse-1.0-r2v | 全球  | 720P | 原价0.9元/秒**（限时8折）** |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-r2v | 国际  | 480P | 原价0.524594元/秒**（限时6折）** |
| 720P | 原价1.049188元/秒**（限时6折）** |
| 1080P | 原价1.348956元/秒**（限时6折）** |
| happyhorse-1.0-r2v | 国际  | 720P | 原价1.049188元/秒**（限时8折）** |
| 1080P | 原价1.798608元/秒**（限时8折）** |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-r2v | 全球  | 480P | 原价0.45元/秒**（限时6折）** |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |
| happyhorse-1.0-r2v | 全球  | 720P | 原价0.9元/秒**（限时8折）** |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.1-r2v | 全球  | 480P | 原价0.45元/秒**（限时6折）** |
| 720P | 原价0.9元/秒**（限时6折）** |
| 1080P | 原价1.2元/秒**（限时6折）** |

### HappyHorse-视频编辑

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

计费规则：输入视频和输出视频均计费，按**视频秒数**计费，失败不计费也不占用免费额度。

| **模型 ID（Model ID）** | **输出视频分辨率** | **输入和输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| happyhorse-1.0-video-edit | 720P | 原价0.9元/秒**（限时8折）** | 10秒 |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 美国（弗吉尼亚）

计费规则：输入视频和输出视频均计费，按**视频秒数**计费，失败不计费也不占用免费额度。

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.0-video-edit | 全球  | 720P | 原价0.9元/秒**（限时8折）** |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 新加坡

计费规则：输入视频和输出视频均计费，按**视频秒数**计费，失败不计费也不占用免费额度。

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.0-video-edit | 国际  | 720P | 原价1.049188元/秒**（限时8折）** |
| 1080P | 原价1.798608元/秒**（限时8折）** |

#### 德国（法兰克福）

计费规则：输入视频和输出视频均计费，按**视频秒数**计费，失败不计费也不占用免费额度。

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.0-video-edit | 全球  | 720P | 原价0.9元/秒**（限时8折）** |
| 1080P | 原价1.6元/秒**（限时8折）** |

#### 日本（东京）

计费规则：输入视频和输出视频均计费，按**视频秒数**计费，失败不计费也不占用免费额度。

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- |
| happyhorse-1.0-video-edit | 全球  | 720P | 原价0.9元/秒**（限时8折）** |
| 1080P | 原价1.6元/秒**（限时8折）** |

### 万相3.0-视频生成

计费规则：输入视频和输出视频均计费，按**视频秒数**计费，失败不计费也不占用免费额度。

计费公式：计费时长 = 输入视频时长 + 输出视频时长。

-   输入视频的计费时长为**实际输入的视频秒数**。
-   输出视频的计费时长为**成功生成的视频秒数**。
-   免费额度为输入视频时长与输出视频时长合计 **30 秒**。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输入和输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| wan3.0-video-prime | 480P | 0.45元/秒 | 30秒 |
| 720P | 0.9元/秒 |
| 1080P | 1.8元/秒 |
| wan3.0-video | 480P | 原价0.3元/秒**（限时7折）** | 30秒 |
| 720P | 原价0.6元/秒**（限时7折）** |
| 1080P | 原价1.2元/秒**（限时7折）** |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- |
| wan3.0-video-prime | 国际  | 480P | 0.495838元/秒 |
| 720P | 1.020844元/秒 |
| 1080P | 2.041687元/秒 |
| wan3.0-video | 国际  | 480P | 原价0.37471元/秒**（限时7折）** |
| 720P | 原价0.74942元/秒**（限时7折）** |
| 1080P | 原价1.49884元/秒**（限时7折）** |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- |
| wan3.0-video-prime | 全球  | 480P | 0.45元/秒 |
| 720P | 0.9元/秒 |
| 1080P | 1.8元/秒 |
| wan3.0-video | 全球  | 480P | 原价0.3元/秒**（限时7折）** |
| 720P | 原价0.6元/秒**（限时7折）** |
| 1080P | 原价1.2元/秒**（限时7折）** |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- |
| wan3.0-video-prime | 全球  | 480P | 0.45元/秒 |
| 720P | 0.9元/秒 |
| 1080P | 1.8元/秒 |
| wan3.0-video | 全球  | 480P | 原价0.3元/秒**（限时7折）** |
| 720P | 原价0.6元/秒**（限时7折）** |
| 1080P | 原价1.2元/秒**（限时7折）** |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- |
| wan3.0-video-prime | 全球  | 480P | 0.45元/秒 |
| 720P | 0.9元/秒 |
| 1080P | 1.8元/秒 |
| wan3.0-video | 全球  | 480P | 原价0.3元/秒**（限时7折）** |
| 720P | 原价0.6元/秒**（限时7折）** |
| 1080P | 原价1.2元/秒**（限时7折）** |

### 万相-文生视频

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| wan2.7-t2v-2026-06-12 | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |
| wan2.7-t2v-2026-04-25 | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |
| wan2.7-t2v | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |
| wan2.6-t2v | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |
| wan2.5-t2v-preview | 480P | 0.3元/秒 | 50秒 |
| 720P | 0.6元/秒 |
| 1080P | 1元/秒 |
| wan2.2-t2v-plus | 480P | 0.14元/秒 | 50秒 |
| 1080P | 0.70元/秒 |
| wanx2.1-t2v-turbo | 480P | 0.24元/秒 | 200秒 |
| 720P | 0.24元/秒 |
| wanx2.1-t2v-plus | 720P | 0.70元/秒 | 200秒 |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| wan2.6-t2v | 全球  | 720P | 0.6元/秒 |
| 1080P | 1元/秒 |
| wan2.6-t2v-us | 美国  | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| wan2.7-t2v-2026-06-12 | 国际  | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |
| wan2.7-t2v-2026-04-25 | 国际  | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |
| wan2.7-t2v | 国际  | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |
| wan2.6-t2v | 国际  | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |
| wan2.5-t2v-preview | 国际  | 480P | 0.366961元/秒 |
| 720P | 0.733923元/秒 |
| 1080P | 1.100885元/秒 |
| wan2.2-t2v-plus | 国际  | 480P | 0.146785元/秒 |
| 1080P | 0.733924元/秒 |
| wan2.1-t2v-turbo | 国际  | 480P | 0.264213元/秒 |
| 720P | 0.264213元/秒 |
| wan2.1-t2v-plus | 国际  | 720P | 0.733924元/秒 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| wan2.6-t2v | 全球  | 720P | 0.6元/秒 |
| 1080P | 1元/秒 |

### 万相-图生视频

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频类型** | **输出视频分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| wan2.7-i2v-2026-04-25 | 有声视频 | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |
| wan2.7-i2v | 有声视频 | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频类型** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- | --- |
| wan2.7-i2v-2026-04-25 | 国际  | 有声视频 | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |
| wan2.7-i2v | 国际  | 有声视频 | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |

### 万相-图生视频-基于首帧

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频类型** | **输出视频分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| wan2.6-i2v-flash | 有声视频 `audio=true` | 720P | 0.3元/秒 | 50秒 |
| 1080P | 0.5元/秒 |
| 无声视频 `audio=false` | 720P | 0.15元/秒 |
| 1080P | 0.25元/秒 |
| wan2.6-i2v | 有声视频 | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |
| wan2.5-i2v-preview | 有声视频 | 480P | 0.3元/秒 | 50秒 |
| 720P | 0.6元/秒 |
| 1080P | 1元/秒 |
| wan2.2-i2v-flash | 无声视频 | 480P | 0.10元/秒 | 50秒 |
| 720P | 0.20元/秒 |
| 1080P | 0.48元/秒 |
| wan2.2-i2v-plus | 无声视频 | 480P | 0.14元/秒 | 50秒 |
| 1080P | 0.70元/秒 |
| wanx2.1-i2v-turbo | 无声视频 | 480P | 0.24元/秒 | 200秒 |
| 720P | 0.24元/秒 |
| wanx2.1-i2v-plus | 无声视频 | 720P | 0.70元/秒 | 200秒 |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频类型** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- | --- |
| wan2.6-i2v | 全球  | 有声视频 | 720P | 0.6元/秒 |
| 1080P | 1元/秒 |
| wan2.6-i2v-us | 美国  | 有声视频 | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频类型** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- | --- |
| wan2.6-i2v-flash | 国际  | 有声视频 `audio=true` | 720P | 0.366962元/秒 |
| 1080P | 0.550443元/秒 |
| 无声视频 `audio=false` | 720P | 0.183481元/秒 |
| 1080P | 0.275221元/秒 |
| wan2.6-i2v | 国际  | 有声视频 | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |
| wan2.5-i2v-preview | 国际  | 有声视频 | 480P | 0.366961元/秒 |
| 720P | 0.733923元/秒 |
| 1080P | 1.100885元/秒 |
| wan2.2-i2v-flash | 国际  | 无声视频 | 480P | 0.110089元/秒 |
| 720P | 0.264213元/秒 |
| wan2.2-i2v-plus | 国际  | 无声视频 | 480P | 0.146785元/秒 |
| 1080P | 0.733924元/秒 |
| wan2.1-i2v-turbo | 国际  | 无声视频 | 480P | 0.264213元/秒 |
| 720P | 0.264213元/秒 |
| wan2.1-i2v-plus | 国际  | 无声视频 | 720P | 0.733924元/秒 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频类型** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- | --- |
| wan2.6-i2v | 全球  | 有声视频 | 720P | 0.6元/秒 |
| 1080P | 1元/秒 |

### 万相-图生视频-基于首尾帧

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| wan2.2-kf2v-flash | 480P | 0.10元/秒 | 50秒 |
| 720P | 0.20元/秒 |
| 1080P | 0.48元/秒 |
| wanx2.1-kf2v-plus | 720P | 0.70元/秒 | 200秒 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| wan2.1-kf2v-plus | 国际  | 720P | 0.733924元/秒 |

### 万相-参考生视频

计费规则：输入视频和输出视频均计费，按**视频秒数**计费，失败不计费也不占用免费额度。

计费公式：计费时长 = 输入视频时长（上限 5 秒）+ 输出视频时长。

-   输入视频的计费时长不超过 **5 秒**，计算规则参见[计费与限流](/zh/model-studio/video-to-video-guide#6f5774ce5fqie)。
-   输出视频的计费时长为**成功生成的视频秒数**。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频类型** | **输出视频分辨率** | **输入和输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- | --- |
| wan2.7-r2v-2026-06-12 | 有声视频 | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |
| wan2.7-r2v | 有声视频 | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |
| wan2.6-r2v-flash | 有声视频 `audio=true` | 720P | 0.3元/秒 | 50秒 |
| 1080P | 0.5元/秒 |
| 无声视频 `audio=false` | 720P | 0.15元/秒 |
| 1080P | 0.25元/秒 |
| wan2.6-r2v | 有声视频 | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频类型** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- | --- |
| wan2.6-r2v | 全球  | 有声视频 | 720P | 0.6元/秒 |
| 1080P | 1元/秒 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频类型** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- | --- |
| wan2.7-r2v-2026-06-12 | 国际  | 有声视频 | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |
| wan2.7-r2v | 国际  | 有声视频 | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |
| wan2.6-r2v-flash | 国际  | 有声视频 `audio=true` | 720P | 0.366962元/秒 |
| 1080P | 0.550443元/秒 |
| 无声视频 `audio=false` | 720P | 0.183481元/秒 |
| 1080P | 0.275221元/秒 |
| wan2.6-r2v | 国际  | 有声视频 | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频类型** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- | --- |
| wan2.6-r2v | 全球  | 有声视频 | 720P | 0.6元/秒 |
| 1080P | 1元/秒 |

### 万相-视频编辑

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

计费规则：输入视频和输出视频均计费，按**视频秒数**计费，失败不计费也不占用免费额度。

| **模型 ID（Model ID）** | **输出视频分辨率** | **输入和输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| wan2.7-videoedit | 720P | 0.6元/秒 | 50秒 |
| 1080P | 1元/秒 |

计费规则：输入不计费，输出视频计费，按**视频秒数**计费，失败不计费也不占用免费额度。

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| wanx2.1-vace-plus | 720P | 0.70元/秒 | 50秒 |

#### 新加坡

计费规则：输入视频和输出视频均计费，按**视频秒数**计费，失败不计费也不占用免费额度。

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输入和输出单价** |
| --- | --- | --- | --- |
| wan2.7-videoedit | 国际  | 720P | 0.733924元/秒 |
| 1080P | 1.100886元/秒 |

计费规则：输入不计费，输出视频计费，按**视频秒数**计费，失败不计费也不占用免费额度。

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频分辨率** | **输出单价** |
| --- | --- | --- | --- |
| wan2.1-vace-plus | 国际  | 720P | 0.733924元/秒 |

### 万相-数字人

-   wan2.2-s2v-detect：输入计费，输出不计费。输入按检测的图像张数计费，只要请求成功（无论检测结果通过与否），每张输入图像均计费一次。
-   wan2.2-s2v：输入不计费，输出计费。输出按成功生成的视频秒数计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| wan2.2-s2v-detect | 输入图像：0.004元/张 | 200张 |
| wan2.2-s2v | 输出视频： - 480P：0.5元/秒 - 720P：0.9元/秒 | 100秒 |

### 万相-图生动作

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频模式** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| wan2.2-animate-move | 标准模式`wan-std` | 0.4元/秒 | 50秒 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| 专业模式`wan-pro` | 0.6元/秒 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频模式** | **输出单价** |
| --- | --- | --- | --- |
| wan2.2-animate-move | 国际  | 标准模式`wan-std` | 0.880709元/秒 |
| 专业模式`wan-pro` | 1.321063元/秒 |

### 万相-视频换人

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频模式** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| wan2.2-animate-mix | 标准模式`wan-std` | 0.6元/秒 | 50秒 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| 专业模式`wan-pro` | 0.9元/秒 |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输出视频模式** | **输出单价** |
| --- | --- | --- | --- |
| wan2.2-animate-mix | 国际  | 标准模式`wan-std` | 1.321063元/秒 |
| 专业模式`wan-pro` | 1.908202元/秒 |

### 舞动人像AnimateAnyone

-   animate-anyone-detect-gen2：输入计费，输出不计费。输入按检测的图像张数计费，只要请求成功（无论检测结果通过与否），每张输入图像均计费一次。
-   animate-anyone-template-gen2：输入不计费，输出计费。输出按成功生成的视频秒数计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。
-   animate-anyone-gen2：输入不计费，输出计费。输出按成功生成的视频秒数计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| animate-anyone-detect-gen2 | 输入图像：0.004元/张 | 200张 |
| animate-anyone-template-gen2 | 输出视频：0.08元/秒 | 1800秒（30分钟） |
| animate-anyone-gen2 | 输出视频：0.08元/秒 | 1800秒（30分钟） |

### 悦动人像EMO

-   emo-detect-v1：输入计费，输出不计费。输入按检测的图像张数计费，只要请求成功（无论检测结果通过与否），每张输入图像均计费一次。
-   emo-v1：输入不计费，输出计费。输出按成功生成的视频秒数计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| emo-detect-v1 | 输入图像：0.004元/张 | 200张 |
| emo-v1 | 输出视频： - 1:1画幅视频：0.08元/秒 - 3:4画幅视频：0.16元/秒 | 1800秒（30分钟） |

### 灵动人像LivePortrait

-   liveportrait-detect：输入计费，输出不计费。输入按检测的图像张数计费，只要请求成功（无论检测结果通过与否），每张输入图像均计费一次。
-   liveportrait：输入不计费，输出计费。输出按成功生成的视频秒数计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| liveportrait-detect | 输入图像：0.004元/张 | 200张 |
| liveportrait | 输出视频：0.02元/秒 | 1800秒（30分钟） |

### 表情包Emoji

-   emoji-detect-v1：输入计费，输出不计费。输入按检测的图像张数计费，只要请求成功（无论检测结果通过与否），每张输入图像均计费一次。
-   emoji-v1：输入不计费，输出计费。输出按成功生成的视频秒数计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| emoji-detect-v1 | 输入图像：0.004元/张 | 200张 |
| emoji-v1 | 输出视频：0.08元/秒 | 1800秒（30分钟） |

### 声动人像VideoRetalk

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| videoretalk | 0.08元/秒 | 1800秒（30分钟） |

### 视频风格重绘

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| video-style-transform | 540P | 0.2元/秒 | 600秒 |
| 720P | 0.5元/秒 |

## 视频生成-第三方模型

### 爱诗-文生视频

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频类型** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- | --- |
| pixverse/pixverse-c1-t2v | 有声视频 `audio=true` | 360P | 0.24元/秒 | 无免费额度 |
| 540P | 0.3元/秒 |
| 720P | 0.39元/秒 |
| 1080P | 0.71元/秒 |
| 无声视频 `audio=false` | 360P | 0.18元/秒 |
| 540P | 0.24元/秒 |
| 720P | 0.3元/秒 |
| 1080P | 0.56元/秒 |
| pixverse/pixverse-v6-t2v | 有声视频 `audio=true` | 360P | 0.21元/秒 | 无免费额度 |
| 540P | 0.27元/秒 |
| 720P | 0.36元/秒 |
| 1080P | 0.68元/秒 |
| 无声视频 `audio=false` | 360P | 0.15元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.53元/秒 |
| pixverse/pixverse-v5.6-t2v | 有声视频 `audio=true` | 360P | 0.47元/秒 | 无免费额度 |
| 540P | 0.47元/秒 |
| 720P | 0.53元/秒 |
| 1080P | 0.7元/秒 |
| 无声视频 `audio=false` | 360P | 0.21元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.44元/秒 |
| pixverse/pixverse-v5.6-it2v | 有声视频 `audio=true` | 360P | 0.47元/秒 | 无免费额度 |
| 540P | 0.47元/秒 |
| 720P | 0.53元/秒 |
| 1080P | 0.7元/秒 |
| 无声视频 `audio=false` | 360P | 0.21元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.44元/秒 |

### 爱诗-图生视频-基于首帧

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频类型** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- | --- |
| pixverse/pixverse-c1-it2v | 有声视频 `audio=true` | 360P | 0.24元/秒 | 无免费额度 |
| 540P | 0.3元/秒 |
| 720P | 0.39元/秒 |
| 1080P | 0.71元/秒 |
| 无声视频 `audio=false` | 360P | 0.18元/秒 |
| 540P | 0.24元/秒 |
| 720P | 0.3元/秒 |
| 1080P | 0.56元/秒 |
| pixverse/pixverse-v6-it2v | 有声视频 `audio=true` | 360P | 0.21元/秒 | 无免费额度 |
| 540P | 0.27元/秒 |
| 720P | 0.36元/秒 |
| 1080P | 0.68元/秒 |
| 无声视频 `audio=false` | 360P | 0.15元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.53元/秒 |
| pixverse/pixverse-v5.6-it2v | 有声视频 `audio=true` | 360P | 0.47元/秒 | 无免费额度 |
| 540P | 0.47元/秒 |
| 720P | 0.53元/秒 |
| 1080P | 0.7元/秒 |
| 无声视频 `audio=false` | 360P | 0.21元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.44元/秒 |

### 爱诗-图生视频-基于首尾帧

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频类型** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- | --- |
| pixverse/pixverse-c1-kf2v | 有声视频 `audio=true` | 360P | 0.24元/秒 | 无免费额度 |
| 540P | 0.3元/秒 |
| 720P | 0.39元/秒 |
| 1080P | 0.71元/秒 |
| 无声视频 `audio=false` | 360P | 0.18元/秒 |
| 540P | 0.24元/秒 |
| 720P | 0.3元/秒 |
| 1080P | 0.56元/秒 |
| pixverse/pixverse-v6-kf2v | 有声视频 `audio=true` | 360P | 0.21元/秒 | 无免费额度 |
| 540P | 0.27元/秒 |
| 720P | 0.36元/秒 |
| 1080P | 0.68元/秒 |
| 无声视频 `audio=false` | 360P | 0.15元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.53元/秒 |
| pixverse/pixverse-v5.6-kf2v | 有声视频 `audio=true` | 360P | 0.47元/秒 | 无免费额度 |
| 540P | 0.47元/秒 |
| 720P | 0.53元/秒 |
| 1080P | 0.7元/秒 |
| 无声视频 `audio=false` | 360P | 0.21元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.44元/秒 |

### 爱诗-参考生视频

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入参考类型** | **输出视频类型** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- | --- | --- |
| pixverse/pixverse-v6-r2v-omni | 有参考视频 | 有声视频 `audio=true` | 360P | 0.42元/秒 | 无免费额度 |
| 540P | 0.54元/秒 |
| 720P | 0.72元/秒 |
| 1080P | 1.36元/秒 |
| 无声视频 `audio=false` | 360P | 0.3元/秒 |
| 540P | 0.42元/秒 |
| 720P | 0.54元/秒 |
| 1080P | 1.06元/秒 |
| 无参考视频 | 有声视频 `audio=true` | 360P | 0.21元/秒 |
| 540P | 0.27元/秒 |
| 720P | 0.36元/秒 |
| 1080P | 0.68元/秒 |
| 无声视频 `audio=false` | 360P | 0.15元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.53元/秒 |

| **模型 ID（Model ID）** | **输出视频类型** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- | --- |
| pixverse/pixverse-v6-r2v | 有声视频 `audio=true` | 360P | 0.21元/秒 | 无免费额度 |
| 540P | 0.27元/秒 |
| 720P | 0.36元/秒 |
| 1080P | 0.68元/秒 |
| 无声视频 `audio=false` | 360P | 0.15元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.53元/秒 |
| pixverse/pixverse-c1-r2v | 有声视频 `audio=true` | 360P | 0.24元/秒 | 无免费额度 |
| 540P | 0.3元/秒 |
| 720P | 0.39元/秒 |
| 1080P | 0.71元/秒 |
| 无声视频 `audio=false` | 360P | 0.18元/秒 |
| 540P | 0.24元/秒 |
| 720P | 0.3元/秒 |
| 1080P | 0.56元/秒 |
| pixverse/pixverse-v5.6-r2v | 有声视频 `audio=true` | 360P | 0.47元/秒 | 无免费额度 |
| 540P | 0.47元/秒 |
| 720P | 0.53元/秒 |
| 1080P | 0.7元/秒 |
| 无声视频 `audio=false` | 360P | 0.21元/秒 |
| 540P | 0.21元/秒 |
| 720P | 0.27元/秒 |
| 1080P | 0.44元/秒 |

### 爱诗-视频对口型

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- |
| pixverse/pixverse-lipsync | 0.12元/秒 | 无免费额度 |

### 爱诗-视频动作模仿

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| pixverse/pixverse-motioncontrol | 360P | 0.27元/秒 | 无免费额度 |
| 540P | 0.30元/秒 |
| 720P | 0.36元/秒 |

### 爱诗-视频超清

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- |
| pixverse/pixverse-upscale | 0.15元/秒 | 无免费额度 |

### 可灵-视频生成

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频类型** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- | --- |
| kling/kling-v3-turbo-video-generation | 有声视频 | 720P | 0.8元/秒 | 无免费额度 |
| 1080P | 1.0元/秒 |
| kling/kling-v3-video-generation | 无声视频 | 720P | 0.6元/秒 | 无免费额度 |
| 1080P | 0.8元/秒 |
| 4K  | 3.0元/秒 |
| 有声视频 | 720P | 0.9元/秒 |
| 1080P | 1.2元/秒 |
| 4K  | 3.0元/秒 |
| kling/kling-v3-omni-video-generation | 无声视频（无参考视频） | 720P | 0.6元/秒 | 无免费额度 |
| 1080P | 0.8元/秒 |
| 4K  | 3.0元/秒 |
| 无声视频（有参考视频） | 720P | 0.9元/秒 |
| 1080P | 1.2元/秒 |
| 4K  | 3.0元/秒 |
| 有声视频（无参考视频） | 720P | 0.9元/秒 |
| 1080P | 1.2元/秒 |
| 4K  | 3.0元/秒 |

### Vidu-文生视频

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| vidu/viduq3-pro\\_text2video | 540P | 0.3125元/秒 | 无免费额度 |
| 720P | 0.78125元/秒 |
| 1080P | 0.9375元/秒 |
| vidu/viduq3-turbo\\_text2video | 540P | 0.25元/秒 | 无免费额度 |
| 720P | 0.375元/秒 |
| 1080P | 0.4375元/秒 |
| vidu/viduq2\\_text2video | 540P | 0.1125元/秒 | 无免费额度 |
| 720P | 0.21875元/秒 |
| 1080P | 0.375元/秒 |

### Vidu-图生视频-基于首帧

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| vidu/viduq3-pro-fast\\_img2video | 720P | 0.375元/秒 | 无免费额度 |
| 1080P | 0.46875元/秒 |
| vidu/viduq3-pro\\_img2video | 540P | 0.3125元/秒 | 无免费额度 |
| 720P | 0.78125元/秒 |
| 1080P | 0.9375元/秒 |
| vidu/viduq3-turbo\\_img2video | 540P | 0.25元/秒 | 无免费额度 |
| 720P | 0.375元/秒 |
| 1080P | 0.4375元/秒 |
| vidu/viduq2-pro\\_img2video | 540P | 0.15625元/秒 | 无免费额度 |
| 720P | 0.34375元/秒 |
| 1080P | 0.71875元/秒 |
| vidu/viduq2-turbo\\_img2video | 540P | 0.0875元/秒 | 无免费额度 |
| 720P | 0.25元/秒 |
| 1080P | 0.46875元/秒 |
| vidu/viduq2-pro-fast\\_img2video | 720P | 0.1元/秒 | 无免费额度 |
| 1080P | 0.2元/秒 |

### Vidu-图生视频-基于首尾帧

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| vidu/viduq3-pro\\_start-end2video | 540P | 0.3125元/秒 | 无免费额度 |
| 720P | 0.78125元/秒 |
| 1080P | 0.9375元/秒 |
| vidu/viduq3-turbo\\_start-end2video | 540P | 0.25元/秒 | 无免费额度 |
| 720P | 0.375元/秒 |
| 1080P | 0.4375元/秒 |
| vidu/viduq2-pro\\_start-end2video | 540P | 0.15625元/秒 | 无免费额度 |
| 720P | 0.34375元/秒 |
| 1080P | 0.71875元/秒 |
| vidu/viduq2-turbo\\_start-end2video | 540P | 0.0875元/秒 | 无免费额度 |
| 720P | 0.25元/秒 |
| 1080P | 0.46875元/秒 |

### Vidu-参考生视频

> 仅输出计费，计费规则请参见[视频生成](/zh/model-studio/model-pricing#d809366847gza)。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输出单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| vidu/viduq3-ad\\_reference2video | 720P | 0.75元/秒 | 无免费额度 |
| 1080P | 0.90625元/秒 |
| vidu/viduq3-drama\\_reference2video | 720P | 0.875元/秒 | 无免费额度 |
| 1080P | 0.875元/秒 |
| vidu/viduq3-mix\\_reference2video | 720P | 0.78125元/秒 | 无免费额度 |
| 1080P | 0.9375元/秒 |
| vidu/viduq3\\_reference2video | 540P | 0.3125元/秒 | 无免费额度 |
| 720P | 0.625元/秒 |
| 1080P | 0.78125元/秒 |
| vidu/viduq3-turbo\\_reference2video | 540P | 0.15625元/秒 | 无免费额度 |
| 720P | 0.3125元/秒 |
| 1080P | 0.40625元/秒 |
| vidu/viduq2-pro\\_reference2video | 540P | 0.25元/秒 | 无免费额度 |
| 720P | 0.3125元/秒 |
| 1080P | 0.78125元/秒 |
| vidu/viduq2\\_reference2video | 540P | 0.21875元/秒 | 无免费额度 |
| 720P | 0.28125元/秒 |
| 1080P | 0.71875元/秒 |

### MiniMax-视频生成

计费规则：输入计费，按图像张数和视频秒数计费；输出计费，按成功生成的视频秒数计费。

其中，`计费视频秒数=输入视频秒数+输出视频秒数`，价格由输出视频分辨率决定。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输出视频分辨率** | **输入和输出视频单价** | **免费额度**[**（注）**](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| MiniMax/MiniMax-H3 | 2K  | 0.80元/秒 | 无免费额度 |
| 768P | 0.50元/秒 |

**输入素材价格**

| **模型 ID（Model ID）** | **输入素材类型** | **输入价格** |
| --- | --- | --- |
| MiniMax/MiniMax-H3 | 音频  | 免费  |
| 图片  | 5张以内免费，超出部分 0.20 元/张 |
| 视频  | 价格由输出视频分辨率决定，见上方表格 |

## 3D模型生成-第三方模型

**Tripo-3D模型生成**

计费规则：输入不计费，输出按次数计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **3D任务类型** | **输出规格** | **输出单价** |
| --- | --- | --- | --- |
| Tripo/Tripo-H3.1 | 文生3D | 标准版+无贴图 | 0.7元/次 |
| 标准版+带标清贴图 | 1.4元/次 |
| 标准版+带高清贴图 | 2.1元/次 |
| 超清版+无贴图 | 2.1元/次 |
| 超清版+带标清贴图 | 2.8元/次 |
| 超清版+带高清贴图 | 3.5元/次 |
| 单图生3D/多图生3D | 标准版+无贴图 | 1.4元/次 |
| 标准版+带标清贴图 | 2.1元/次 |
| 标准版+带高清贴图 | 2.8元/次 |
| 超清版+无贴图 | 2.8元/次 |
| 超清版+带标清贴图 | 3.5元/次 |
| 超清版+带高清贴图 | 4.2元/次 |
| Tripo/Tripo-P1.0 | 文生3D | 无贴图 | 2.1元/次 |
| 带标清贴图 | 2.8元/次 |
| 带高清贴图 | 3.5元/次 |
| 单图生3D/多图生3D | 无贴图 | 2.8元/次 |
| 带标清贴图 | 3.5元/次 |
| 带高清贴图 | 4.2元/次 |

## 文本向量

计费规则：按输入Token计费，输出不计费。

影响计费的因素：若模型支持[Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)，其输入和输出Token单价均按实时推理价格的50%计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen3.7-text-embedding | 0.5元 | 100万Token |
| text-embedding-v4 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 0.5元 | 100万Token |
| text-embedding-v3 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 > 免费额度用完后不可调用，推荐使用 text-embedding-v4 作为替代模型，免费额度提升至 100 万 Token | 0.5元 | 50万Token |
| text-embedding-v2 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 0.7元 | 50万Token |
| text-embedding-v1 > [Batch调用](/zh/model-studio/batch-interfaces-compatible-with-openai)半价 | 0.7元 | 50万Token |
| text-embedding-async-v2 | 0.7元 | 2000万Token |
| text-embedding-async-v1 | 0.7元 | 2000万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** |
| --- | --- | --- |
| qwen3.7-text-embedding | 国际  | 0.525元 |
| text-embedding-v4 | 国际  | 0.514元 |
| text-embedding-v3 | 国际  | 0.514元 |

## 多模态向量

计费规则：按输入Token计费，输出不计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** |   | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| **文本** | **图片/视频** |
| --- | --- | --- | --- |
| qwen3-vl-embedding | 0.7元 | 1.8元 | 100万Token |
| qwen2.5-vl-embedding | 100万Token |
| tongyi-embedding-vision-plus | 0.5元 | 0.5元 | 100万Token |
| tongyi-embedding-vision-flash | 0.15元 | 0.15元 | 100万Token |
| multimodal-embedding-v1 | 0.7元 | 0.9元 | 100万Token |

## 排序模型

### 文本排序模型

计费规则：按输入Token计费，输出不计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- |
| qwen3-vl-rerank | 文本输入：0.7元 图片输入：1.8元 | 100万Token |
| qwen3-rerank | 文本输入：0.5元 | 100万Token |
| gte-rerank-v2 | 文本输入：0.8元 | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价（每百万Token）** |
| --- | --- | --- |
| qwen3-rerank | 国际  | 0.74942元 |

## 行业模型

### 通义法睿

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) |
| --- | --- | --- | --- |
| farui-plus | 20元 | 20元 | 无免费额度 |

### 意图理解

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| tongyi-intent-detect-v3 | 0.4元 | 1元  | 100万Token |

### 角色扮演

计费规则：按输入Token和输出Token计费。

**说明**以下模型仅在华北2（北京）地域下有免费额度，其他地域均无免费额度。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| qwen-plus-character > [Session Cache](/zh/model-studio/role-play#6034f997cde74)享有折扣 | 0.8元 | 2元  | 100万Token |
| qwen-flash-character > [Session Cache](/zh/model-studio/role-play#6034f997cde74)享有折扣 | 0.25元 | 1.5元 | 100万Token |
| qwen-flash-character-2026-02-26 > [Session Cache](/zh/model-studio/role-play#6034f997cde74)享有折扣 | 0.18元 | 1.5元 | 100万Token |

#### 新加坡

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- |
| qwen-plus-character > [Session Cache](/zh/model-studio/role-play#6034f997cde74)享有折扣 | 国际  | 3.747元 | 10.492元 |
| qwen-flash-character > [Session Cache](/zh/model-studio/role-play#6034f997cde74)享有折扣 | 国际  | 0.375元 | 2.998元 |
| qwen-plus-character-ja | 国际  | 3.67元 | 10.275元 |

#### 美国（弗吉尼亚）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- |
| qwen-plus-character | 全球  | 0.8元 | 2元  |

#### 德国（法兰克福）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- |
| qwen-plus-character | 全球  | 0.8元 | 2元  |

#### 日本（东京）

| **模型 ID（Model ID）** | **服务部署范围** | **输入单价 （每百万Token）** | **输出单价 （每百万Token）** |
| --- | --- | --- | --- |
| qwen-plus-character | 全球  | 0.8元 | 2元  |

### 界面交互

计费规则：按输入Token和输出Token计费。

#### 华北2（北京）

| **模型 ID（Model ID）** | **输入单价（每百万Token）** | **输出单价（每百万Token）** | **免费额度**[（注）](/zh/model-studio/new-free-quota#977b13081ab56) 有效期：自开通百炼/模型发布/申请通过之日起90天内（以较晚者为准） |
| --- | --- | --- | --- |
| gui-plus | 1.5元 | 4.5元 | 100万Token |
| gui-plus-2026-02-26 |

## Token 消耗与成本控制

**通过 URL 读取文件的计费方式**：通过 URL 读取文件时，文件传输过程本身不消耗 Token；文件内容解析后转化为输入 Token 计费，消耗量取决于解析后的文本长度，而不是文件大小。如果需要处理大文件，建议使用知识库切片索引以降低 Token 消耗。

**单次请求 Credits 消耗异常高时如何排查**：常见原因包括输入 Token 量过大、启用 Agent 模式（会产生大量 system prompt、工具定义及思考内容开销）等。可通过以下方式优化成本：压缩历史消息、新开对话、关闭思考模式，或切换至轻量模型（如 Flash 系列）。

**低频调用场景的模型推荐**：针对心跳检测等低频调用场景，推荐使用 Qwen Flash 系列等低价模型，以降低整体调用成本。

**已下线模型说明**：Qwen2.5 系列等已下线模型不再可用，也无法查询价格，请使用新版模型替代。

## 错误码

如果模型调用失败并返回报错信息，请参见[错误码](/zh/model-studio/error-code)进行解决。
