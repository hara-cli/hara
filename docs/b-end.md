# B-end: fleets + control plane (design)

hara's C-end is a solo coding agent. The B-end turns it into a **governed fleet**: a company runs many
hara devices, each pointed at a **gateway** that holds the real provider keys and gives the org visibility
+ control. This doc is the working design; it tracks what's built and what's next.

## Principle (from the strategy doc)

Split the **data plane** (the LLM proxy — protocol conversion, routing to N backends, key vault) from the
**control plane** (`hara-control` — device registry, token lifecycle, fleet view, governance, audit).

- **Data plane = buy/embed.** It's a fast-moving commodity; embed a mature OSS gateway (Phase-1: LiteLLM,
  Apache/MIT) behind a thin adapter. Never fork it.
- **Control plane = build + own (TS), shipped open-source (Apache).** A company can self-host the whole
  fleet + gateway (CLI **and** hara-control) for free. The moat is **operating** it (hosted/managed) +
  **enterprise plugins** (SSO/SCIM, org-scale RBAC, compliance) + curated governance content — not withheld code.

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

**`hara-control` (a SEPARATE repo — open-source Apache, self-hostable; see its `docs/selfhost.md` + `docs/AUTH_SPEC.md`):**
1. **Phase 0 spike — ✅ done.** LiteLLM proxies `/v1` streaming + tool calls end-to-end.
2. **Phase 1 MVP — ✅ done (built + dogfooded on a real gateway).** enroll-code → device-token mint (LiteLLM
   adapter), device registry, `/v1/heartbeat`, hash-chained `audit_log`, read-only **fleet view** (machine /
   who / today's tokens+cost / model / token status / revoke), org-unit hierarchy, per-key budget + model scope.
3. **Phase 2 — next.** Built-in accounts + login + **RBAC** (open; the self-host "super-user" floor) and a
   `hara login` **device flow (RFC 8628)** so devices self-onboard against a company URL — both spec'd in
   `hara-control/docs/AUTH_SPEC.md`. enroll-code already covers onboarding until then. **2FA is delegated to
   the IdP via SSO, not built in.**
4. **Phase 3 — hosted / enterprise.** Not a multi-tenant-SaaS rewrite — `Organization` is a self-referential
   tree (group → company → dept) that scales with no schema change. The paid bits live in **`hara-enterprise`**
   (loads as a plugin): SSO/SCIM, org-scale RBAC gate, compliance audit-export, cross-fleet dashboard — plus a
   hosted/managed control plane. The company/public **asset-sharing** dimension (team libraries / marketplace)
   also lands here.

**open-core line:** the CLI **and** `hara-control` are both **open-source (Apache) and self-hostable** — enroll,
heartbeat, token lifecycle, fleet view, audit, governance + auth/RBAC are all in the open, so a company can run
the entire fleet + gateway itself for free. The **paid layer is `hara-enterprise`** (SSO/SCIM, org-scale RBAC
gate, compliance export, cross-fleet dashboard) + the hosted/managed option. We monetize **operating** it, not
withholding it.
