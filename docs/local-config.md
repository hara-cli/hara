# hara — local configuration & requirements

Config lives in `~/.hara/config.json` (or env vars / `hara config set <key> <value>`). Only the LLM
provider is required; everything else has a sane default.

## Runtime
- **Node ≥ 22.23.1** (`engines` in package.json). Older Node releases exit before loading CLI dependencies
  and print an upgrade command. Or run the **standalone binary** (no Node) / **Docker image**.

## Required — the LLM provider
| key | what | example |
|---|---|---|
| `provider` | `anthropic` \| `qwen` \| `qwen-oauth` \| `openai` \| `glm` \| `deepseek` \| `openrouter` \| `ollama` \| `lmstudio` \| `hara-gateway` | `qwen` |
| `apiKey` | provider key (env fallback per provider, e.g. `ANTHROPIC_API_KEY`) | `sk-…` |
| `model` | default model | `glm-5` |
| `baseURL` | OpenAI-compatible base (for qwen/openai) | `https://…/v1` |

The built-in DeepSeek profile defaults to `deepseek-v4-flash` at `https://api.deepseek.com`. Official
`deepseek-v4-flash` and `deepseek-v4-pro` models use native, stateless Responses streaming, while explicit
custom or legacy ids are not silently remapped and remain subject to provider-side availability.
The complete local history is replayed on each Responses call, including function calls and outputs.
The model picker uses live discovery first and falls back to the two documented V4 ids only for the exact
official DeepSeek host.

## Optional
- **Advanced image fallback** (optional compatibility for attached images when the selected main model is text-only):
  `visionModel` / `visionBaseURL` / `visionApiKey` (default to the main provider). Prefer a main model with
  native image input. This fallback is not part of Presentation generation or its default validation path.
- **Semantic search / vectors** — see below: `embedProvider` (`off` \| `ollama` \| `qwen` \| `openai`) + `embedModel` / `embedBaseURL` / `embedApiKey`.
- **B-end fleet**: `hara enroll <gateway> --code <code>` → device token in `~/.hara/org.json` (0600); sets `provider=hara-gateway`.
- **Behavior**: `approval` · `sandbox` · `theme` · `evolve` · `assetCapture` · `computerUse`/`computerApps` · `hooks` · `notify` · `vimMode` · `mcpServers` · `HARA_MAX_CONCURRENCY` (parallel sub-agent/read cap, default 8).
  An `mcpServers.<name>.description` may provide a short non-secret capability hint so the lazy launcher can
  choose the relevant reviewed server without starting every configured external process.
- **Remembered project approvals**: choosing **always for this project** writes an opaque, owner-only grant
  to `~/.hara/project-approvals.json`. Grants bind to the canonical project directory identity and a narrow
  operation scope; the file never stores command text, Python source, file contents, or credentials. Bash is
  exact-command scoped, ordinary edits are exact-file scoped, `.tmp`/`logs`/`output` edits are directory
  scoped, and Python is an explicitly labelled project-wide execution scope. Computer Use and external
  extensions remain one-shot approvals; protected-file, deny and guardian checks always run first.
- **Local Agent capability roadmap**: calendar, semantic desktop automation, platform permissions,
  and the Desktop capability broker are defined in
  [`local-agent-capabilities.md`](local-agent-capabilities.md).
- **Network proxy**: provider/model calls, model discovery, remote embeddings, Qwen OAuth,
  organization enrollment/heartbeat and `web_fetch` / `web_search` honor `HTTPS_PROXY`, `HTTP_PROXY`
  (and lowercase forms), `NO_PROXY`, or `hara config set proxy http://127.0.0.1:7890`.
  `hara --proxy …` applies to both model and web-tool traffic for one launch. `HARA_MODEL_PROXY`
  is the model/organization-only override; `HARA_WEB_PROXY` remains web-tool-only. On Windows, Hara
  also reads an enabled static WinINET proxy and its bypass list when no explicit proxy exists. PAC-only
  and SOCKS-only configurations require an explicit HTTP(S) proxy. Loopback endpoints always bypass
  proxies, chat gateways are not redirected, and project `.hara/config.json` cannot choose the credential
  route. Authenticated proxy URLs and transport errors are masked; do not paste them into chat or logs.
  `web_fetch` keeps its public-DNS/IP pin and private-address rejection across every redirect.
- **Agent lifecycle**: `runTimeoutMs` defaults to `30m` (accepts `ms`/`s`/`m`/`h`, hard max `2h`) and
  `maxAgentRounds` defaults to `64` (hard max `256`). `runTimeoutMs` measures active model/tool execution:
  activity cannot renew it, while time spent waiting for an engine-owned human question or approval is
  excluded. Esc/shutdown still cancel immediately, and answering resumes the remaining budget rather than
  resetting it. `0`/invalid values do not disable safety. Equivalent environment overrides are
  `HARA_RUN_TIMEOUT_MS` and `HARA_MAX_AGENT_ROUNDS`. Read-only sub-agents use the tighter of the configured
  limit and `8m`/`24` rounds, and always inherit the parent's remaining active budget/cancellation. One-shot
  planner, verifier, compaction, naming, commit, guardian, and vision calls also have operation-specific hard
  deadlines even when a custom provider ignores `AbortSignal`.
- **Build/run**: `bun` (to build single-file binaries) · Docker (to run the container image).

## Semantic search & the local vector store (zvec)

Lexical search always works with zero dependencies — it's the floor. Semantic (vector) search is
**opt-in**: set `embedProvider` (+ model) to a local or remote embedder, then `hara index`.

- **Embedder is configurable, local OR remote** (not pinned):
  - local: `embedProvider=ollama`, `embedModel=nomic-embed-text` (runs on your machine, offline)
  - remote: `embedProvider=qwen`, `embedModel=text-embedding-v3` (via your gateway / DashScope)
- **Vector index = [zvec](https://www.npmjs.com/package/@zvec/zvec)** (`@zvec/zvec`), an in-process
  native vector DB. It's an **optionalDependency** — installed automatically *when a prebuilt binding
  exists for your platform*, and **silently skipped otherwise** (hara still installs and runs).

### zvec platform support
| platform | zvec | notes |
|---|---|---|
| macOS Apple Silicon (`darwin-arm64`) | ✅ prebuilt | |
| Linux x64 / arm64 | ✅ prebuilt | glibc-based (Alpine/musl may not match → falls back) |
| Windows x64 | ✅ prebuilt | |
| **macOS Intel (`darwin-x64`)** | ❌ no prebuilt | **falls back to the JSON store** |
| anything else | ❌ | falls back |

- **No build tools / compiler needed** — bindings are prebuilt (N-API). The binding is **~41 MB**
  (RocksDB-backed). To skip it: `npm i -g @nanhara/hara --omit=optional`.
- **Graceful fallback**: if zvec is absent or its native binding fails to load, semantic search uses a
  built-in **JSON brute-force cosine** store instead — same results, just O(N) per query. So zvec is
  never a hard requirement; it's a performance/scale upgrade where available.

## Deployment topologies (where this all runs)
1. **Local C-end** — you run hara-cli on your own machine; indexes/memory in `~/.hara`. (today)
2. **B-end fleet (self-deploy)** — the company runs **hara-control** (gateway/token/governance);
   each employee runs hara-cli on their own machine, enrolled to it. (built — separate closed repo)
3. **Hosted/centralized (future)** — hara runs on a company server, employees reach *their own*
   agent via an app. This is where the vector store + ANN matter most (large aggregate corpus, many
   sessions); it adds per-user server-side workspaces + an app front-end (a Phase-3 direction).
