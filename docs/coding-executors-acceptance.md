# OpenCode / Pi 整合验收（2026-10-09）

状态（2026-10-10）：CLI 0.185.0 的四平台原生包及公开 Mac smoke 已通过发布，npm 在上传前因 npm 12 清单格式兼容问题停止；正在准备 0.185.1 补丁走完整门禁。Desktop 0.1.181 尚未发布、装机 sidecar 未替换。下列分阶段记录保留原验收时间，不以源码检查替代正式交付。

## 已接通的流程

- 主 Bot 通过 `runtime: "coding"` 调度，系统设置提供 auto / OpenCode / Pi / Codex / Claude。auto 目前确定地选择 OpenCode；Pi 明确标记实验性。不因失败静默切换引擎。
- 新 worker 捕获所选引擎、模型连接和权限代次。已有 worker / 原生 session 继续原绑定，设置变化不能偷换会话。
- OpenCode 1.18.32 与 Pi SDK 1.1.0 使用同一 Hara Provider、受控工具、取消信号、预算与原对话授权卡片。真实 Provider Key 不传给执行引擎。
- continuation、邮箱核销、连接/父回合隔离、独立 worktree 与人工合并均走宿主边界；取消尾账由同步 usage observer 计入父任务，再以最终快照幂等对账。
- npm 含固定 Pi SDK 与匹配平台的 OpenCode optional 包。standalone 内嵌官方 lockfile SHA-512 校验后的原生文件，运行时 SHA-256 校验后释放到私有缓存。Desktop 显式使用已有校验 sidecar，避免重复嵌入。
- 许可文本随包交付，`hara licenses` 可离线读取。用法见 [coding-executors.md](coding-executors.md)，真实模型小样本试验与其限制见 [coding-executors-benchmark.md](coding-executors-benchmark.md)。

## 验证结果

验证使用独立临时源码副本、私有 HOME / worktree，未重建用户运行中的 `dist` 或重启 Hara。

| 检查 | 结果 |
| --- | --- |
| 首轮 CLI 全量回归 | 2,361 通过，1 跳过，0 失败；随后新增构建门禁相关 8 项独立通过 |
| Desktop 设置与偏好 | 16 项通过，TypeScript 与 production build 通过 |
| Desktop 打包边界 | 60 项通过，Shell 语法与 release metadata 检查通过 |
| 生产依赖审计 | 0 已知漏洞 |
| npm pack dry-run | 282 文件；包含两引擎模块、文档与许可，未包含配置/私有状态路径 |
| Darwin ARM64 完整 standalone | 编译、版本、离线许可、恶意 cwd/preload 隔离、自重入、Serve 及认证关闭通过 |
| 内嵌 OpenCode 真实释放 | 原生版本 1.18.32、SHA-256、0500、缓存复用通过 |
| Desktop-sidecar 模式 | 实际编译通过；候选 CLI sidecar 84,729,568 B，不再额外内嵌 144,892,800 B 原生素材 |

实际引擎测试使用合成的本机 Provider，不产生付费模型请求：

- **Pi**：最新宿主代码重新编译 Bun，2 次模型往返、1 次读取；先 durable bind，v3 JSONL 与 0600 校验通过。host/最终计量均输入 12、输出 5。
- **OpenCode**：真实 Darwin ARM64 原生程序而非模拟 engine，2 次模型往返、1 次 `hara_read_file`；6 次 import/export/run 均退出 0；重建 adapter 后恢复相同 owned 会话。原生 SDK、host、adapter 均输入 12、输出 5。
- **取消尾账**：Serve 集成回归从旧错误父计数 9 修复为 4,074（取消请求保守输入 4,065 + 根任务 9）；不重复计量、不在取消后继续授权工具。

原始测试输出与合成 harness 保留在工作站临时目录，仅用于复核，不作为公开发布证据，也不提交请求正文或任何认证信息。

## 同日继续优化与同模型补测

