# Claude 记忆导入（从 nanhara 会话记忆分流而来）

> 2026-08-27 迁入。这些条目原本存在 `~/.claude/projects/-Users-zhujianbo-work-projects-nanhara/memory/`，
> 只有从 nanhara 根目录起的会话看得见 —— 而它们讲的是**本仓**的事。
> 现在放这里：进 git，Codex 和任何从本仓起的会话都能读到。
> 原件已归档到 `memory/.migrated-2026-08-27/`（可回滚）。
> ⚠️ 记忆是**写下时**的观察，不是实时状态。引用前先对当前代码验证。

---

## reference_hara_release_via_tag_ci

**摘要**：hara 发版=push v* tag 触发 CI 自动 npm publish;本地别碰 token/别 npm publish

hara-cli(`@nanhara/hara`,repo `github.com:hara-cli/hara`)**发版机制 = 打 `vX.Y.Z` tag,CI 自动发**,本地根本不推 npm、不碰 token。

**流程**:改代码 → `npm version patch --no-git-tag-version` bump package.json + 写 CHANGELOG.md → commit + push main → `git tag -a vX.Y.Z -m "…" && git push origin vX.Y.Z`。tag 一推,两条 workflow 触发:

⚠️**发版后两条 workflow 都要看**(2026-07-02 教训:release.yml 从飞书适配器加入起每个 tag 都在挂,只盯 publish-npm 没发现,Jeff 收 GitHub 失败邮件才暴露)。病根已修(0.104.0):①Dockerfile build 段 `npm ci` 要 `--ignore-scripts`(否则 prepare→tsc 在 COPY src 前跑挂);②bun 打包吃不了 lark SDK 的 default import(ESM 构建无 default,node CJS interop 掩盖了)→ feishu.ts 用 namespace import + default fallback。
- `.github/workflows/publish-npm.yml`(`on: push: tags: ["v*"]` + 手动 dispatch)→ `npm publish`,认证用 **repo secret `NPM_TOKEN`**(npm granular token,带 @nanhara publish 权限 + 2FA bypass,CI 答不了 OTP)。idempotent:版本已在 npm 就绿着退出。
- `release.yml`(同 `v*` tag)→ bun 交叉编译 binaries 挂到 GitHub Release(install.sh 用)。

验证:`npm view @nanhara/hara version --registry https://registry.npmjs.org/`;看 CI:`gh run list --workflow publish-npm.yml`。

**⚠️ 本地绝对别 `npm publish`、别找 token**(2026-07-01 我在这浪费了一大圈,Jeff 两次纠正"不TOKEN"/"这不是用token传的"):
1. 全局 registry = `registry.npmmirror.com`(国内镜像,**只读**)→ `npm publish` 报 `ENEEDAUTH`。
2. 就算加 `--registry https://registry.npmjs.org/`:项目根 `.npmrc` 写死 `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`,本地 `NPM_TOKEN` 未设时会用**空值覆盖** `~/.npmrc` 的登录态 → publish/whoami 全 401/404。(Jeff 老历史里那句 `mv .npmrc .npmrc.bak; npm publish` 就是手动绕这个覆盖。)
3. `~/.npmrc` 里的 npmjs token 会过期(常态 401),Jeff 本地平时靠 `npm login`(交互)——但**发版不靠本地**,靠 CI tag。

