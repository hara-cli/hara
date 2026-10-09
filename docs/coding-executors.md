# Hara 内置代码执行引擎

Hara Bot 负责理解需求、安排任务和向用户汇报；OpenCode 与 Pi 是后台执行能力，不是要求用户另外维护的聊天对象。当前接入仅对个人空间开放，组织执行策略保持独立。

## 使用方式

1. 在主 Bot 对话里描述代码需求及目标目录，例如「检查这个仓库的错误，并提出修复」。不需要先新建 OpenCode/Pi 会话。
2. Bot 通过 `runtime: "coding"` 委派任务，Hara 根据全局偏好解析出确定的引擎。启动、文件修改和合并仍受各自授权边界约束。
3. 需要用户选择或批准时，卡片出现在原 Bot 对话里；取消、过期、断线或任务换代后，旧卡片不能继续授权。
4. 代码修改保留在独立 Git worktree。Bot 可以检查 Diff，只有明确批准后才合并回源目录，不自动覆盖用户的改动。

Desktop 的「设置 → 应用与更新 → 代码执行引擎」提供：

- **自动**：目前固定推荐 OpenCode，是工程交付默认，不是性能排行榜或自动模型切换。
- **OpenCode**：内置运行时，经 Hara 的模型连接和受控工具执行。
- **Pi（实验性）**：内嵌 SDK，使用同一套 Hara 模型连接与工具边界。
- **Codex / Claude Code**：使用它们各自已有的本机登录；不会共享账号、复制认证凭据或替它们安装登录工具。

偏好只影响新建代码任务。已绑定的 worker、引擎和原生 session ID 不因设置变更而替换；继续任务使用原来的会话。保存偏好不等于引擎已登录或就绪，不能静默换到另一个引擎。

CLI 的可信宿主启动变量 `HARA_CODING_EXECUTOR=auto|opencode|pi|codex|claude` 可覆盖偏好，启动时捕获；存在覆盖时 Desktop 只读显示。项目配置、模型工具输入不能修改该变量或全局偏好。

## 安装与运行时

- npm 安装固定版本的 Pi SDK 和匹配平台的 OpenCode 原生 optional dependency。不要使用 `--omit=optional`，也不需要额外安装 OpenCode/Pi 应用。
- Desktop 使用独立校验的 OpenCode sidecar；Pi SDK 随 Hara 引擎编译。Desktop 构建使用 `desktop-sidecar` 模式，避免再在 CLI sidecar 内嵌一份相同运行时。开发源码通过检查不等于当前旧 sidecar 已升级，正式打包必须锁定包含这些修改的 CLI tag/commit。
- standalone 构建从 lockfile 指定的官方 npm tarball 校验 SHA-512，为每个目标嵌入对应 OpenCode 原生文件；macOS 在原生构建机为副本签名后再嵌入。运行时按内嵌 SHA-256 校验并释放到用户私有缓存，不联网下载、不执行 npm 安装脚本、不从 PATH 寻找替代命令。
- Bun 1.3.9 的 musl 构建需要显式传入匹配的 `bun-linux-arm64-musl` 或 `bun-linux-x64-musl-baseline` 目标；无法确认 libc 时拒绝猜测。跨平台构建成功仍须在目标系统执行 native runtime smoke，不能视为已经验收。
- 显式 Desktop sidecar 无效、安装包缺失或缓存内容不匹配时拒绝执行并显示修复提示，不让 Codex/Claude 的注册一起崩溃，也不偷偷调用系统里同名的程序。
- OpenCode 原生包较大。部分 musl 平台的 npm 安装可能同时保留两种 Linux optional 包；运行时只选择匹配的一个，不代表两个都执行。
- 许可声明随 npm 包和编译后的 CLI 交付，可离线运行 `hara licenses` 查看。

## 权限、状态与用量

OpenCode/Pi 只获得临时回环模型地址和单次随机凭据，不获得真正的服务商 Key。模型请求回到同一个 Hara Provider；真实模型、连接代次、profile、worker、turn 和 worktree 绑定在 Hara 内部校验。

工具只开放 `read_file`、`write_file`、`edit_file`、`list_files`、`ask_user`。上游自带 shell、插件、扩展、技能、认证刷新和更新机制不启用。**当前这两个受控 worker 没有任意 shell / 构建 / 测试执行工具**；不能把生成代码或模型自述当作已运行测试，主 Bot 必须单独使用具备相应授权的验证能力并保留证据。这是有意保留的权限边界，不是完整照搬上游 CLI。

会话使用不透明 ID，持久消息与私有 continuation 有完整性校验及连接代次隔离；邮箱只在对应输入确实被受理、消费并落盘后核销，失败不冒充投递成功。任务预算由 Hara 模型/工具 host 的实时计数决定，不采用可能缺失或重复的 SDK usage 估算。取消后的已发出输入也计入父任务，不重复累计；缺失实际 usage 时使用保守输入估算，不能据此换算订阅余额或费用。

Pi 同时待处理的补充消息按原顺序进入下一模型回合，不为每条排队消息另起一轮；各消息仍单独持久化，并在成功结束后按 ID 核销。取消或失败不提前核销。此行为不等于合并不同任务、放宽预算或允许消息授予工具权限。

编程专用工具说明与实际白名单保持一致，不再推荐该 worker 不具备的 grep、shell 或 apply_patch。工具参数约束和每次修改的授权检查不变；精简说明减少的是静态请求字节，不能直接换算成 token、延迟或账单降幅。

## 上游源码参考

Pi 官方仓库 `https://github.com/earendil-works/pi.git` 已保留独立本地 Git 副本 `hara/github/pi`，固定于 `ce950d78f424dcaf9f5d6a03ce80ab141130eb1d`，不依赖临时 benchmark 目录。该 checkout 的 coding-agent/agent-core/pi-ai 包版本为 1.1.0；SDK、model-runtime、agent 和 agent-loop 四个源文件已与安装的 npm 1.1.0 sourcemap 内容逐字核对一致。npm 元数据未提供 gitHead，因此不将整个 checkout 宣称为 npm 发布 commit。参考仓不随 Hara npm 包发布，也不在启动时安装或执行其项目脚本。

## 验证边界

合成真实模型对比见 [coding-executors-benchmark.md](coding-executors-benchmark.md)。10 月 9 日生产 adapter 的同模型补测中，两者均完成首段和同会话续跑；此前因 benchmark 重复计量被截断的 Pi 样本仍如实保留，不追溯改写。小样本不足以证明谁普遍更快或更省。离线 SDK/MCP/Serve 恢复与授权回归单独验收，不能用它们替代真实公网、崩溃/断电、跨版本迁移或全部平台的原生交付测试。
