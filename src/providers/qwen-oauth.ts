// Qwen "Qwen Code" free-tier OAuth (device-code + PKCE), ported from OpenClaw's qwen-portal-auth.
// Token (access/refresh/resource_url) is stored in ~/.hara/qwen-oauth.json and auto-refreshed.
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

const BASE = "https://chat.qwen.ai";
const DEVICE_CODE_URL = `${BASE}/api/v1/oauth2/device/code`;
const TOKEN_URL = `${BASE}/api/v1/oauth2/token`;
const CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
const SCOPE = "openid profile email model.completion";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_BASE_URL = "https://portal.qwen.ai/v1";

export interface QwenToken {
  access: string;
  refresh: string;
  expires: number; // epoch ms
  resourceUrl?: string;
}

function tokenPath(): string {
  return join(homedir(), ".hara", "qwen-oauth.json");
}

export function loadQwenToken(): QwenToken | null {
  const p = tokenPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as QwenToken;
  } catch {
    return null;
  }
}

function saveQwenToken(t: QwenToken): void {
  const p = tokenPath();
  mkdirSync(join(homedir(), ".hara"), { recursive: true });
  writeFileSync(p, JSON.stringify(t, null, 2) + "\n", "utf8");
}

const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/** resource_url → a clean https base ending in /v1 (default portal.qwen.ai). */
export function normalizeBaseUrl(v?: string): string {
  const raw = (v && v.trim()) || DEFAULT_BASE_URL;
  const withProto = raw.startsWith("http") ? raw : `https://${raw}`;
  return withProto.endsWith("/v1") ? withProto : `${withProto.replace(/\/+$/, "")}/v1`;
}

/** Device-code login. Prints the verification URL via `log`, polls until approved. */
export async function qwenDeviceLogin(log: (m: string) => void): Promise<QwenToken> {
  const { verifier, challenge } = pkce();

  const dc = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
  });
  if (!dc.ok) throw new Error(`device-code request failed: ${dc.status} ${await dc.text()}`);
  const dev = (await dc.json()) as any;
  if (!dev.device_code || !dev.verification_uri) throw new Error("incomplete device authorization payload");

  const url = dev.verification_uri_complete || dev.verification_uri;
  log(`Open this URL in your browser and approve access:\n\n    ${url}\n\n  (if prompted, enter code: ${dev.user_code})\n\nWaiting for approval…`);

  let wait = (dev.interval || 2) * 1000;
  const deadline = Date.now() + (dev.expires_in || 300) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait));
    const tr = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: DEVICE_GRANT,
        client_id: CLIENT_ID,
        device_code: dev.device_code,
        code_verifier: verifier,
      }),
    });
    if (tr.ok) {
      const t = (await tr.json()) as any;
      if (t.access_token && t.refresh_token) {
        const tok: QwenToken = {
          access: t.access_token,
          refresh: t.refresh_token,
          expires: Date.now() + (t.expires_in || 3600) * 1000,
          resourceUrl: t.resource_url,
        };
        saveQwenToken(tok);
        return tok;
      }
    } else {
      let err: any = {};
      try {
        err = await tr.json();
      } catch {
        /* ignore */
      }
      if (err.error === "authorization_pending") continue;
      if (err.error === "slow_down") {
        wait = Math.min(wait * 1.5, 10000);
        continue;
      }
      throw new Error(`token poll failed: ${err.error_description || err.error || tr.status}`);
    }
  }
  throw new Error("Qwen OAuth timed out waiting for approval.");
}

async function refreshToken(tok: QwenToken): Promise<QwenToken> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh, client_id: CLIENT_ID }),
  });
  if (!r.ok) throw new Error(`Qwen token refresh failed (${r.status}) — re-run \`hara login qwen\`.`);
  const t = (await r.json()) as any;
  if (!t.access_token) throw new Error("refresh response missing access_token");
  const next: QwenToken = {
    access: t.access_token,
    refresh: t.refresh_token || tok.refresh,
    expires: Date.now() + (t.expires_in || 3600) * 1000,
    resourceUrl: tok.resourceUrl,
  };
  saveQwenToken(next);
  return next;
}

/** Valid access token + baseURL, refreshing if within 60s of expiry. null if not logged in. */
export async function getValidQwenAuth(): Promise<{ accessToken: string; baseURL: string } | null> {
  let tok = loadQwenToken();
  if (!tok) return null;
  if (Date.now() > tok.expires - 60_000) tok = await refreshToken(tok);
  return { accessToken: tok.access, baseURL: normalizeBaseUrl(tok.resourceUrl) };
}
