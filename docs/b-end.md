# B-end: fleets + control plane (design)

hara's C-end is a solo coding agent. The B-end turns it into a **governed fleet**: a company runs many
hara devices, each pointed at a **gateway** that holds the real provider keys and gives the org visibility
+ control. This doc is the working design; it tracks what's built and what's next.

## Principle (from the strategy doc)

Split the **data plane** (the LLM proxy — protocol conversion, routing to N backends, key vault) from the
**control plane** (`hara-control` — device registry, token lifecycle, fleet view, governance, audit).

- **Data plane = buy/embed.** It's a fast-moving commodity; embed a mature OSS gateway (Phase-1: LiteLLM,
  Apache/MIT) behind a thin adapter. Never fork it.
- **Control plane = build + 100% own (TS).** This is the product, the moat, the open-core paid layer.

**Core invariant:** the real provider key lives ONLY at the gateway. A device holds a scoped, revocable
**device token** — never an upstream key.

## Topology

```
hara device (provider=hara-gateway, token in ~/.hara/org.json, NO real key)
      │  OpenAI-compatible /v1, Bearer <device_token>
      ▼   (private net — Tailscale/WG)
hara-gateway = hara-control (thin shell: enroll/heartbeat/fleet/audit) + data-plane engine (LiteLLM)
      │  real provider key (Vault/env)
      ▼
cloud models  /  internal vLLM·Ollama
```

## Protocol (device ↔ gateway)

- `POST {gateway}/v1/enroll`  `{code, device:{name,os,hara_version}}` → `{device_token, device_id, model, base_url?}`
- `POST {gateway}/v1/heartbeat`  Bearer `<device_token>`  `{device_id, name, os, hara_version}` → 200/204
- `POST {gateway}/v1/chat/completions`  — the normal agent traffic, OpenAI-compatible, Bearer `<device_token>`
- Revocation: the gateway 401s a revoked token; hara surfaces it as an auth error → re-enroll.

## Status

**✅ Built (this repo — the OSS client side, v0.66):**
- `hara enroll <gateway-url> --code <code>` / `--status` / `--clear` — `src/org-fleet/enroll.ts`.
- `hara-gateway` provider (`buildProvider` → OpenAI-compatible client at the gateway with the device token).
- Device token + endpoint in `~/.hara/org.json` (0600); heartbeat fired on interactive start (fire-and-forget).
- Protocol verified end-to-end against a stub control plane (`test/enroll.test.mjs`).

**⬜ Next — `hara-control` (a SEPARATE repo; the paid control plane):**
1. **Phase 0 spike:** stand up LiteLLM (docker) on a private net + one cloud model + one virtual key; point a
   hara device at it with `provider=openai, baseURL=<gw>` (zero code) to validate `/v1` streaming + tool
   calls end-to-end before building anything.
2. **Phase 1 MVP:** `hara-control` v0 — enroll-code issuance → device-token mint (behind the LiteLLM adapter),
   device registry, `/v1/heartbeat`, `audit_log`, a read-only **fleet view** (which machine / who / today's
   tokens+cost / model / token status / revoke). Tailscale ACL; per-key budget + model scope.
3. **Phase 2:** OIDC/SSO enrollment + short-lived JWT (reuse the qwen-oauth RFC-8628 flow); one-click revoke;
   immutable audit; data-residency (repo_class → model_scope).
4. **Phase 3:** multi-tenant SaaS — orgs/Postgres/managed gateways; pushed org policy (roles/models/MCP);
   usage analytics / chargeback. The **company/public asset-sharing** dimension (team libraries, a public
   marketplace) lives here — the one asset axis the C-end deliberately defers behind a human-confirmed egress.

**open-core line:** the CLI + `hara-gateway` provider + enroll + heartbeat are OSS (a solo dev can self-host a
gateway and point at it). `hara-control` (fleet / SSO / audit / central token mgmt / multi-tenant) is the paid
layer.