**哪些 repo 走这套(2026-07-01 查证)**:
- **npm 包 → tag `v*` 触发 CI 发 npm**:`hara-cli`(`@nanhara/hara`)+ `hara-design`(`@nanhara/hara-design`,现 0.3.1,zero-dep,`publish-npm.yml` 触发器/NPM_TOKEN 全同 cli)。
- **服务/站点 → 不发 npm**:`hara-control`(⭐**开源** public repo + Apache-2.0,和 cli/design 同属开源核;`package.json` 的 `private:true` **只是禁 npm publish 的保险,与开闭源无关** —— NestJS+Prisma/Postgres 有状态服务不是包)。**2026-07-01 定:hara-control 不发 npm,发布走 GHCR 容器镜像**——已建 `Dockerfile`(多阶段,node:22-slim,build-test 过,603MB)+ `.github/workflows/publish-image.yml`(tag `v*` → 推 `ghcr.io/hara-cli/hara-control`,用内置 GITHUB_TOKEN,`packages:write`,和 cli 的 tag→CI 对称只是产出镜像;⚠️首次推是 private package,需去 org Packages 设 public 一次)。自用仍可 `deploy/nanhara-tech/deploy-ai.sh`(dockerless rsync→npm ci→build→migrate deploy→pm2,推 ai box `gw.nanhara.tech` 127.0.0.1:4100);镜像是给开源自托管者。⚠️**hara-control 默认分支是 `master` 不是 `main`(cli 是 main)**。现状(2026-07-01):**v0.1.1 多架构镜像(linux/amd64+arm64)已发、Public、匿名可拉** `docker pull ghcr.io/hara-cli/hara-control:0.1.1`(或 `:latest`)。两个踩过的坑:①**镜像 Public ≠ 仓库 Public**——GHCR package 有独立 visibility,且 org `hara-cli` 默认禁 Public package,得先在 **org Settings→Packages** 放开"Package creation: Public",再去 package settings 设 Public;②**默认单架构**——`build-push-action` 不给 `platforms` 只出 runner 本架构(amd64),arm64 拉不到;workflow 已加 `docker/setup-qemu-action`+`platforms: linux/amd64,linux/arm64`,以后每个 tag 自动双架构(arm64 走 QEMU 模拟,慢几分钟)。hara-web(hara.run/docs.hara.run,`./deploy.sh all` 到 aimx-us1);hara-enterprise=闭源。
- **两个正交维度别混**:①开源/闭源(cli/control/design=开源,enterprise=闭源);②npm包/服务(cli/design=包→tag发npm,control/web=服务→deploy脚本)。`private:true` 属②不属①。规律:**scoped 公开 npm 包才打 tag 发 npm;服务/站点走部署脚本**。

相关:[[reference_hara_repos_structure]]、[[reference_nanhara_tech_test_gateway]]、[[project_hara_run_website]]、[[project_hara_backlog]](其"npm发版"待办即此)、[[feedback_hara_sync_site_and_docs]]。

---

## reference_hara_global_install_symlink

**摘要**：全局 hara 命令是软链到仓库 dist/,npm run build 即更新,无需 reinstall

全局 `hara` 命令(`~/.nvm/versions/node/v22.22.3/bin/hara`)**软链直指仓库** `~/work/projects/hara/hara-cli/dist/index.js`(不是拷贝)。

**推论(每次 hara-cli 收口省一步)**:改完代码 `npm run build` 后,全局 `hara` **立即生效**,不必再 `npm install -g .`(它会显示 "up to date" 且本就无需拷贝)。验证全局是否带某改动:直接 grep `dist/` —— 注意 tsc 是**逐文件产物**,TUI/header 在 `dist/tui/App.js`,命令在 `dist/index.js`,别只 grep index.js。

仓库结构见 [[reference_hara_repos_structure]];状态见 [[project_hara_backlog]]。

---

## reference_hara_repos_structure

**摘要**：hara 多 repo 结构(2026-06-28 另一窗口重组):ai/→hara/,5 repo 开源核+闭源企业层;auth/RBAC 落 hara-control(开源)

2026-06-28 另一窗口把 hara 全家从 `~/work/projects/ai/hara*` **移到 `~/work/projects/hara/`**(旧 `ai/` 路径全失效;很多旧 memory 里的 `ai/hara-*` 路径需脑补替换 `ai`→`hara`,引用前先 ls 确认)。关联 [[project_oss_agent_cli]] [[reference_nanhara_tech_test_gateway]] [[project_hara_run_website]] [[project_hara_port_roadmap]]。