- 官方 Pi 源码已保留为 `hara/github/pi` 的独立 clean Git checkout，HEAD `ce950d78f424dcaf9f5d6a03ce80ab141130eb1d`。关键 SDK 文件已与 npm 1.1.0 sourcemap 逐字核对；不据此推断整个 npm 发布 commit。
- 编程专用工具说明清除未开放工具指引；三项 ToolSpec JSON 由 2,552 减至 1,812 bytes，减少 740 bytes（约 29%），不是 token 或账单降幅。原通用工具对象、schema 约束和执行边界保持不变。
- Pi 同时排队的补充消息保序批量进入下一回合。真实 SDK＋合成宿主回归验证两条消息分别持久化、成功结束后逐条 ACK；取消不 ACK、仍可安全恢复。压缩、自动重试仍关闭。
- 独立候选重新编译通过；coding tools / host / continuations 共 66 项、Pi / OpenCode worker 共 27 项、benchmark usage 共 9 项，合计 **102 项通过、0 失败**。这是本次聚焦回归，不将首轮全量结果冒称为修改后重新全跑。
- 真实模型补测走生产 adapter＋共同 host＋明确的 Hara Chat Provider，两个引擎均完成 ledger 首段和同会话续跑；四阶段代码和记忆标记独立验收通过。16 请求／32 累计 usage 帧只结算 16 次，Provider／host／SDK 完全一致，实际总 I/O **34,738**，低于 80,000 总限额，无额外付费重跑。详情与 SHA256 见 [benchmark 文档](coding-executors-benchmark.md#2026-10-09生产接线的完整续跑补测)。

本次未替换运行中的 CLI dist 或 Desktop sidecar，未改用户模型偏好、账号或凭据；仍未发布。补测为一个合成任务，不能据耗时和 token 将默认引擎改作性能排行榜。

## 尚不能宣称完成的范围

- 当前 OpenCode/Pi worker 只提供 read/write/edit/list/ask 工具，没有任意 shell / build / test 工具。主 Bot 必须单独通过获授权的验证能力确认构建和测试，不能以模型自述代替。
- 本机验收是 Darwin ARM64；Linux、musl、Intel Mac 与 Windows 不能由此推定通过。已把实际原生提取/摘要/版本 smoke 接入 CI 与发布门禁，必须在相应 runner 上验证。
- 真实断电/崩溃、公网、多设备、跨版本迁移和组织策略不在本次验收结论内；同日补测只证明正常关闭后同会话继续，不代表同条件的崩溃恢复或 Coding Plan 默认 Responses 路由的真实模型验收。
- 正式交付仍需新 CLI 版本、干净提交/tag、公开产物核验，然后更新 Desktop 的精确 CLI stamp 并走既有签名、公证与发布流程。未把开发验收冒充上线。

## 0.185.0 发布前产物门禁（2026-10-09，未发布）

- Windows 修订后隔离候选完整 `npm test`：2,484 项，2,483 通过、0 失败/取消、1 个 Windows 专项条件跳过，
  约 191 秒。明确 Node 22.23.1/Bun PATH；此前因旧断言和 IPv6 夹具失败的全量结果仍保留，
  不以定向复跑替代本次最终全量。
- 最终候选在私有安装目录完成真实 npm pack/install 验收：283 个公开文件、CLI version/help/licenses、
  Pi SDK 版本与 API、独立安装路径归属，以及 OpenCode Darwin ARM64 1.18.32 原生执行均通过。
  只对两个既有公开插件 manifest 放行精确隐藏路径，其他隐藏/私有内容仍拒绝。
- npm 保留验收过的 tarball 与四字段 SHA-512 receipt，上传前只读复核同一文件；不在发布步骤重打包。
  Pi 的 import-only 导出使用安装目录内 ESM 探针解析，导入前拒绝依赖路径逃逸。
- 新编译 CLI 0.185.0 的 Darwin ARM64 产物按既有 entitlements 做 ad-hoc 外层签名，签名校验后再次
  通过 boundary、Serve、内嵌 OpenCode 和 compiled Pi 四项实际 smoke。Pi 使用认证 Serve 与本机
  合成 Provider，真实读工具、同会话第二代继续和 3 请求/21 输入/9 输出计量一致，无付费请求。
  Windows 路径修订后重新编译并通过同样四项 smoke 的临时产物 SHA-256 为
  `9c046d153dbfdbe44be47ef7a538ff3dc82e775ca1c5cfc139e52da22114547c`。
- npm 发布依赖完整 reusable CI；Linux ARM64 在原生 runner 执行后才进入 release assembly。
  npm 安装门禁已进入 Node、Windows 及四平台 native lane，compiled Pi smoke 进入 native 和公开
  Darwin 产物门禁。这些是已接入的要求，不表示这些远端 runner 已经为本候选通过。
- Desktop 当前源码候选 457/457 回归、production build 与锁定 Rust 的本机 cargo check 通过。
  这不是完整 packaged-app initialize、Developer ID 公证、真实手机/公网 Relay 或稳定更新渠道验证。
  Desktop 仍锁旧 CLI；必须在 CLI 的新提交/tag 与公共产物验证后更新锁并单独发布。

### Windows 远端门禁阻止发布及修订

- 首次 main CI `37945998646`（`cd1ee086`）的八个非 Windows job 通过。Windows 的编译、
  boundary、Serve 与内嵌 OpenCode 均通过，但 npm 私有安装触发 180 秒 deadline，Pi worker
  返回 failed 而非 completed。因此没有创建发布 tag，也没有发布 npm 或 Desktop。
- npm 安装仍固定使用官方 registry、禁用生命周期脚本、隔离配置且失败即停止；Windows 的
  有界安装预算改为 360 秒，其他平台保持 180 秒。新增固定阶段/耗时/预算诊断，不回显子进程
  原始内容；现有日志不足以把具体原因归到网络或磁盘。
- 另发现工作树登记直接比较 Git slash 路径与 native Windows 路径的缺陷。改用 `--porcelain -z`
  原始字段和原生规范身份，保留目录 no-link、源仓登记、HEAD 与 cwd 检查。新增 Windows drive/UNC、
  NUL/Unicode、真实 prepare/capture、链接与外仓拒绝回归，并进入 Windows 专项 CI。
- Pi 失败诊断只依赖 Node builtins，输出固定阶段、轮次、状态与工作树错误码，不打印任意错误
  正文、路径、模型输入或 token；公开原生产物检查无需源码 dist/node_modules。
- 修改后本机完整回归和真实 npm 包检查通过，新 Mac ARM 原生产物四项 smoke 通过。
  仍须新提交的 Windows CI 验证；不能凭源码缺陷推定首次 Pi 失败的全部原因已证实。

## 0.185.1 补丁准备（2026-10-10）

- `e3e022b2467ce1463b485dbc65e7cafeb3849e29` 的 main CI `37951089132` 九项全绿，
  `v0.185.0` 标签保持不变。原生发布 `37952851998` 的 Linux ARM 批准等待夹具首轮失败，
  同 SHA 单次失败 job 重跑通过；四平台原生包和公开 Mac 双架构 smoke 均通过。
- npm run `37952852365` 在 pack 命令成功后、真正 publish 前停止。官方 npm 12.1.0 返回
  `{ "@nanhara/hara": packed }`，旧检查仅接受 `[packed]`，已实际复现，非模型或安装问题。
  补丁仅接受这两种唯一包结构，原身份、公开文件白名单、实际 tarball SHA-512 与同包发布要求不变。
- 私有 Node 24.15.0/npm 12.1.0 已完成修复后的真实 pack、隔离安装、CLI、SDK 与 OpenCode 原生检查，
  Node 22/24 定向检查各 36 通过、1 个平台条件跳过；这些旧版本诊断产物不充当新 0.185.1 发布包。
- 新补丁还将普通 CI 与发布 Node/npm 精确版本对齐，并使批准等待夹具只排除确认前 setup 竞争，
  仍实际等待 1150ms、要求确认和工具各一次，并保留生产 1000ms 预算与取消断言。
- 0.185.1 仍须新 SHA 的完整 CI、npm 与原生发布。Desktop 0.1.181 仅在这些公共产物验证后锁定该新 SHA，
  不把先前 0.185.0 stamp 或本机前端测试当作新 sidecar 验收。
- 新 0.185.1 私有候选完整 host 回归：2,488 项，2,487 通过、0 失败/取消、1 个 Windows 条件跳过，
  约 178 秒；此前误在 sandbox 执行的 EPERM 失败日志保留，不计作通过。生产依赖审计 0 已知漏洞。
  Node24/npm12 对新版本实际 pack/install/CLI/SDK/native 全链通过，283 个公开文件；独立审阅无阻断，
  40 项包/策略回归及 13 项批准、取消、剩余预算相邻检查通过，另 1 个 Windows 条件跳过。
