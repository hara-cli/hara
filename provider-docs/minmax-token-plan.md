> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Token Plan 概要

> Token Plan 的订阅和使用概要

<img src="https://filecdn.minimax.chat/public/token-plan-hero-v5.jpg" alt="Token Plan" style={{ display: "block", margin: "0 auto", maxWidth: "100%", borderRadius: "12px" }} />

## 欢迎使用 Token Plan！

MiniMax 在语言、视频、语音和图像等方向研发模型。[Token Plan](https://platform.minimaxi.com/subscribe/token-plan) 通过订阅 Key 提供套餐内 Token Plan 用量额度，覆盖语言模型之外的更多资源。

## 核心优势

<CardGroup cols={3}>
  <Card title="全模态覆盖" icon="layers">
    一个订阅通过统一的用量进度条覆盖可用的 MiniMax 资源。
  </Card>

  <Card title="面向 Agent 工作流" icon="zap">
    套餐面向长上下文 Agent、编程和多模态工作流设计。
  </Card>

  <Card title="极具性价比" icon="piggy-bank">
    固定订阅费提供更广的资源覆盖，并让用量规则更清晰。
  </Card>
</CardGroup>

## 订阅 Key

每位用户在所属的每个团队中都有一把专属的 **订阅 Key**。这把 Key 可以在团队尚未购买 Token Plan 席位或积分时就存在。如果用户当前没有可用资源，这把 Key 暂时没有可用的付费资源。当用户被分配 Token Plan 席位，或获得积分使用权限后，同一把订阅 Key 即可使用这些资源。

订阅和积分规则请参考 [Token Plan 定价](/docs/guides/pricing-token-plan)。团队版请参考 [Token Plan 团队版](/docs/guides/pricing-token-plan-team)。

## 用量额度

[Token Plan](https://platform.minimaxi.com/subscribe/token-plan) 的用量额度在控制台以用量进度条展示。对于已有按量计费价格的 API 端点，用量会按对应按量计费价格扣减套餐内 Token Plan 额度。

|              | **Plus**     | **Max**           | **Ultra**           |
| :----------- | :----------- | :---------------- | :------------------ |
| **价格**       | **¥49 /月**   | **¥119 /月**       | **¥469 /月**         |
| **适合场景**     | 轻量个人开发与日常试用  | 高频编程 Agent 与多模态调用 | 重度 Agent 工作流与更长时间使用 |
| **额度窗口**     | 5 小时固定窗口和周窗口 | 5 小时固定窗口和周窗口      | 5 小时固定窗口和周窗口        |
| **Agent 用量** | 3-4 个 Agent  | 4-5 个 Agent       | 6-7 个 Agent         |

<div style={{ fontSize: "11px", color: "#6b7280", lineHeight: 1.35, marginTop: "-16px", marginBottom: "12px" }}>可用模型覆盖 MiniMax 全系模型（M3 / M2.7 / 图像 / 语音），少量特殊模型（MiniMax H3、音色设计、快速复刻等）暂不支持。</div>

<Tip>
  如需通过订阅 Key 调用支持的多模态资源，请参考 [MiniMax CLI 指南](/docs/token-plan/minimax-cli)。
</Tip>

## 快速指南

<Steps>
  <Step title="订阅或获得资源分配">
    访问 [Token Plan](https://platform.minimaxi.com/subscribe/token-plan) 订阅页面，在默认团队中购买个人订阅或积分；也可以加入团队，并使用团队分配的 Token Plan 席位或共享积分。
  </Step>

  <Step title="获取订阅 Key">
    前往 [账户管理 / Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) 页面，查看您的可用资源并获取 **订阅 Key**。
  </Step>
</Steps>

<Info>
  **重要提示**

  * 订阅 Key 用于 Token Plan 订阅套餐和已购积分。
  * 订阅 Key 与按量计费 API Key 不可互换。
  * 订阅 Key 可以在付费资源可用之前就存在；当用户拥有 Token Plan 席位或积分权限后才可实际使用资源。
  * 请妥善保管您的 API Key，防止资源损失。
</Info>

## 在 AI Agent 与编程工具中使用

挑选你常用的工具，按对应教程接入：

<CardGroup cols={3}>
  <Card title="OpenClaw" icon="bot" href="/docs/token-plan/openclaw" />

  <Card title="Claude Code" icon="terminal" href="/docs/token-plan/claude-code" />

  <Card title="Cursor" icon="square-code" href="/docs/token-plan/cursor" />

  <Card title="TRAE" icon="code" href="/docs/token-plan/trae" />

  <Card title="Hermes Agent" icon="sparkles" href="/docs/token-plan/hermes-agent" />
</CardGroup>

其他工具的接入方式见 [其他工具](/docs/token-plan/other-tools)。

## 达到用量上限后

当您达到 5 小时固定窗口额度或周窗口额度后，可选择以下方式：

1. **使用已购积分**：
   如果已购积分可用，Token Plan 资源覆盖范围内的用量可由已购积分自动补充支付。
2. **升级或获得新的分配**：
   升级订阅，或请团队 Owner / Admin 分配更高额度的可用套餐。
3. **切换至按量计费**：
   如需继续使用且不受限制，您可将订阅 Key 替换为您的[按量计费 API Key](https://platform.minimaxi.com/user-center/basic-information/interface-key)，切换至按实际 Token 用量计费模式，费用将从您的 API 账户余额中扣除。
4. **等待额度窗口重置**：
   套餐内 Token Plan 额度按 5 小时固定窗口和周窗口控制；未使用完的订阅额度不会结转到下一个计费周期。

## 下一步

<CardGroup cols={3}>
  <Card title="快速开始" icon="rocket" href="/docs/token-plan/quickstart">
    用 5 分钟跑通你的第一次 MiniMax API 调用。
  </Card>

  <Card title="常见问题" icon="info" href="/docs/token-plan/faq">
    用量、计费、切换、退款等高频问题集合。
  </Card>

  <Card title="活动 & 优惠" icon="gift" href="/docs/token-plan/promotion">
    查看当前进行中的优惠活动。
  </Card>
</CardGroup>



> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 快速接入

> 快速了解 Token Plan 订阅及接入

## 开始使用

<Steps>
  <Step title="获取订阅 Key">
    访问 [订阅管理 > Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) 查看您的 **订阅 Key**。

    <Callout icon="album" color="#A8A8A8" iconType="regular">
      重要提示：

      * 订阅 Key 用于 Token Plan 订阅套餐和已购积分。
      * 订阅 Key 与按量计费 API Key 不互通。
      * 这把 Key 可以在您尚未拥有付费资源时就存在；当您拥有 Token Plan 席位或积分权限后才可实际使用资源。
      * 请妥善保存您的 API Key ，建议将其导出为环境变量或保存到配置文件
    </Callout>
  </Step>

  <Step title="获得资源">
    在默认团队中购买个人 Plus、Max 或 Ultra Token Plan 订阅，或购买积分套餐；也可以使用团队 Owner / Admin 分配给您的资源。
  </Step>

  <Step title="测试 API 调用（可选）">
    通过 Claude SDK 快速测试 **MiniMax M3**

    **1. 安装 Claude SDK**

    <CodeGroup>
      ```bash Python theme={null}
      pip install anthropic
      ```

      ```bash Node.js theme={null}
      npm install @anthropic-ai/sdk
      ```
    </CodeGroup>

    **2. 配置环境变量**

    ```bash theme={null}
    export ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
    export ANTHROPIC_API_KEY=${YOUR_API_KEY}
    ```

    **3. 调用 API**

    ```python Python theme={null}
    import anthropic

    client = anthropic.Anthropic()

    message = client.messages.create(
        model="MiniMax-M3",
        max_tokens=1000,
        system="You are a helpful assistant.",
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Hi, how are you?"
                    }
                ]
            }
        ]
    )

    for block in message.content:
        if block.type == "thinking":
            print(f"Thinking:\n{block.thinking}\n")
        elif block.type == "text":
            print(f"Text:\n{block.text}\n")
    ```
  </Step>

  <Step title="接入 AI 编程工具">
    您可参考以下内容选择您常用的 AI 编程工具，体验最新 **MiniMax M 系列**模型能力

    <Columns cols={3}>
      <Card title="Claude Code" icon="sparkles" href="/docs/token-plan/claude-code" arrow="true" />

      <Card title="Cursor" icon="mouse-pointer" href="/docs/token-plan/cursor" arrow="true" />

      <Card title="Trae" icon="layers" href="/docs/token-plan/trae" arrow="true" />
    </Columns>

    <Columns cols={3}>
      <Card title="OpenCode" icon="folder-open" href="/docs/token-plan/opencode" arrow="true" />

      <Card title="Kilo Code" icon="zap" href="/docs/token-plan/kilo-code" arrow="true" />
    </Columns>

    <Columns cols={3}>
      <Card title="Grok CLI" icon="terminal" href="/docs/token-plan/grok-cli" arrow="true" />

      <Card title="Codex CLI" icon="file-code" href="/docs/token-plan/codex-cli" arrow="true" />
    </Columns>

    <Columns cols={3}>
      <Card title="Droid" icon="bot" href="/docs/token-plan/droid" arrow="true" />
    </Columns>
  </Step>
</Steps>

## 接入 MCP

快速接入 **Token Plan MCP**，获取 **网络搜索** 能力

<Card title="MCP 使用指南" icon="plug" href="/docs/token-plan/mcp-guide" arrow="true">
  了解如何配置和使用 Token Plan MCP
</Card>

## 了解更多

<Columns cols={2}>
  <Card title="Token Plan 定价" icon="coins" href="/docs/guides/pricing-token-plan" arrow="true">
    查看订阅和积分规则。
  </Card>

  <Card title="常见问题" icon="circle-help" href="/docs/token-plan/faq" arrow="true">
    查看用量、计费、切换和退款等高频问题。
  </Card>
</Columns>

## 最佳实践

快速查看 MiniMax Token Plan 模型的 Prompt 模板、工具调用和长上下文实践

<Columns cols={2}>
  <Card title="M 系列模型使用技巧" icon="lightbulb" href="/docs/token-plan/prompting-best-practices" arrow="true">
    掌握 Token Plan 模型的 Prompt 模板、工具调用和长上下文工作流
  </Card>

  <Card title="Mini Agent" icon="bot" href="/docs/token-plan/mini-agent" arrow="true">
    使用 M 系列模型构建 Agent
  </Card>
</Columns>
> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Token Plan 升级与权益调整说明

> M3 上线后的 Token Plan 计费切换、订阅权益保护与档位迁移方案

## 写在前面

我们收到大家关于 Token Plan 的许多反馈。本次调整未能提前与大家充分沟通并详细说明 M3 对应的 Token Plan 计费和套餐变化，是我们工作不到位。在老用户周限额等问题上处理也不够妥当，给一直支持我们的用户带来了困扰，请大家见谅。

M3 是一个更大尺寸、更加智能、多模态、拥有 1M 上下文的全新模型，它能够完成更加复杂的任务，也意味着需要更多的算力资源，需要全新的定价模式。M3 可以做越来越复杂的任务，自运行越来越长的时间，意味着单次调用的资源消耗指数提升，一次调用就可能消耗掉相当于过去多次调用的资源。继续沿用旧的计量口径，难以让每位用户都获得稳定一致的体验。同时 Token Plan 支持 MiniMax 多个模态的模型，我们收到许多用户反馈，希望能够将订阅额度自由使用到不同模态模型上。**因此我们将 Token Plan 切换到行业统一的 Token-Based 计量，让每个人按真实使用量获得对等价值，让 M3 的能力能够更稳定、可持续地交付到每位用户手中**。

为了尽快将 M3 交到大家手上，过去几周团队经历了高强度的工作，我们疏忽了提前与大家充分沟通，节奏上的取舍处理得不够周全，给一直信任和陪伴我们的老用户带来了困扰，非常抱歉。

***

## 第一部分 · 订阅权益调整说明

为了回馈订阅用户，2026 年 6 月 5 日前已订阅用户此前承诺的老用户权益将继续保留；具体权益、适用范围和实时状态请以控制台「权益详情」或用量看板展示为准。

关于此前迁移方案中发放的补偿积分，有效期将从一个月自动修正为 1 年（自发放日起），本周陆续订正中，自动生效。

### 补充说明

* 所有权益加成自订阅生效起**自动激活**，无需手动操作
* 相关老用户权益在**连续订阅周期内**有效；**如主动变更套餐档位或取消订阅，相关回馈权益即视为放弃**，后续恢复订阅亦不再补发
* 已发放补偿积分的有效期订正**自动完成**，无需用户操作
* 详细规则与实时权益状态以**控制台「权益详情」页面**展示为准

***

## 第二部分 · Token Plan 迁移说明

**核心承诺**：你原有的 M2.7 使用权益不会缩水，并且现在可以无缝使用 M3。

### 一、Plus / Max 档用户

价格不变，签约价继续生效。新方案下：

* M2.7 的 5 小时使用次数 **+10%**（不会变少）
* 新增 **M3 的使用权限**，与 M2.7 共享同一份额度池
* 新增**多模态权益**：图像、语音都可在同一份额度内调用

**当前自动切换，无需任何操作。**

### 二、Starter ¥29 / Plus-极速 ¥98（保留档）

这两档继续保留，**价格和签约关系不变**，但**仅对老用户开放**——新方案上线后不再对新用户售卖。

* M2.7 的使用次数**约增加 10%**
* 新增 M3 使用权限和多模态额度，与 M2.7 共享同一份额度池

<Tip>
  这两档为老用户专属保留档，建议保持订阅状态以延续当前权益；若中途断订，后续将无法再次订阅同档套餐。
</Tip>

当前自动切换，无需任何操作。

### 三、停售档位用户（Max-极速 ¥199 / Ultra-极速 ¥899）

这两档将停售。我们提供了**月费下降但权益不缩水**的迁移方案：

* **Max-极速 ¥199 → 新 Max ¥119**：月费下调 ¥80，每月额外补发**价值约 ¥160 的积分**用于覆盖差价，叠加多模态权益
* **Ultra-极速 ¥899 → 新 Ultra ¥469**：月费下调 ¥430，每月额外补发**价值约 ¥860 的积分**用于覆盖差价，含每日 5 条视频额度

下个续费日自动转入新档，你也可以主动选择其他档位或退订。

### 四、年包用户

已付费月份的权益保护原则：**M2.7 次数不缩水 + 多模态权益全部保留**，年付折扣率延续。

**停售档年包（Max-极速年包 / Ultra-极速年包）**：差价补偿不会一次性发放，而是**按订阅时间每月独立补发等值积分**（每月独立有效期 1 年，不滚存），确保整年权益不缩水。

举例说明：

* **Ultra-极速 ¥899/月 年包（剩余 8 个月）**：每月按订阅日切到新 Ultra ¥469 权益，并每月补发**价值约 ¥860 的积分**（¥430 差价 ×2），连续补 8 个月，至年包到期日。年包到期后按新 Ultra ¥469 年付价自动续约，可继续享年付折扣。
* **Max-极速 ¥199/月 年包（剩余 6 个月）**：每月按订阅日切到新 Max ¥119 权益，并每月补发**价值约 ¥160 的积分**（¥80 差价 ×2），连续补 6 个月。

### 五、新增 Ultra ¥469 重度档

填补 ¥199 与 ¥899 之间的空缺，适合重度 agentic 用户。月度容量约 71 亿 token，含每日 5 条视频生成额度。

### 六、关于已购积分使用说明

* **1,000 积分 = ¥7**（与 API 按量付费 1:1 等价，无加价）
* **MiniMax 开放平台大部分模型均可使用**（暂不支持 MiniMax H3 模型相关能力），按各模型 API 按量付费刊例价实时扣减
* **跨模态共享**：文本、图像、语音、视频（部分档位）均可由已购积分覆盖

***

后续 Token Plan 与套餐的任何调整，我们都将提前与各位用户说明清楚。再次感谢大家一路以来的信任与陪伴。


> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 常见问题

> 参考文档，了解关于 Token Plan 订阅套餐的相关问题

<div id="contact-us" />

## 问题反馈与使用交流有哪些渠道？

问题反馈与使用交流，请参考如下[渠道](/docs/faq/contact-us)。

***

<div id="token-plan-key" />

<div id="available-plans" />

## 现在有哪些 Token Plan 套餐可以选择？

当前公开订阅档位为 **Plus**、**Max** 和 **Ultra**。

| 套餐    | 价格       | 典型 Agent 用量 |
| :---- | :------- | :---------- |
| Plus  | ¥49 / 月  | 3-4 个 Agent |
| Max   | ¥119 / 月 | 4-5 个 Agent |
| Ultra | ¥469 / 月 | 6-7 个 Agent |

Ultra 面向更重度的 Agent 工作流用户。

更多价格、额度窗口和积分包信息，请参考 [Token Plan 定价](/docs/guides/pricing-token-plan)。

***

<div id="switch-models" />

## Token Plan 支持哪些资源，以及如何切换资源？

Token Plan 支持开放平台上的旗舰模型。用户无需按模型分别计算额度；控制台会通过统一的用量进度条展示套餐内额度和消耗情况。

对于已有按量计费价格的 API 端点，用量会按对应按量计费价格扣减套餐内 Token Plan 额度。不同模型、不同模态的实际消耗会不同。

<Tip>
  在 AI Agent 中调用支持的资源，请参考 [MiniMax CLI 指南](/docs/token-plan/minimax-cli)。
</Tip>

如需切换模型，请使用对应 API 或工具接入页面中说明的模型 ID。

***

<div id="shared-credits-pool" />

## 文本、图片、语音等额度是分开的吗？

不是。Token Plan 覆盖范围内的模型用量共享同一套套餐内 Token Plan 额度。您可以根据实际需求，将额度灵活用于不同模型和能力。

不同资源的用量消耗不同，实际可用资源和用量消耗以控制台展示为准。

***

<div id="token-plan-key" />

## 订阅 Key 是什么？

订阅 Key 是用于 Token Plan 订阅套餐和已购积分的 Key。

每位用户在所属的每个团队中都会拥有一把专属的订阅 Key。这把 Key 可以在团队尚未购买 Token Plan 席位或积分时就存在。在这种状态下，它暂时没有可用的付费资源。当用户被分配 Token Plan 席位，或获得积分使用权限后，同一把 Key 即可使用这些资源。

订阅 Key 与普通按量计费 API Key 相互独立，不能混用。

***

<div id="credits" />

<div id="credits-value" />

## 已购积分怎么折算？

已购积分是可单独购买的补充余额，用于覆盖 Token Plan 资源范围内的合规超额用量。

* **1,000 积分 = ¥7**，与开放平台 API 按量付费目录价等值。
* 使用已购积分调用已有按量计费价格的资源时，会按该资源的目录价折算为积分扣减。
* 文本、图像、语音等资源可由已购积分覆盖；视频等资源以对应套餐权益和控制台展示为准。
* 如果同一用量同时可由套餐内额度和已购积分覆盖，系统会优先扣除套餐内额度，超出部分再扣除已购积分。

***

<div id="credits" />

## 没有 Token Plan 订阅也可以使用积分吗？

可以。积分可以在没有 Token Plan 订阅席位的情况下单独购买和使用。

已购积分仍然通过订阅 Key 使用，资源覆盖范围与 Token Plan 相同。如果您没有 Token Plan 席位，但拥有积分权限，该覆盖范围内的用量会扣除已购积分。

如果您同时拥有套餐内 Token Plan 额度和已购积分，系统会优先扣除套餐内额度，超出部分再由已购积分自动补充支付。

如需使用 Token Plan 覆盖范围之外的资源，请使用按量计费 API Key。

详情请参考 [Token Plan 定价](/docs/guides/pricing-token-plan)。

***

<div id="default-team" />

<div id="check-usage" />

## 如何查看 Token Plan 用量？

您可以通过以下两种方式查看 Token Plan 用量：

方式一：访问套餐用量页面

访问 [订阅付费 > 套餐用量](https://platform.minimaxi.com/console/usage) 页面查看您的套餐、额度、积分和用量情况。

方式二：使用 API 接口查询

```bash theme={null}
curl --location 'https://www.minimaxi.com/v1/token_plan/remains' \
--header 'Authorization: Bearer <API Key>' \
--header 'Content-Type: application/json'
```

通常情况下：

* **低消耗**：日常聊天、翻译、简单写作。
* **中等消耗**：代码生成、多轮对话。
* **较高消耗**：长上下文推理、多模态任务、复杂 Agent 工作流。

***

<div id="reset-calculation" />

## 用量是如何重置的？

Token Plan 用量通过控制台用量进度条展示，并受额度窗口控制：

* **套餐内 Token Plan 额度**：受 5 小时固定窗口和周窗口控制。
* **订阅周期**：未使用完的套餐内 Token Plan 额度不会结转到下一个计费周期。
* **已购积分**：按自身有效期使用，不会因为套餐窗口刷新而重置有效期。

老用户迁移和周发放规则请参考 [Token Plan 迁移方案](/docs/token-plan/migration)。

***

<div id="switch-models" />

<div id="quota-limit" />

## 达到限额上限怎么办？

达到 5 小时固定窗口或周窗口上限时，您可以选择：

* **使用已购积分**：如果已购积分可用，Token Plan 覆盖范围内的用量可由已购积分自动补充支付。
* **升级订阅套餐**：前往 [Token Plan](https://platform.minimaxi.com/subscribe/token-plan) 页面升级到更高级别的套餐，升级后立即生效。
* **切换到按量付费**：如果您希望使用普通开放平台按量计费资源，可以将工具中的订阅 Key 更换为普通开放平台 API Key，按实际 token 使用量消耗账户余额。
* **等待额度窗口重置**：套餐内额度受 5 小时固定窗口和周窗口控制；未使用完的套餐内额度不会结转到下一个计费周期。

***

<div id="api-key-interchangeable" />

## Token Plan 的 API Key 和开放平台普通的 API Key 可以混用吗？

不可以。

* **订阅 Key**：用于套餐内 Token Plan 额度和已购积分。已有按量计费价格的 API 端点会按对应按量计费价格扣减套餐内 Token Plan 额度。已购积分的资源覆盖范围与 Token Plan 相同，可承接订阅额度之外的合规超额用量。
* **普通开放平台 API Key**：用于按量付费访问标准开放平台 API 接口，按实际 token 消耗量计费，消耗您的账户余额。

***

<div id="api-vlm" />

## API-vlm 在 Token Plan 中如何计费？

API-vlm 支持图像理解，输出为文本。

使用 Token Plan 调用时，API-vlm 会按其按量计费价格扣减套餐内 Token Plan 额度。如果套餐内额度耗尽且已购积分可用，超出部分可由已购积分自动补充支付。

***

<div id="multiple-tools" />

## 是否可以同时在多个工具中使用我的订阅套餐？

可以，您可以在所有支持的工具中使用同一订阅套餐，但额度是共享的，所有工具的使用会消耗同一套餐额度。

***

<div id="cancel-renewal" />

## 如何取消自动续订？

您可以在订阅管理页面取消自动续订。取消前请注意：

* 当前已发放的套餐内 Token Plan 额度在有效期内仍可正常使用。
* 已获得的补偿积分在有效期内仍可使用。
* 老用户专属保留档取消后的影响，请参考 [Token Plan 迁移方案](/docs/token-plan/migration)。

***

<div id="invoice" />

## 合并支付的订单如何开票？

开票规则如下：

* **支付宝直接付款**：可以开票
* **余额支付**：可以开票
* **余额 + 支付宝组合支付**：可以开票
* **代金券抵扣部分**：不可开票，仅实际支付的金额可以开具发票

如订单中使用了代金券，开票金额为扣除代金券后的实际支付金额。

***

<div id="tps-calculation" />

## 语言模型的 TPS（Tokens Per Second）是如何计算的？

TPS 表示模型每秒生成的 token 数量，用于衡量模型的推理输出速度。计算公式为：

$$
\text{TPS} = \frac{\text{输出 token 数量}}{\text{最后一个 token 的生成时间} - \text{第一个 token 的生成时间}}
$$

即从模型输出第一个 token 开始计时，到最后一个 token 输出完成为止，期间生成的 token 总数除以这段时间（秒）。

<Note>
  TPS 在实际使用中可能存在波动，各页面上标注的 TPS 为参考值。
</Note>

***

<div id="token-plan-limits" />

## Token Plan 有哪些使用限制？是否适合生产环境？

Token Plan 面向个人开发者的交互式使用场景，更高的套餐等级提供更高的额度上限。生产环境建议使用按量付费。

主要限制包括：

* **速率限制（RPM / TPM）**：超出后会限流，通常约 1 分钟恢复，高峰期可能动态收紧。
* **套餐内 Token Plan 额度**：受 5 小时固定窗口和周窗口控制。

***

<div id="highspeed-plan" />

<div id="token-plan-limit-rules" />

## 平台流量规则是什么？

为保障对所有用户的服务稳定性和可用性，MiniMax 平台可能在高峰时段实施动态限流策略。

我们观测到，部分请求来自超高并发自动化批量任务或多用户共享模式。为了避免少数异常流量挤占公共算力池，并保障大多数用户的稳定体验，平台会基于账户使用维度进行速率调控。

平台限流规则与行业实践保持一致，MiniMax 将在高峰时段进行动态限流：

* **流量高峰时段**：根据集群负载动态调整，通常出现在工作日 15:00-17:30。
  * Plus：约支持 3-4 个 Agent。
  * Max：约支持 4-5 个 Agent。
  * Ultra：约支持 6-7 个 Agent。
* **套餐额度**：套餐内 Token Plan 额度受 5 小时固定窗口和周窗口控制，未使用完的套餐内额度不会结转到下一个计费周期。

同时，我们正在持续推进算力扩容与系统优化，努力提供更稳定、可靠的服务。

***

<div id="upgrade-plan" />

<div id="check-usage" />

<div id="reset-calculation" />

<div id="quota-limit" />

* 使用已购积分 \
  如果已购积分可用，Token Plan 资源覆盖范围内的用量可由已购积分自动补充支付。
* 升级订阅套餐 \
  您可以前往 [Token Plan](https://platform.minimaxi.com/subscribe/token-plan) 页面升级到更高级别的套餐，获取更多的请求用量。Token Plan 支持随时升级，升级后立即生效。
* 切换到按量付费（Pay as you go） \
  如果您希望不受速率限制，您可以将编程工具中的 API Key 更换为您的从账户管理系统，MiniMax 开放平台普通的 API Key。这样，工具将切换到按实际 token 使用量计费的模式，消耗您的开放平台账户余额。
* 等待重置 \
  文本模型的限额是基于一个动态的 5 小时窗口。您可以暂停使用，等待窗口滚动，额度将会自动恢复。

<div id="api-key-interchangeable" />

<div id="api-vlm" />

<div id="multiple-tools" />

<div id="refund" />

<div id="invoice" />

<div id="tps-calculation" />

<div id="token-plan-limits" />

<div id="token-plan-limit-rules" />

如您在订阅服务中遇到任何问题，可扫描底部官方客服二维码，获得支持。


> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 订阅活动

> Token Plan，让您尽享 MiniMax 全模态模型的强大能力！

# Token Plan 好友邀请活动规则

## 1. 活动概要

* 活动时间
  * 邀请共建活动：2025 年 12 月 26 日 至 2026 年 8 月 31 日
* 参与资格
  * 邀请人： 所有 MiniMax 开放平台 Token Plan 的有效订阅用户（包含历史订阅用户）
  * 受邀人： 通过本次活动邀请链接访问并购买 Token Plan 的用户

## 2. 奖励机制

本活动采取“双向奖励”模式，具体参考以下内容

### 受邀人福利（Builder 专属权益）

* **Token Plan 订阅优惠**
  通过邀请链接购买 Token Plan，可在结算时享受 9 折优惠
  * 适用于 Token Plan 全场套餐订阅及订阅升级
  * 活动期间支持多次购买，均可享受相应优惠
* **Builder 共建者身份**
  * 受邀用户可加入 MiniMax 开发者社区，作为社区 Builder 参与交流，将有机会优先参与 MiniMax 新模型体验，并高效获取真实开发案例与前沿技术讨论

### 邀请人奖励（共建者回馈）

* **开放平台使用激励（代金券）**
  每成功邀请一位好友完成有效支付，邀请人将获得该好友订单实付金额 10% 的开放平台通用代金券
  * 代金券有效期为发放之日起 90 天
  * 仅可用于抵扣 MiniMax 开放平台内的 API 调用费用
  * 不可提现、不可转让，过期自动失效
* **开发者社区共建参与机会**
  * 符合条件的邀请人将有机会优先参与 MiniMax 新模型体验、开发者技术交流活动，并获得更直接的产品与技术反馈渠道

## 3. 注意事项

1. 自我邀请限制： 邀请人不可通过自己的邀请链接进行购买，此类订单不享受折扣，亦不发放奖励。
2. 退款处理： Token Plan 属于订阅性质产品，不支持退款。若受邀人的订单发生恶意退款，平台将自动收回该笔订单对应的奖励代金券。
3. 违规处理： 对于通过技术手段（如机器刷单、恶意注册）或虚假交易套取奖励的行为，一经发现，平台有权取消活动资格、追回已发放奖励，并保留追究法律责任的权利。
4. 活动调整：在活动期间，如出现不可抗力或情势变更的情况，包括但不限于重大灾害事件、黑客攻击、系统故障、活动受政府机关指令停止举办或调整本活动的，MiniMax开放平台可根据相关法律法规的规定调整/暂停/终止本次活动。
5. 最终解释权： 在法律允许的范围内，MiniMax 开放平台保留对本活动规则的最终解释权。
6. 如您对本次活动有任何疑问，请通过邮件 [api@minimaxi.com](mailto:api@minimaxi.com) 或扫描页面下方二维码联系客服。

请您在认真阅读并理解相关活动规则后自主决定是否参加。如您参加，则视为您已清楚活动规则并同意遵守。


> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 网络搜索 MCP

> **Token Plan MCP** 提供 **网络搜索** 工具，帮助开发者在编码过程中快速获取信息。

<Tip>推荐使用 [MiniMax CLI](/docs/token-plan/minimax-cli) 替代 MCP，配置更简单、使用更高效。</Tip>

## 工具说明

<AccordionGroup>
  <Accordion title="web_search" icon="search">
    根据搜索查询词进行网络搜索，返回搜索结果和相关搜索建议。

    | 参数    | 类型     |  必需 | 说明    |
    | :---- | :----- | :-: | :---- |
    | query | string |  ✓  | 搜索查询词 |
  </Accordion>
</AccordionGroup>

## 前置准备

<Steps>
  <Step title="获取 API Key">
    访问 [订阅管理 > Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) 查看您的订阅 Key。该 Key 需要拥有 Token Plan 席位或已购积分权限后，才能使用付费资源。
  </Step>

  <Step title="安装 uvx">
    <Tabs>
      <Tab title="macOS / Linux">
        ```bash theme={null}
        curl -LsSf https://astral.sh/uv/install.sh | sh
        ```
      </Tab>

      <Tab title="Windows">
        ```powershell theme={null}
        powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
        ```
      </Tab>
    </Tabs>

    <Note>
      其他安装方式可参考 [uv 仓库](https://github.com/astral-sh/uv)。
    </Note>
  </Step>

  <Step title="验证安装">
    <Tabs>
      <Tab title="macOS / Linux">
        ```bash theme={null}
        which uvx
        ```
      </Tab>

      <Tab title="Windows">
        ```powershell theme={null}
        (Get-Command uvx).source
        ```
      </Tab>
    </Tabs>

    <Note>
      若正确安装，会显示路径（如 `/usr/local/bin/uvx`）。若报错 `spawn uvx ENOENT`，需配置绝对路径。
    </Note>
  </Step>
</Steps>

## 在 Claude Code 中使用

<Steps>
  <Step title="下载 Claude Code">
    在 [Claude Code 官网](https://www.claude.com/product/claude-code)下载并安装 Claude Code
  </Step>

  <Step title="配置 MCP">
    <Tabs>
      <Tab title="一键安装">
        在终端运行以下命令，将`api_key`替换为您的 API Key：

        ```bash theme={null}
        claude mcp add -s user MiniMax --env MINIMAX_API_KEY=api_key --env MINIMAX_API_HOST=https://api.minimaxi.com -- uvx minimax-coding-plan-mcp -y
        ```
      </Tab>

      <Tab title="手动配置">
        编辑配置文件 `~/.claude.json`，添加以下 MCP 配置：

        ```json theme={null}
        {
          "mcpServers": {
            "MiniMax": {
              "command": "uvx",
              "args": ["minimax-coding-plan-mcp", "-y"],
              "env": {
                "MINIMAX_API_KEY": "MINIMAX_API_KEY",
                "MINIMAX_API_HOST": "https://api.minimaxi.com"
              }
            }
          }
        }
        ```
      </Tab>
    </Tabs>
  </Step>

  <Step title="验证配置">
    进入 Claude Code 后输入 `/mcp`，能看到 `web_search`，说明配置成功。

    <img src="https://filecdn.minimax.chat/public/59a2ac4d-fe8a-42d9-8898-e81aea641622.png" width="80%" />
  </Step>
</Steps>

<Note>
  如果您在 IDE（如 TRAE）中使用 MCP，还需要在对应 IDE 的 MCP 配置中进行设置
</Note>

## 在 Cursor 中使用

<Steps>
  <Step title="下载 Cursor">
    通过 [Cursor 官网](https://cursor.com/) 下载并安装 Cursor
  </Step>

  <Step title="打开 MCP 配置">
    前往 `Cursor -> Preferences -> Cursor Settings -> Tools & Integrations -> MCP -> Add Custom MCP`

    ![Cursor MCP 配置](https://filecdn.minimax.chat/public/61982fde-6575-4230-94eb-798f35a60450.png)
  </Step>

  <Step title="添加配置">
    在 `mcp.json` 文件中添加以下配置：

    ```json theme={null}
    {
      "mcpServers": {
        "MiniMax": {
          "command": "uvx",
          "args": ["minimax-coding-plan-mcp"],
          "env": {
            "MINIMAX_API_KEY": "填写你的 API Key",
            "MINIMAX_MCP_BASE_PATH": "本地输出目录路径，需保证路径存在且有写入权限",
            "MINIMAX_API_HOST": "https://api.minimaxi.com",
            "MINIMAX_API_RESOURCE_MODE": "可选，资源提供方式：url 或 local，默认 url"
          }
        }
      }
    }
    ```
  </Step>
</Steps>

## 在 OpenCode 中使用

<Steps>
  <Step title="下载 OpenCode">
    通过 [OpenCode 官网](https://opencode.ai/) 下载并安装 OpenCode
  </Step>

  <Step title="配置 MCP">
    编辑配置文件 `~/.config/opencode/opencode.json`，添加以下 MCP 配置：

    ```json theme={null}
    {
      "$schema": "https://opencode.ai/config.json",
      "mcp": {
        "MiniMax": {
          "type": "local",
          "command": ["uvx", "minimax-coding-plan-mcp", "-y"],
          "environment": {
            "MINIMAX_API_KEY": "MINIMAX_API_KEY",
            "MINIMAX_API_HOST": "https://api.minimaxi.com"
          },
          "enabled": true
        }
      }
    }
    ```
  </Step>

  <Step title="验证配置">
    进入 OpenCode 后，输入 `/mcp`，能看到 `MiniMax connected`，说明配置成功。

    <img src="https://filecdn.minimax.chat/public/1a24c300-4cff-40ee-a428-869467074c1d.png" width="80%" />
  </Step>
</Steps>



> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 其他工具

> 在任意支持自定义 OpenAI 兼容或 Anthropic 兼容端点的 AI 编程工具中接入最新的 MiniMax M 系列模型。

上面已经覆盖了主流 AI 编程工具的接入步骤。如果你使用的工具不在列表里，但支持自定义 Base URL + API Key，照下面的值填即可。

## 配置参考

MiniMax 同时提供两种兼容协议，你的工具支持哪种就选哪种——大多数现代工具至少支持其中一种。

### OpenAI 兼容协议

| 字段           | 值                                                                        |
| ------------ | ------------------------------------------------------------------------ |
| **Provider** | `OpenAI Compatible`（有的工具叫 `Custom` 或 `OpenAI-format`）                    |
| **Base URL** | `https://api.minimaxi.com/v1`                                            |
| **API Key**  | [获取订阅 Key](https://platform.minimaxi.com/user-center/payment/token-plan) |
| **Model ID** | `MiniMax-M3`                                                             |

### Anthropic 兼容协议

| 字段           | 值                                                                        |
| ------------ | ------------------------------------------------------------------------ |
| **Provider** | `Anthropic Compatible`（有的工具叫 `Claude` 或 `Custom Anthropic`）              |
| **Base URL** | `https://api.minimaxi.com/anthropic`                                     |
| **API Key**  | [获取订阅 Key](https://platform.minimaxi.com/user-center/payment/token-plan) |
| **Model ID** | `MiniMax-M3`                                                             |

## 该选哪种协议

| 工具类型                                            | 推荐协议                                    | 常见环境变量                                        |
| ----------------------------------------------- | --------------------------------------- | --------------------------------------------- |
| Claude Code 风格（为 Anthropic 设计的 TUI/CLI）         | Anthropic 兼容                            | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |
| Cursor / Continue / Aider / 各类 OpenAI 格式 IDE 插件 | OpenAI 兼容                               | `OPENAI_BASE_URL` + `OPENAI_API_KEY`          |
| 两种都支持的工具                                        | 任选——推荐 Anthropic 兼容（享受 prompt cache 优势） |                                               |

## Dify

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Dify**](https://github.com/langgenius/dify) 是一个开源 LLM 应用开发平台，集成工作流、RAG、Agent 与可观测性。</div>

<Steps>
  <Step title="安装插件">
    打开 [Dify Cloud](https://cloud.dify.ai)，登录后进入 **设置 → 工作空间 → 模型供应商**，在列表中找到 **Minimax** 并点 **安装**。
  </Step>

  <Step title="配置 API Key">
    安装完成后点 **添加 API Key**，填入 [订阅 Key](https://platform.minimaxi.com/user-center/payment/token-plan)、**API Base** `https://api.minimaxi.com/anthropic`、**Group ID** 留空。
  </Step>

  <Step title="开始使用">
    保存后即可在工作流中调用 MiniMax-M3 系列模型。
  </Step>
</Steps>

## Cherry Studio

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Cherry Studio**](https://github.com/CherryHQ/cherry-studio) 是一个开源桌面客户端，支持 50+ LLM 服务商，内置 MCP 服务器和 300+ 智能助手。</div>

<Steps>
  <Step title="安装客户端">
    按 [Cherry Studio 官方文档](https://docs.cherryai.com.cn/cherry-studio/installation) 完成安装。
  </Step>

  <Step title="添加 MiniMax provider">
    打开 Cherry Studio → 点 **Choose other Providers** → 搜索框输入 `MiniMax`，选 **MiniMax CN**。
  </Step>

  <Step title="填入 API Key">
    填入 [订阅 Key](https://platform.minimaxi.com/user-center/payment/token-plan)（API Host 已预填），点 **Check** 验证连接。
  </Step>

  <Step title="选模型">
    模型列表中选 `MiniMax-M3` 即可使用。
  </Step>
</Steps>

## Chatbox

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Chatbox**](https://github.com/chatboxai/chatbox) 是一款 AI 客户端应用和智能助手，支持众多先进的 AI 模型和 API，可在 Windows、macOS、Android、iOS、Linux 和网页版上使用。</div>

<Steps>
  <Step title="安装客户端">
    按 [Chatbox 官方文档](https://chatboxai.app/zh/guide) 完成安装。
  </Step>

  <Step title="添加 MiniMax provider">
    打开 Chatbox → 左下角点击 **设置** → 点击 **模型提供方** → 最下面点击 **添加** → 搜索框输入 `MiniMax`，选 **MiniMax CN** 或 **MiniMax Global**。
  </Step>

  <Step title="填入 API Key">
    填入 [订阅 Key](https://platform.minimaxi.com/user-center/payment/token-plan)（API Host 已预填），点 **API Key** 右侧的 **检查** 验证连接。
  </Step>

  <Step title="选模型">
    模型列表中选 `MiniMax-M3` 即可使用。
  </Step>
</Steps>

## Xcode

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Xcode**](https://developer.apple.com/xcode/) 是 Apple 官方 IDE，支持 macOS / iOS / iPadOS / watchOS / visionOS 开发，内置 Coding Intelligence。</div>

<Steps>
  <Step title="安装 Xcode">
    从 [Mac App Store](https://apps.apple.com/us/app/xcode/id497799835) 安装 Xcode 26 或更新版本。
  </Step>

  <Step title="添加 Model Provider">
    打开 Xcode → 顶部菜单 **Xcode → Settings → Intelligence → Add a Model Provider**，选 **Internet Hosted** 标签页，填：

    * **URL**：`https://api.minimaxi.com`（裸 host，不带任何 path）
    * **API Key Header**：`Authorization`（手动键入，覆盖默认的 `x-api-key`）
    * **API Key**：`Bearer <你的订阅 Key>`（`Bearer` 后**只有一个空格**再接 `sk-cp-…` key，[去获取](https://platform.minimaxi.com/user-center/payment/token-plan)）
    * **Description**：`MiniMax`（任意）

    <img src="https://filecdn.minimax.chat/public/xcode-provider-filled-zh.png" alt="Xcode 添加模型 Provider 对话框" style={{borderRadius: '8px', marginTop: '12px', maxWidth: '100%'}} />
  </Step>

  <Step title="启用模型">
    点 **Add**，回 Intelligence 面板进入新加的 MiniMax provider，启用 `MiniMax-M3`。
  </Step>

  <Step title="开始对话">
    打开任意项目，按 **⌘+0** 唤出 Coding Assistant，左上角编辑图标里选 `MiniMax-M3`。
  </Step>
</Steps>

## Kilo Code

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Kilo Code**](https://github.com/Kilo-Org/kilocode) 是开源的 VS Code AI 编程 Agent 插件，支持多家 LLM 服务商和 MCP 服务器。</div>

<Warning>使用前先清空 `ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_BASE_URL` 环境变量，否则会覆盖配置。</Warning>

<Steps>
  <Step title="安装扩展">
    在 VS Code 扩展面板搜索 `Kilo Code` 安装。
  </Step>

  <Step title="配置 MiniMax provider">
    打开 Kilo Code → **Settings**：

    * **API Provider** 选 `MiniMax`
    * **MiniMax Entrypoint** 选 `api.minimaxi.com`
    * **MiniMax API Key** 填入 [订阅 Key](https://platform.minimaxi.com/user-center/payment/token-plan)
    * **Model** 选 `MiniMax-M3`

    依次点 **Save** + **Done** 保存。
  </Step>
</Steps>

## Zed

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Zed**](https://github.com/zed-industries/zed) 是 Atom 创始团队打造的开源高性能多人协同代码编辑器，由 Rust 编写。</div>

<Steps>
  <Step title="安装 Zed">
    按 [Zed 官方文档](https://zedhub.org/getting-started) 完成安装。
  </Step>

  <Step title="添加 LLM Provider">
    设置 → **LLM Provider** → **+Add Provider** → 选 **OpenAI**，填：

    * **API URL**：`https://api.minimaxi.com/v1`
    * **API Key**：[Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) 获取
    * **Model Name**：`MiniMax-M3`
  </Step>

  <Step title="二次确认 API Key">
    点 **Save Provider** 保存，回 LLM Provider 列表点击新加的 MiniMax 条目，**再次输入 API Key 并按回车**确认。
  </Step>

  <Step title="选模型">
    回智能体面板右下角 **Select a Model** 选 `MiniMax-M3` 即可使用。
  </Step>
</Steps>

## OpenCode

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**OpenCode**](https://github.com/sst/opencode) 是 SST 出品的开源终端 AI 编程 Agent，支持多服务商接入和 LSP 集成。</div>

OpenCode 已**内置 MiniMax-M3**，无需额外配置文件。

<Steps>
  <Step title="安装 OpenCode">
    ```bash theme={null}
    curl -fsSL https://opencode.ai/install | bash
    # 或 npm i -g opencode-ai
    ```
  </Step>

  <Step title="登录认证">
    运行 `opencode auth login`，提示选 provider 时搜并选 **MiniMax Token Plan（minimaxi.com）**，填入 [Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) API Key。
  </Step>

  <Step title="启动">
    回到命令行 `opencode` 启动即可。
  </Step>
</Steps>

## Grok CLI

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Grok CLI**](https://github.com/superagent-ai/grok-cli) 是开源终端编程 Agent，可接入 xAI Grok 与任意 OpenAI 兼容服务商。</div>

<Note>不推荐做 Agent 工作流，推荐使用 **Claude Code** 或 **Cursor**。</Note>

<Warning>使用前先清空 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL` 环境变量。</Warning>

<Steps>
  <Step title="安装 Grok CLI">
    ```bash theme={null}
    npm install -g @vibe-kit/grok-cli
    ```
  </Step>

  <Step title="设环境变量并启动">
    ```bash theme={null}
    export GROK_BASE_URL=https://api.minimaxi.com/v1
    export GROK_API_KEY=sk-cp-...   # 从 Token Plan 获取
    grok --model MiniMax-M3
    ```
  </Step>
</Steps>

## Droid

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Droid**](https://factory.ai) 是 Factory 官方终端编程 Agent，可与 IDE 和团队协作工具集成。</div>

<Warning>必须先清空 `ANTHROPIC_AUTH_TOKEN` 环境变量（会覆盖 config.json 里的 key）。注意配置文件路径是 `~/.factory/config.json`（**不是** `settings.json`）。</Warning>

<Steps>
  <Step title="安装 Droid">
    ```bash theme={null}
    curl -fsSL https://app.factory.ai/cli | sh        # macOS / Linux
    # Windows:  irm https://app.factory.ai/cli/windows | iex
    ```
  </Step>

  <Step title="编辑配置文件">
    在 `~/.factory/config.json` 加入：

    ```json theme={null}
    {
      "custom_models": [{
        "model_display_name": "MiniMax-M3",
        "model": "MiniMax-M3",
        "base_url": "https://api.minimaxi.com/anthropic",
        "api_key": "<MINIMAX_API_KEY>",
        "provider": "anthropic",
        "max_tokens": 64000
      }]
    }
    ```
  </Step>

  <Step title="启动并选模型">
    启动 `droid`，`/model` 选 `MiniMax-M3` 即可使用。
  </Step>
</Steps>

## MonkeyCode

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**MonkeyCode**](https://github.com/chaitin/MonkeyCode) 是长亭科技 (Chaitin) 出品的企业级 AI 开发平台，Code Agent 兼容 Codex / Claude Code / OpenCode。</div>

<Note>MonkeyCode 内置免费的 MiniMax-M3，但资源池在高峰期可能排队，建议长期使用自己配 key。</Note>

<Steps>
  <Step title="登录平台">
    访问 [MonkeyCode 官网](https://monkeycode-ai.com/?ic=019b4f38-64b2-7dee-959c-ec02691c290d) 登录。
  </Step>

  <Step title="进入 AI 大模型配置">
    右下角 **配置** → **AI 大模型** → **绑定**。
  </Step>

  <Step title="填入 MiniMax 配置">
    * **API 地址**：`https://api.minimaxi.com/anthropic`
    * **API Key**：[Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) 获取
    * **接口格式**：`anthropic`
    * **模型名称**：`MiniMax-M3`

    <img src="https://filecdn.minimax.chat/public/3e2c1b6f-66a6-40c0-a67d-3b3ddf7daa68.png" width="80%" />
  </Step>

  <Step title="保存使用">
    **保存** 后回主界面即可使用 MiniMax-M3。
  </Step>
</Steps>

## Qwen Code

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Qwen Code**](https://github.com/QwenLM/qwen-code) 是阿里巴巴开源的终端编程 Agent，针对 Qwen 模型族优化。</div>

<Steps>
  <Step title="安装 Qwen Code">
    Linux / macOS：

    ```bash theme={null}
    bash -c "$(curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.sh)"
    ```

    Windows（Command Prompt 与 PowerShell 通用）：

    ```powershell theme={null}
    powershell -Command "Invoke-WebRequest 'https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen.bat' -OutFile (Join-Path $env:TEMP 'install-qwen.bat'); & (Join-Path $env:TEMP 'install-qwen.bat')"
    ```
  </Step>

  <Step title="启动并选 provider">
    终端运行 `qwen` 启动客户端，依次选 **Third-party Providers** → **MiniMax API Key** → 区域选 **China**。
  </Step>

  <Step title="填入 API Key">
    填入从 [Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) 获取的 API Key（前缀 `sk-cp-…`）后回车。
  </Step>

  <Step title="确认模型 ID">
    模型 ID 应为 `MiniMax-M3`，按回车提交即可开始对话。
  </Step>
</Steps>

## Open WebUI

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Open WebUI**](https://github.com/open-webui/open-webui) 是自托管的开源 AI 聊天平台，支持离线运行、RAG 和多模型 runner。</div>

<Steps>
  <Step title="安装 Open WebUI">
    通过 Python pip 安装（要求 **Python 3.11**，避免兼容性问题）：

    ```bash theme={null}
    pip install open-webui
    open-webui serve
    ```
  </Step>

  <Step title="创建管理员账号">
    浏览器打开 [http://localhost:8080](http://localhost:8080)，按提示创建本地管理员账号。
  </Step>

  <Step title="添加 OpenAI Connection">
    右上角头像 → **Admin Panel** → 顶部 **Settings** → 左侧 **Connections**，在 **OpenAI** 一栏点 **➕ Add Connection**，填：

    * **URL**：`https://api.minimaxi.com/v1`
    * **Auth**（Bearer 模式）：从 [Token Plan](https://platform.minimaxi.com/user-center/payment/token-plan) 获取的 API Key（前缀 `sk-cp-…`）
  </Step>

  <Step title="选模型">
    点 **Save** 后回到聊天界面，顶部模型选择器选 `MiniMax-M3` 即可对话。
  </Step>
</Steps>

## nanobot

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**nanobot**](https://github.com/HKUDS/nanobot) 是 HKUDS 出品的轻量级开源个人 AI Agent CLI，内置对话频道、记忆和 MCP 支持。</div>

<Steps>
  <Step title="安装 nanobot">
    ```bash theme={null}
    uv tool install nanobot-ai
    # 或：pipx install nanobot-ai
    # 或：pip install nanobot-ai            # macOS 上可能需要 --user 或 --break-system-packages
    ```
  </Step>

  <Step title="初始化">
    ```bash theme={null}
    nanobot onboard
    ```
  </Step>

  <Step title="一行配好 MiniMax">
    把 `sk-cp-...` 换成你的 [Token Plan API Key](https://platform.minimaxi.com/user-center/payment/token-plan)：

    ```bash theme={null}
    python3 -c '
    import json, os, sys
    p = os.path.expanduser("~/.nanobot/config.json")
    c = json.load(open(p))
    c["providers"]["minimax"]["apiKey"] = sys.argv[1]
    c["providers"]["minimax"]["apiBase"] = "https://api.minimaxi.com/v1"
    c["agents"]["defaults"]["provider"] = "minimax"
    c["agents"]["defaults"]["model"] = "MiniMax-M3"
    json.dump(c, open(p, "w"), indent=2)
    ' sk-cp-...
    ```
  </Step>

  <Step title="启动">
    ```bash theme={null}
    nanobot agent
    ```
  </Step>
</Steps>

## OpenHands

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**OpenHands**](https://github.com/All-Hands-AI/OpenHands)（前身 OpenDevin）是 All-Hands-AI 出品的开源 AI 编程 Agent，提供 TUI、网页 GUI 和 IDE 集成。</div>

<Steps>
  <Step title="安装 OpenHands">
    ```bash theme={null}
    pipx install openhands
    ```
  </Step>

  <Step title="一行配好 MiniMax">
    把 `sk-cp-...` 换成你的 [Token Plan API Key](https://platform.minimaxi.com/user-center/payment/token-plan)：

    ```bash theme={null}
    pipx run --spec openhands python -c '
    import sys
    from openhands_cli.stores.agent_store import AgentStore
    AgentStore().create_and_save_from_settings(
        llm_api_key=sys.argv[1],
        settings={"llm_model": "openai/MiniMax-M3",
                  "llm_base_url": "https://api.minimaxi.com/v1"},
    )
    ' sk-cp-...
    ```
  </Step>

  <Step title="启动">
    ```bash theme={null}
    openhands
    ```
  </Step>
</Steps>

## LangChain

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**LangChain**](https://github.com/langchain-ai/langchain) 是 LangChain Inc. 出品的开源 LLM 应用开发框架，提供模型适配器、检索、Agent 与可观测性能力。</div>

<Steps>
  <Step title="安装">
    ```bash theme={null}
    pip install langchain-openai
    ```
  </Step>

  <Step title="通过 OpenAI 兼容适配器接入 MiniMax">
    把 `sk-cp-...` 换成你的 [Token Plan API Key](https://platform.minimaxi.com/user-center/payment/token-plan)：

    ```python theme={null}
    from langchain_openai import ChatOpenAI

    llm = ChatOpenAI(
        model="MiniMax-M3",
        api_key="sk-cp-...",
        base_url="https://api.minimaxi.com/v1",
    )
    print(llm.invoke("Hello").content)
    ```
  </Step>
</Steps>


> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Codex

> 在 Codex 桌面客户端中使用最新的 MiniMax M 系列模型进行 AI 编程。

<div style={{background:"#fffbeb",borderLeft:"4px solid #d97706",padding:"12px 16px",borderRadius:"6px",margin:"16px 0"}}>[**Codex**](https://developers.openai.com/codex/) 是 OpenAI 官方的桌面端 AI 编程 Agent。</div>

## 安装 Codex

从 [OpenAI Codex 页面](https://developers.openai.com/codex/) 下载并安装 Codex 桌面客户端。

## 配置 MiniMax API

<Steps>
  <Step title="编辑配置文件">
    打开 `~/.codex/config.toml`，加入以下内容，并将 `<MINIMAX_API_KEY>` 替换为你从 [MiniMax 开放平台](https://platform.minimaxi.com/user-center/payment/token-plan) 获取的 Key：

    ```toml theme={null}
    model = "MiniMax-M3"
    model_provider = "minimax"
    model_context_window = 1000000

    [model_providers.minimax]
    name = "MiniMax"
    base_url = "https://api.minimaxi.com/v1"
    experimental_bearer_token = "<MINIMAX_API_KEY>"
    wire_api = "responses"
    ```
  </Step>

  <Step title="重启 Codex 并开始使用 MiniMax-M3">
    重启 Codex —— 即可开始使用 MiniMax-M3。
  </Step>
</Steps>

## 配置模型能力目录（可选）

Codex 可以通过自定义模型目录识别 MiniMax-M3 的多模态输入、reasoning effort（thinking 开关）、system prompt、工具类型以及其他详细参数。配置完成后，在 Codex CLI 中输入 `/model`，即可在模型列表中看到 MiniMax-M3 及其可选 reasoning level。

在 `~/.codex/config.toml` 中增加一行：

```toml theme={null}
model_catalog_json = "~/.codex/model-catalogs/custom-catalog.json"
```

然后新建 `~/.codex/model-catalogs/custom-catalog.json`，写入模型详细配置：

```json theme={null}
{
  "models": [
    {
      "slug": "MiniMax-M3",
      "display_name": "MiniMax-M3",
      "description": "MiniMax",
      "default_reasoning_level": "high",
      "supported_reasoning_levels": [
        { "effort": "none", "description": "Think-Off" },
        { "effort": "high", "description": "Deep" }
      ],
      "shell_type": "shell_command",
      "visibility": "list",
      "supported_in_api": true,
      "priority": 0,
      "base_instructions": "You are Codex, a coding agent based on MiniMax-M3. You and the user share the same workspace and collaborate to achieve the user's goals.",
      "supports_reasoning_summaries": true,
      "default_reasoning_summary": "none",
      "support_verbosity": false,
      "truncation_policy": { "mode": "bytes", "limit": 10000 },
      "supports_parallel_tool_calls": true,
      "experimental_supported_tools": [],
      "input_modalities": ["text", "image"]
    }
  ]
}
```

其中常用字段含义如下：

* `slug` / `display_name`：模型在 Codex 配置与 `/model` 列表中的标识和展示名称，需与 API 中使用的模型名保持一致。
* `default_reasoning_level`：默认 reasoning effort。对于 MiniMax-M3，任意非 `none` 值都会开启 Adaptive Thinking；该值不用于调节 reasoning 深度。
* `supported_reasoning_levels`：在 `/model` 中可切换的 reasoning 选项。`none` 表示关闭 thinking；`high` 表示开启 Adaptive Thinking。
* `base_instructions`：Codex 使用该模型时附加的基础 system prompt，可用于声明模型身份和协作方式。
* `supports_reasoning_summaries`：开启 Codex 对该模型的 Responses API reasoning 路径。设置为 `true` 后，Codex 才会发送 `reasoning.effort`；否则即使配置了 `default_reasoning_level`，Codex 也会省略 `reasoning` 字段。示例中将 `default_reasoning_summary` 设为 `none`，表示不额外请求 reasoning summary。
* `shell_type`：声明模型适配的 shell 工具调用类型，示例中使用 `shell_command`。
* `visibility` / `supported_in_api` / `priority`：控制模型是否出现在列表中、是否可通过 API 使用，以及在模型列表中的排序优先级。
* `supports_parallel_tool_calls`：声明模型支持并行工具调用，便于 Codex 处理多个工具请求。
* `experimental_supported_tools`：预留的实验性工具能力列表；没有额外工具时保持空数组即可。
* `input_modalities`：声明模型支持的输入模态。`["text", "image"]` 表示支持文本和图片输入。
* `truncation_policy`：控制上下文截断策略，示例中按字节数限制工具或上下文保留内容。

修改后重启 Codex，使新的模型目录生效。


> ## Documentation Index
> Fetch the complete documentation index at: https://platform.minimaxi.com/docs/llms.txt
> Use this file to discover all available pages before exploring further.

# 按量计费

> MiniMax按量计费定价

按量计费使用开放平台普通 API Key，并按实际用量消耗账户余额。积分是通过订阅 Key 使用的独立预付余额，资源覆盖范围与 Token Plan 相同。积分定价和使用规则请参考 [Token Plan 定价](/docs/guides/pricing-token-plan)。

## 语言模型

[立即充值](https://platform.minimaxi.com/user-center/payment/balance)

<Tabs>
  <Tab title="标准">
    | **模型**                                                                                                                                                                                                   | **输入价格**<br /> 元/百万 tokens | **输出价格**<br /> 元/百万 tokens | **缓存读取**<br /> 元/百万 tokens |
    | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------: | :------------------------: | :------------------------: |
    | **MiniMax-M3**<br />≤ 512k 输入 tokens <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">永久五折</span>   |        ~~4.20~~ 2.10       |       ~~16.80~~ 8.40       |        ~~0.84~~ 0.42       |
    | **MiniMax-M3**<br />> 512k 输入 tokens\* <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">永久五折</span> |        ~~8.40~~ 4.20       |       ~~33.60~~ 16.80      |        ~~1.68~~ 0.84       |
  </Tab>

  <Tab title="优先*">
    | **模型**                                                                                                                                                                                                 | **输入价格**<br /> 元/百万 tokens | **输出价格**<br /> 元/百万 tokens | **缓存读取**<br /> 元/百万 tokens |
    | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------: | :------------------------: | :------------------------: |
    | **MiniMax-M3**<br />≤ 512k 输入 tokens <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">永久五折</span> |        ~~6.30~~ 3.15       |       ~~25.20~~ 12.60      |        ~~1.26~~ 0.63       |
    | **MiniMax-M3**<br />> 512k 输入 tokens <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 dark:bg-red-900/30 dark:text-red-300">永久五折</span> |       ~~12.60~~ 6.30       |       ~~50.40~~ 25.20      |        ~~2.52~~ 1.26       |

    \* 优先服务可让请求获得优先准入，从而更快响应并降低失败率。调用时将 `service_tier` 设为 `priority` 即可启用。该层级按标准价格的 1.5 倍计费。
  </Tab>
</Tabs>

| **模型**                     | **输入价格**<br /> 元/百万 tokens | **输出价格**<br /> 元/百万 tokens | **缓存读取**<br /> 元/百万 tokens | **缓存写入**<br /> 元/百万 tokens |
| :------------------------- | :------------------------: | :------------------------: | :------------------------: | :------------------------: |
| **MiniMax-M2.7**           |             2.1            |             8.4            |            0.42            |            2.625           |
| **MiniMax-M2.7-highspeed** |             4.2            |            16.8            |            0.42            |            2.625           |

<Accordion title="历史模型">
  | **模型**                     | **输入价格**<br /> 元/百万 tokens | **输出价格**<br /> 元/百万 tokens | **缓存读取**<br /> 元/百万 tokens | **缓存写入**<br /> 元/百万 tokens |
  | :------------------------- | :------------------------: | :------------------------: | :------------------------: | :------------------------: |
  | **MiniMax-M2.5**           |             2.1            |             8.4            |            0.21            |            2.625           |
  | **MiniMax-M2.5-highspeed** |             4.2            |            16.8            |            0.21            |            2.625           |
  | **MiniMax-M2.1**           |             2.1            |             8.4            |            0.21            |            2.625           |
  | **MiniMax-M2.1-highspeed** |             4.2            |            16.8            |            0.21            |            2.625           |
  | **MiniMax-M2**             |             2.1            |             8.4            |            0.21            |            2.625           |
</Accordion>

<Info>
  请注意：

  1. 计费项是token数；tokens字符比值根据使用场景的不同略有浮动，以实际消耗为准，字符数包括标点等
  2. Token与字符比（估算）：1600 中文字符约消耗 1000 tokens
</Info>

## 语音

[立即充值](https://platform.minimaxi.com/user-center/payment/balance)

MiniMax 语音大模型能够根据上下文，智能预测文本的情绪、语调等信息，并生成超自然、高保真、个性化的语音。在社交、播客、有声书、新闻资讯、教育、数字人等多种场景中展现出强大的实力。

| **计费项**                  | **模型**           | **接口说明**                                                                          | **单价**<br />元/万字符 |
| :----------------------- | :--------------- | :-------------------------------------------------------------------------------- | :---------------: |
| 同步语音合成<br />T2A          | speech-2.8-hd    | 支持音量、语调、语速调整和混音功能，支持比特率、采样率相关参数调整特性，支持音频时长、音频大小等返回参数，适用于需要短文本快速得到结果的场景，比如闲聊、对话等场景 |        3.5        |
| 同步语音合成<br />T2A          | speech-2.8-turbo | 支持音量、语调、语速调整和混音功能，支持比特率、采样率相关参数调整特性，支持音频时长、音频大小等返回参数，适用于需要短文本快速得到结果的场景，比如闲聊、对话等场景 |         2         |
| 异步长文本语音合成<br />T2A Async | speech-2.8-hd    | 支持基于文本到语音的异步生成，单次文本生成传输最大支持 100 万字符，生成的完整音频结果支持异步的方式进行检索。                         |        3.5        |
| 异步长文本语音合成<br />T2A Async | speech-2.8-turbo | 支持基于文本到语音的异步生成，单次文本生成传输最大支持 100 万字符，生成的完整音频结果支持异步的方式进行检索。                         |         2         |

| **计费项**                      | **模型** | **接口说明**                                                                                                 |                                         **单价**<br /> 元/音色                                        |
| :--------------------------- | :----- | :------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------: |
| **音色设计**<br /> Voice Design  | 所有模型   | 支持基于用户输入的声音描述 prompt，来生成音色（voice\_id）；并支持使用该生成的音色（voice\_id）在同步语音合成、异步长文本语音合成接口中进行语音合成。                  | 9.9 <br /> 调用本接口获得新设计的音色时，不会立即收取音色设计费用。音色生成费用将在首次使用此音色进行语音合成时收取。<br />本接口内的试听语音合成会收取 2 元/万字符的费用。 |
| **快速复刻**<br /> Voice Cloning | 所有模型   | 基于大语言模型的音色克隆更加精准快速，无需数小时时长的超高质量原音频、无需传统 TTS 的超长工期，可以在极短时间内完成音色复刻，并通过大语言模型加持，使复刻后的音色与原音色进行高质量还原，从而满足客户需求。 |      9.9 <br /> 调用本接口获得复刻音色时，不会立即收取音色复刻费用。音色的复刻费用将在首次使用此复刻音色进行语音合成时收取。<br />试听字符根据选择的试听模型收费。     |

<Accordion title="历史模型">
  | **计费项**             | **模型**                             | **单价**<br />元/万字符 |
  | :------------------ | :--------------------------------- | :---------------: |
  | 同步语音合成 T2A          | speech-2.6-hd / speech-02-hd       |        3.5        |
  | 同步语音合成 T2A          | speech-2.6-turbo / speech-02-turbo |         2         |
  | 异步长文本语音合成 T2A Async | speech-2.6-hd / speech-02-hd       |        3.5        |
  | 异步长文本语音合成 T2A Async | speech-2.6-turbo / speech-02-turbo |         2         |
</Accordion>

<Info>
  注：计费项是字符数，以10000个字符（输入）为单位，1个汉字算2个字符，英文字母、希腊字母、标点符号、特殊符号、空格、回车等算1个字符。
</Info>

## 视频

[立即充值](https://platform.minimaxi.com/user-center/payment/balance)

**视频生成-输出价格**

| **模型/接口**                                            | **分辨率** | **计费规则** | **刊例价**  |
| :--------------------------------------------------- | :------ | :------- | :------- |
| <div style={{minWidth:'240px'}}>MiniMax-H3</div>     | 768P    | 按秒计费     | 0.50 元/秒 |
| <div style={{minWidth:'240px'}}>MiniMax-H3</div>     | 2K      | 按秒计费     | 0.80 元/秒 |
| <div style={{minWidth:'240px'}}>MiniMax-H3-Max</div> | 480P    | 按秒计费     | 0.33 元/秒 |
| <div style={{minWidth:'240px'}}>MiniMax-H3-Max</div> | 768P    | 按秒计费     | 0.50 元/秒 |

<Note>
  MiniMax-H3-Max 目前仅支持 T2V、I2V，仅输出视频计费，输入素材（图片）暂不计费。
</Note>

**视频生成-输入素材价格**

| **模型/接口**                                        | **素材类型** | **计费规则**                                            |
| :----------------------------------------------- | :------- | :-------------------------------------------------- |
| <div style={{minWidth:'240px'}}>MiniMax-H3</div> | 音频       | 免费                                                  |
| <div style={{minWidth:'240px'}}>MiniMax-H3</div> | 图片       | **5 张**以内免费，超出部分 **0.20 元/张**                       |
| <div style={{minWidth:'240px'}}>MiniMax-H3</div> | 视频       | 按输入视频时长及生成视频分辨率计费：**2K 0.80 元/秒**，**768P 0.50 元/秒** |

**视频再生成-输出价格**

将已生成的 768P 视频进一步生成为 2K 视频，按视频再生成输出秒数计费。

| **模型/接口**                                                     | **分辨率**   | **计费规则**     | **刊例价**  |
| :------------------------------------------------------------ | :-------- | :----------- | :------- |
| <div style={{minWidth:'240px'}}>MiniMax-H3-Regeneration</div> | 768P → 2K | 按视频再生成输出秒数计费 | 0.30 元/秒 |

**视频再生成-输入素材价格**

原 768P 生成任务中使用的输入素材需要重新计费。

| **模型/接口**                                                     | **素材类型** | **计费规则**                            |
| :------------------------------------------------------------ | :------- | :---------------------------------- |
| <div style={{minWidth:'240px'}}>MiniMax-H3-Regeneration</div> | 音频       | 免费                                  |
| <div style={{minWidth:'240px'}}>MiniMax-H3-Regeneration</div> | 图片       | **5 张**以内免费，超出部分 **0.15 元/张**       |
| <div style={{minWidth:'240px'}}>MiniMax-H3-Regeneration</div> | 视频       | 按原 768P 生成任务中输入视频的秒数计费：**0.30 元/秒** |

**H3-Context-IR 任务价格**

| **模型/接口**                                                   |     **输入价格**     |      **输出价格**     |
| :---------------------------------------------------------- | :--------------: | :---------------: |
| <div style={{minWidth:'240px'}}>MiniMax-H3-Context-IR</div> | 5.80 元/百万 tokens | 23.00 元/百万 tokens |

<Accordion title="历史模型">
  | **模型**                  | **功能**             | **单价**<br /> 元/视频 |
  | :---------------------- | :----------------- | :---------------- |
  | MiniMax-Hailuo-2.3-Fast | 图生视频，768P 6s       | 1.35              |
  | MiniMax-Hailuo-2.3-Fast | 图生视频，768P 10s      | 2.25              |
  | MiniMax-Hailuo-2.3-Fast | 图生视频，1080P 6s      | 2.31              |
  | MiniMax-Hailuo-2.3      | 文生视频，图生视频，768P 6s  | 2.00              |
  | MiniMax-Hailuo-2.3      | 文生视频，图生视频，768P 10s | 4.00              |
  | MiniMax-Hailuo-2.3      | 文生视频，图生视频，1080P 6s | 3.50              |
  | MiniMax-Hailuo-02       | 文生视频，图生视频，768P 6s  | 2.00              |
  | MiniMax-Hailuo-02       | 文生视频，图生视频，768P 10s | 4.00              |
  | MiniMax-Hailuo-02       | 文生视频，图生视频，1080P 6s | 3.50              |
  | MiniMax-Hailuo-02       | 图生视频，512P 6s       | 0.60              |
  | MiniMax-Hailuo-02       | 图生视频，512P 10s      | 1.00              |
</Accordion>

## 音乐

<Note title="Music API 服务调整通知">
  自 2026 年 8 月 20 日起，付费接口（音乐生成、歌词生成）不再面向新用户提供服务，历史付费用户可继续使用现有 API 服务；免费音乐生成接口（Music-3.0-free、Music-2.6-free、music-cover-free）停止服务。

  如需体验或使用音乐生成能力，可前往 [MiniMax Audio](https://www.minimaxi.com/audio)，或使用已发布在 [Hugging Face](https://huggingface.co/MiniMaxAI/MiniMax-Music3) 和 [魔搭 ModelScope](https://modelscope.cn/models/MiniMax/MiniMax-Music3) 的 MiniMax Music 3 开源模型。
</Note>

| **模型**         | **接口说明**              | **单价**<br /> 元/首 |
| :------------- | :-------------------- | :--------------: |
| Music-3.0（已下线） | RPM = 120，若需提升可联系销售定制 |        1.0       |
| Music-2.6（已下线） | RPM = 120，若需提升可联系销售定制 |        1.0       |
| 歌词生成（已下线）      | 歌词生成/编辑               |       0.05       |

<Accordion title="历史模型">
  | **模型**          | **接口说明**              | **单价**<br /> 元/首 |
  | :-------------- | :-------------------- | :--------------: |
  | Music-2.5+（已下线） | 最新音乐生成模型，纯音乐解锁，突破风格边界 |        1.0       |
  | Music-2.5（已下线）  | 全维度突破，指挥细节，定义真实       |        1.0       |
  | Music-2.0（已下线）  | 多变音色，丰富乐器表现           |       0.25       |
</Accordion>

## 图像

[立即充值](https://platform.minimaxi.com/user-center/payment/balance)

| **模型**                      | **接口说明**            | **单价**<br /> 元/张 |
| :-------------------------- | :------------------ | :--------------: |
| image-01<br />image-01-live | 支持用户通过文本描述或参考图片生成图片 |       0.025      |

## MCP

[立即充值](https://platform.minimaxi.com/user-center/payment/balance)

| **模型**  | **接口说明**                             | **输入价格**<br />元/次 |
| :------ | :----------------------------------- | :---------------: |
| API-vlm | 通过 **Token Plan MCP** 插件或工具自带的视觉接口调用 |       0.025       |

通过 Token Plan 调用 API-vlm 时，会按其按量计费价格扣减套餐内 Token Plan 额度；套餐内额度耗尽且已购积分可用时，超出部分可由已购积分自动补充支付。

<Callout color="#FFC107">
  🔔 **定价调整预告**：自2026年7月22日起，API-vlm 按量价格调整为 ¥0.025 元/次。Token Plan 套餐内单次 API-vlm 调用扣减的 token 额度将同步减少，同等套餐可支持更多次调用。接口与能力保持不变，无需任何代码调整。
</Callout>

## 服务端工具 <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700 before:content-['Beta'] dark:bg-blue-900/30 dark:text-blue-300" />

[立即充值](https://platform.minimaxi.com/user-center/payment/balance)

| **服务端工具**       | **接口说明**                                                 | **单价**<br /> 元/次 |
| :-------------- | :------------------------------------------------------- | :--------------: |
| **web\_search** | 联网搜索，模型在服务端自动执行搜索并基于结果作答，详见[服务端工具](/docs/guides/server-tools) |       0.03       |