**5 个 repo(open-core 拆分)**:
- `hara-cli`(Apache 开源)= CLI 本体 + 整个治理/org 层(role routing / dispatcher / SSOT / HITL / cron)。我的 TUI input fix `7c2008c` 在这(随移动保留)。
- `hara-control`(**Apache 开源**,relicensed `bce54b3`)= 控制面引擎:enroll / token 签发·吊销 / fleet view / proxy / **audit primitives(hash-chain)** / org-unit 层级。NestJS + Prisma + RDS PG。
- `hara-enterprise`(**闭源 Proprietary**,license-gated,不发公共 npm)= 付费层,作为 **hara 插件**加载(贡献 skills + MCP `mcp__enterprise__*`);ROADMAP stub→真:**sso(OIDC/SAML+SCIM)、rbac(org 级策略)、audit-export、fleet(跨舰队/spend 仪表盘)**。
- `hara-design`(插件)= design-in-CLI(138 设计系统→HTML 浏览器预览)。
- `hara-web`(私有)= hara.run 官网 + docs.hara.run([[project_hara_run_website]])。

**⚠️关键架构原则(hara-enterprise/ROADMAP.md)**:**auth 模块 + RBAC governance 落在 `hara-control`(开源)**,hara-enterprise 只做**薄 gate**(`sso_status`/`rbac_check`)+ 托管面 UI/API —— "重活在 hara-control,enterprise 只 wire/gate"。开源核必须独立可用,enterprise = 加分/规模/托管,绝不阉割 OSS 核。

**admin 超管+登录(2026-06-28 Jeff 问 → 决定 HOLD)**:hara-control admin 现仅 shared key(`x-admin-key`,`AdminKeyGuard`),**无登录/超管/RBAC/UI**。按 enterprise roadmap,超管+登录 = "hara-control auth module"(开源,SSO gate 的地基)→ 建在 hara-control 对。但另一窗口正 **live 重组**这些 repo,**Jeff 拍板先 HOLD + 跟另一窗口对齐**(避免重复/撞车,确认谁建 hara-control auth module)。我已写好 auth 代码(AdminUser Prisma 模型 + `node:crypto` scrypt 密码 + HS256 JWT + `/auth/login` + `/auth/bootstrap-superadmin`(shared-key gated)+ `AdminAuthGuard` 收 shared-key|JWT + cli `create-superadmin`),**未落地**(等对齐;落地走 `~/work/projects/hara/hara-control`,无新 npm 依赖)。

**✅ auth spec 已落 `hara-control/docs/AUTH_SPEC.md`(2026-06-28,给另一窗口照建)**:刻意做薄。**Phase1(现在建=地基)**:`User`{email,passwordHash,role,orgId,personId?,disabledAt?,totpSecret?(seam)}+3角色 RBAC(SUPERADMIN/ADMIN/MEMBER);scrypt+HS256 全 `node:crypto` 零新依赖、无状态(吊销靠 disabledAt 非 denylist);`/auth/login`+`/auth/bootstrap-superadmin`(shared-key gated,仅 user==0)+`create-superadmin` CLI;**back-compat 旧 `x-admin-key`=SUPERADMIN**(迁移期不断);限流+审计+/admin 网络锁。**Phase2(暂缓到首个自部署客户≥~10人)**:`hara login` 设备流(**RFC 8628**,抄 gh/codex,headless 友好)→ 产物=同一个 org.json device token(provider 层零改);**输公司 URL 那步绕不开**(每家自部署域名/IP 不同,=`gh auth login --hostname`,positional/交互/存 org.json 不再问)。**Phase3(企业层 hara-enterprise 薄 gate)**:OIDC/SAML→IdP + SCIM。**🔑 2FA 决策=不内建**(TOTP 注册/恢复码复杂度不值,**MFA 委托给 SSO/IdP**=正确归宿,留 totpSecret seam 以后可加)。**CLI 面**:`setup`(BYOK)/`enroll --code`/`login`(公司)/`logout`/`whoami`;**provider 优先级 org.json>config.json**(B 端优先于个人 key)。鲁班务实判断:auth 地基该建(hara-control 生产可用门槛),`hara login` 设备流暂缓(enroll-code 在南荒<20人规模够,符合产品第一/不做线下销售)。

**✅✅ auth 模块 + web 控制台 已建+部署+验证(2026-06-28,Jeff 拍板"连 web 后台一起建")**:鲁班建(我审+部署)—— `crypto.ts`+scrypt/HS256、`AdminUser`+`AdminRole`、`src/auth/*`(`/auth/login`→JWT 8h、`/auth/bootstrap-superadmin` shared-key+count==0、`/auth/me`、`/admin/users` CRUD SUPERADMIN)、`AdminAuthGuard`(收 **JWT 或 x-admin-key**,`@Roles` RBAC SUPERADMIN≥ADMIN≥MEMBER,旧 admin.controller/roles.controller 的 guard 已换)、`cli/create-superadmin.ts`、**`public/console/index.html`**(单页 vanilla JS 控制台,登录→建org/发码/fleet+吊销/管账号,全 escapeHtml 防 XSS)。零新依赖、65 测试过、build 绿。**部署**:box hara-control **整体从 R1-era 升到当前 repo**(`migrate deploy` 补 4 迁移 audit_hash_chain/device_token_ttl/secrets_store/org_hierarchy + 我的 add_admin_user,**全 additive 无数据丢失**)+ prisma generate + nest build + `pm2 restart --update-env`;**升完 DeepSeek 网关仍通**(hara -p 验过)。控制台 = **`/console/`**(`useStaticAssets(public/console, prefix /console)`;HOST=127.0.0.1 localhost-only → 走 `ssh -fNL 14100:127.0.0.1:4100 ai` 开 http://localhost:14100/console/)。全流程自测过(bootstrap→密码登录→JWT→/auth/me→JWT-RBAC /admin/users→删,count 归0)。⚠️坑:email 走 `@IsEmail`(要合法格式,`x@local` 会 400);console 静态根必须 `public/console`(否则 /console/ 404 落到 /console/console/);**2FA 仍不内建**(走 SSO)。下一步=Jeff 建自己超管(curl 或 `cli/create-superadmin.ts`)+ 登录;可选 IP 锁定公网入口免隧道。

**✅ 公网控制台上线(2026-06-28)**:超管 `admin@nanhara.tech`(SUPERADMIN,Jeff 改密)已建。**公网入口 `https://console.nanhara.tech/console/`**(alidns A→112.124.201.107 RecordId 2071128170992473088 + nginx vhost `console.nanhara.tech.conf`:`/console`+`/auth`+`/admin`→127.0.0.1:4100,wildcard *.nanhara.tech cert,`/`→302 /console/,其余 404)。**🔒 关键:公网 vhost `proxy_set_header x-admin-key ""` 剥离共享 key** → 公网只能走密码/JWT,shared-key SUPERADMIN 旁路只剩 localhost/隧道(实测:真 key 走公网→401)。验证全过(/console 200、公网登录出 JWT、strip 生效)。**2FA(TOTP)代码已建好(crypto genTotpSecret/totpUri/verifyTotp + /auth/2fa/setup|enable|disable + login 2-step + console Security 区,手动密钥+otpauth URI 无 QR 库,零依赖,build 绿)但 Jeff 定"前期不用"→未部署**(部署=同步 src+rebuild+restart,totpSecret 列已在无需迁移)。⚠️公网+仅密码,建议尽快上 2FA。内部部署=直接用 IP `http://<内网IP>:4100/console/` 或内部 DNS,不需域名(console origin 相对)。

**✅ 控制台重设计 + 2FA 后端上线(2026-06-28,顾雅 方案 C)**:把 Metronic 蒸馏成**轻量单页设计系统**(零依赖、零构建、自托管字体)重做控制台 —— dark sidebar + Overview KPI 首屏 + 5 视图(Orgs/Fleet/Enroll/Users/Security)+ **i18n EN/简/繁**(`public/console/i18n/{en,zh-CN,zh-TW}.js` dict-per-file,180 键三语全平,`[EN|简|繁]` 切换器 localStorage 记忆,结构支持随时加 ja/ko)+ 2FA Security 区(vendored QR 库 `lib/qrcode.min.js`)。352K 全自包含,旧裸页备份 `_legacy_index.html`。**2FA(TOTP)后端已随这次一起部署到 box,但默认关**(Jeff 定"前期不用"→ 在 Security 区自助开;公网控制台建议开)。⚠️ Overview 的 Devices/Activity KPI 待后端 stats 端点(engineering TODO);CJK 用系统字体回退(不发 Noto 5MB)。部署=rsync `public/console`+`src` → `npm run build` → `pm2 restart`;网关验过仍通(hara -p →DeepSeek OK)。多语言可加门类参考 [[reference_nanhara_tech_test_gateway]] 思路:一语言一 dict 文件 + 社区 PR。

**✅ hara-cli profile 层(2026-06-28,已建已验,未 commit)= "为组织而生 + 不失个人 + 随时切"**:统一 profile 抽象取代割裂的 `config.json`/`org.json` —— `~/.hara/profiles.json {active, profiles[]}`,**个人(byok)+ 组织(gateway)平级**,启动自动迁移旧 `org.json`(留 `.legacy`)+ 自动建 personal;real 网关聊天向后兼容(迁移后照样 DeepSeek)。**nvm 对标命令**(鲁班分析):`hara profile ls/use/add/rm`(+`uninstall` alias;**不加 install** —— add 更准)、`profile current`/`whoami`、`HARA_PROFILE` env / `--profile` flag 单次覆盖。**`.hara-profile` 项目钉选(学 .nvmrc)**:cd 进工作 repo 自动切对应组织 profile,个人项目回 personal;优先级 `--profile` > `HARA_PROFILE` > `.hara-profile`(向上 findUp 到 $HOME) > `active` > personal;`hara profile pin/unpin`;`.hara-profile` **不 commit**(个人身份,跟 .nvmrc 相反)。**来源永远显眼**:whoami/ls 标 `(active · pinned by ./…/global default/HARA_PROFILE env/--profile flag)`,杜绝"以为个人 key 其实跑组织网关"。**删除规则**:personal 不可删(报错引导切走),组织可删(本地删 + fallback personal + 提示 token 仍在网关找 admin 吊销,**不远程吊销**)。`npm test` 298/298。⚠️**已知 bug**:`profile use` 的 BYOK→gateway 确认走 Ink TUI,**非 TTY(脚本/CI)会崩**(交互正常)——待修(非 TTY 优雅降级)。**P1 缓**:组织内多模型 `models[]`(enroll code 单 model → 白名单;litellm.adapter 那行已传数组只塞一个)。代码:`hara-cli/src/profile/profile.ts`(resolveActive/findPinnedProfile)+ `src/index.ts`(命令 + preAction hook 接 --profile)。**✅ 已收口 + 推送(2026-06-29)**:hara-cli main `be18453`(profile 层 + session-model)+ `c573a5e`(**B.P0 todo 实时清单 panel + spinner 显当前步 activeForm + A.P0 `reasoningEffort` off/low/medium/high 档位[anthropic thinking-budget,adaptive-only 模型退化不 400 / openai o-series reasoning_effort,off→minimal] + 非 TUI reasoning 渲染修复**)→ push `github hara-cli/hara` + `npm install -g .` 装好(`hara`=global @nanhara/hara,reinstall 从 repo)。**hara-control** master `3538322`(auth+console+2FA+DeepSeek+selfhost docs)→ push `github hara-cli/hara-control`(box 早已 rsync 部署运行)。⚠️另一窗口在做 **hara-design**(与 hara-control 无关,Jeff 2026-06-29 澄清,故 hara-control master 可直接 merge)。P1 缓:组织内多模型 models[] / `hara plan` TUI 化 / `/thinking` slash / todo 持久化。

问"hara repo 结构 / ai→hara 移动 / hara-enterprise / hara-control auth / 超管登录 / 多 repo"看此条。

---

## reference_hara_auth_docs_model

**摘要**：hara 的\"接模型\"心智模型 + 官网文档结构 + 设计工具命名(个人 BYOK vs 组织网关;EN 零中文;Play)

2026-06-30 定稿(Jeff 多轮迭代)。hara 怎么"接一个模型"+ docs.hara.run 怎么讲。关联 [[project_oss_agent_cli]] [[project_hara_run_website]] [[project_hara_design]] [[reference_hara_repos_structure]] [[project_hara_backlog]]。

**核心原则:hara 不是模型供应商**(不像 codex/claude=自家就是 provider,登进去就有模型)。所以"接模型"不是"登录 hara",分两维、可切换的 profiles:

- **个人(Personal)= BYOK 配置,不是 login。** 命令 `hara setup`(交互:选 provider → 填 key → 选 model)。v0.96.0 起 provider 是编号菜单:Anthropic/OpenAI/GLM/DeepSeek/Qwen/OpenAI-compatible(自定义 base URL)/Qwen-free-OAuth;key **打码输入** + 一次 validation ping;GLM/DeepSeek/openrouter 进了 `PROVIDER_DEFAULTS`(OpenAI 兼容预置 base URL)。`hara login qwen`(免费 Qwen OAuth)只是**其中一个选项,不是头牌**——文档别再 Qwen-first。学了 openclaw `onboard` + Hermes `setup.py`(都把"接模型"当 config,不是"登录我们")。
- **组织(Organization/Enterprise)= 加入公司网关,自己一页讲**(docs 的 Organization Edition,产品差异点:codex/claude 只有个人)。**今天只支持 code-paste**:admin 在 console 铸一次性 code(`/admin/enroll-codes`)→ 用户 `hara enroll <gateway-url> --code <code>` → `/v1/enroll` 换短 TTL device token(从不下放真 provider key)。
- **切换**:`hara profile list` / `hara profile use <id>` / `pin`。

**Jeff 想要的企业登录(URL→登录→下放 key,或 portal 登录拿 code 再输入)= 设备码流程,已 specced 但未实现。** 权威 spec 在 `hara-control/docs/AUTH_SPEC.md`:Phase 1(User+Role/`/auth/login`/JWT/RBAC,**前置**)+ Phase 2(RFC8628 设备流:`hara login <gateway-url>` → 显示 user_code+URL → 浏览器登录确认 → CLI 轮询 → 网关 mint device token;端点 `/auth/device/code`+`/auth/device/token`+`/devices/self-enroll`)。我加了"实现 seam":把 `enroll.service.ts` 的发 token 尾部抽成 `issueDeviceToken()` 给 `/v1/enroll` 和 `/devices/self-enroll` 共用,绑定步复用 `/auth/login`。两个 Phase 都**只 specced、未 build**(Phase 1 是前置)。要建时:hara-cli 客户端我能独立做(不撞);hara-control 端点是 Jeff 活跃区,先对齐排期。

**文档铁律**:
- **英文文档零中文**(读者是非中文用户)。连 "通义千问" 都不能出现在 en/(写 "Qwen account")。语言切换器 locale-aware:EN 页显示 "EN | ZH",ZH 页 "EN | 中文"(`docs/components/ui/lang-switch.tsx` 用 `LABEL[current][locale]`)。ZH 是完整翻译。
- 部署:`pnpm -C docs build` → `rsync -az --delete out/ aimx-us1:/home/wwwroot/docs-hara-run/`;分支 **main**;校验 `grep -rl '[一-鿿]' out/en/` 必须空。

**设计工具命名**:交互模式 真机/Device 全局改名 **"Play"(▶ Play)**——平台无关(web/PC 不是"设备");grid 旁边那个"打开单屏点着走流程"的模式。已落 proto.js/css/md + server.mjs + SKILL + docs(hara-design `master`)。

---

## reference_cc_reverse_agent_thinking_for_hara

**摘要**：analysis_claude_code(shareAI 逆向 CC v1.0.33)深读结论:hara 该抄的 agent 思考机制清单(reminder注入/压缩后文件恢复/摘要补段/阈值阶梯),已有等价的别重做

2026-07-02 深读 `~/work/projects/agent/analysis_claude_code`(shareAI-lab 逆向 CC v1.0.33,180 篇文档,自认非 100% 准确)得出 hara 的"agent 思考"改进清单。

**hara 已有等价、别重做**:主循环(failover/工具级错误隔离/stuck-guard/guardian 断路器)≈CC nO;`pendingInput` steering≈CC h2A(都是消息级注入,h2A 双缓冲队列是过度工程);`mapLimit` 并发+spawn 只读≈CC UH1(max10);自动压缩 85%+6 段摘要+workingSet≈CC wU2 基本盘。

**清单进度(hara 0.100.0 已落地 ①③,2026-07-02)**:
1. ✅**system-reminder 事件注入层** — `agent/reminders.ts`(队列+wrap+免干扰声明),loop 每轮 pendingInput 后注入;quiet(子agent)不 push 不 drain 防偷 reminder;**todo 陈旧刷新**已接(未完成项 5 轮没动→重展权威清单,todo_write 重置,触发后重臂)。后续事件(文件外部变更/诊断)走 pushReminder 即插。
2. ✅**压缩后文件恢复**(0.104.0)— `agent/touched.ts` 跟踪主循环文件工具触碰(quiet 子代理不计);compactConversation 摘要后附回 top-5 最近文件当前内容(8KB/文件、24KB 总帽、截断标注);`buildFileRestore` 在 agent/compact.ts 可测。
3. ✅**压缩摘要 6→8 段** — COMPACT_SYSTEM 移到 agent/compact.ts(可测),新增 "All user messages"(逐字按序保留,防漂移)+ "Key technical concepts"。
4. ✅**阈值阶梯 + 缓存感知**(0.104.0)— footer ctx% ≥60 黄/≥80 红(85 压缩);⭐**Anthropic input_tokens 不含 cache 读写,曾致缓存会话 ctx% 严重低报、自动压缩永不触发** —— provider usage 已改为 input+cache_creation+cache_read 全口径(CC zY5)。
5. ✅**合成器模式**(0.105.0,hara 形态)— 不建专职 merger agent,骑 reminder 层:一轮 ≥3 个并行 agent 报告(SYNTHESIS_MIN_AGENTS)→ 注入"先合成再行动"提醒(显式调和冲突/标注单源发现/给合并结论)。

**清单 5/5 全部落地(2026-07-02),本学习源闭环。**

⚠️测试坑(已修):org.test 对 loadRoles 做 deep-equal,会被机器上真实 `~/.hara/roles`(那 10 个转换角色)污染——测试文件开头 `process.env.HOME=mkdtemp(...)` 隔离(os.homedir() 尊重 $HOME)。

不抄:6 层权限链(hara 现有栈够)、h2A 本体、自适应提示频率。推荐只采信仓库 🟢 源码确认项,🟡🟠 推测(资源预算数值等)未纳入。

CC 8 段摘要结构备查:Primary Request and Intent / Key Technical Concepts / Files and Code Sections / Errors and fixes / Problem Solving / All user messages / Pending Tasks / Current Work & Next Step(含逐字引用)。

相关:[[reference_hara_claude_agents_interop]]、[[project_hara_backlog]]、[[reference_hara_release_via_tag_ci]]。
