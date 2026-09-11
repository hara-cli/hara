// Engine-owned connector credentials.
//
// The renderer may submit a credential once over the authenticated loopback protocol, but it never reads the
// stored value back. Model tools and subprocesses are likewise denied access to private ~/.hara state; they use
// the existing brokered gateway / cron delivery capabilities instead of receiving a raw secret.
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";

const STORE_FILE = "gateway-credentials.json";
const STORE_LOCK = "gateway-credentials";
const MAX_STORE_BYTES = 16 * 1024;
const FEISHU_APP_ID = /^cli_[A-Za-z0-9_-]{4,123}$/u;
const FEISHU_APP_SECRET = /^[^\s\u0000-\u001f\u007f]{8,512}$/u;

export type FeishuGatewayDomain = "feishu" | "lark";

export interface FeishuGatewayCredentialsInput {
  appId: string;
  appSecret: string;
  domain?: FeishuGatewayDomain;
}

export interface FeishuGatewayCredentials {
  appId: string;
  appSecret: string;
  domain: FeishuGatewayDomain;
}

interface GatewayCredentialFile {
  version: 1;
  feishu: FeishuGatewayCredentials;
}

export type FeishuGatewayCredentialInspection =
  | {
      state: "ready";
      source: "environment" | "stored";
      credentials: FeishuGatewayCredentials;
    }
  | {
      state: "missing" | "incomplete" | "unreadable";
      source?: "environment" | "stored";
    };

export interface FeishuGatewayCredentialSummary {
  configured: boolean;
  source: "stored" | "missing";
  domain?: FeishuGatewayDomain;
}

export interface InspectFeishuGatewayCredentialOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Tests and explicitly isolated callers can disable private-store fallback for an alternate env object. */
  allowStored?: boolean;
}

function normalizeDomain(value: unknown): FeishuGatewayDomain {
  if (value === undefined || value === "feishu") return "feishu";
  if (value === "lark") return "lark";
  throw new Error("Feishu domain must be 'feishu' or 'lark'");
}

function normalizeCredentials(input: FeishuGatewayCredentialsInput): FeishuGatewayCredentials {
  const appId = typeof input.appId === "string" ? input.appId.trim() : "";
  const appSecret = typeof input.appSecret === "string" ? input.appSecret : "";
  if (!FEISHU_APP_ID.test(appId)) {
    throw new Error("Feishu App ID must start with 'cli_' and contain only letters, numbers, '_' or '-'");
  }
  if (!FEISHU_APP_SECRET.test(appSecret)) {
    throw new Error("Feishu App Secret must be 8-512 non-whitespace characters");
  }
  return { appId, appSecret, domain: normalizeDomain(input.domain) };
}

function credentialBinding(home: string) {
  return bindPrivateHaraStateFile(home, [], STORE_FILE);
}

function parseCredentialFile(text: string): GatewayCredentialFile {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || Array.isArray(parsed) || parsed.version !== 1) {
    throw new Error("unsupported gateway credential store");
  }
  const feishu = parsed.feishu;
  if (!feishu || typeof feishu !== "object" || Array.isArray(feishu)) {
    throw new Error("missing Feishu gateway credential record");
  }
  const record = feishu as Record<string, unknown>;
  return {
    version: 1,
    feishu: normalizeCredentials({
      appId: typeof record.appId === "string" ? record.appId : "",
      appSecret: typeof record.appSecret === "string" ? record.appSecret : "",
      domain: normalizeDomain(record.domain),
    }),
  };
}

function inspectStoredCredentials(home: string): FeishuGatewayCredentialInspection {
  try {
    const binding = credentialBinding(home);
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_STORE_BYTES);
    if (!snapshot) return { state: "missing" };
    return {
      state: "ready",
      source: "stored",
      credentials: parseCredentialFile(snapshot.text).feishu,
    };
  } catch {
    // Status surfaces must never echo a path, raw JSON, or parser detail from the credential store.
    return { state: "unreadable", source: "stored" };
  }
}

/** Resolve one complete credential record. Environment values are an all-or-nothing override and are never
 * mixed with the private store, which prevents an App ID from one tenant pairing with another tenant's secret. */
export function inspectFeishuGatewayCredentials(
  options: InspectFeishuGatewayCredentialOptions = {},
): FeishuGatewayCredentialInspection {
  const env = options.env ?? process.env;
  const appId = env.HARA_FEISHU_APP_ID;
  const appSecret = env.HARA_FEISHU_APP_SECRET;
  const present = Number(Boolean(appId?.trim())) + Number(Boolean(appSecret?.trim()));
  if (present > 0) {
    if (present < 2) return { state: "incomplete", source: "environment" };
    // Preserve the gateway's long-standing environment contract: a trusted launcher may supply any
    // non-empty vendor credential pair, and the vendor remains the authority on its exact format.
    // Strict validation is reserved for values newly accepted through the Desktop settings RPC.
    return {
      state: "ready",
      source: "environment",
      credentials: {
        appId: appId!.trim(),
        appSecret: appSecret!,
        domain: env.HARA_FEISHU_DOMAIN === "lark" ? "lark" : "feishu",
      },
    };
  }

  const allowStored = options.allowStored ?? env === process.env;
  return allowStored ? inspectStoredCredentials(options.home ?? homedir()) : { state: "missing" };
}

/** Save or replace one complete Feishu credential. The safe return value deliberately contains no identity
 * or secret, and the private writer enforces a real owner-only file plus compare-and-swap replacement. */
export function saveFeishuGatewayCredentials(
  input: FeishuGatewayCredentialsInput,
  home: string = homedir(),
): FeishuGatewayCredentialSummary {
  const credentials = normalizeCredentials(input);
  return withPrivateStateLockSync(home, [], STORE_LOCK, () => {
    const binding = credentialBinding(home);
    const existing = readPrivateStateFileSnapshotSync(binding.path, MAX_STORE_BYTES);
    const serialized = `${JSON.stringify({ version: 1, feishu: credentials } satisfies GatewayCredentialFile, null, 2)}\n`;
    writePrivateStateFileSync(binding, serialized, existing
      ? { expectedText: existing.text }
      : { expectedMissing: true });
    return { configured: true, source: "stored", domain: credentials.domain };
  }, { busyMessage: "Feishu credential settings are busy; retry shortly" });
}

/** Remove only the exact private file observed while holding the credential-store lock. Environment-provided
 * credentials are outside this store and therefore cannot be deleted or rotated through Desktop. */
export function removeStoredFeishuGatewayCredentials(home: string = homedir()): FeishuGatewayCredentialSummary {
  return withPrivateStateLockSync(home, [], STORE_LOCK, () => {
    const binding = credentialBinding(home);
    const existing = readPrivateStateFileSnapshotSync(binding.path, MAX_STORE_BYTES);
    if (!existing) return { configured: false, source: "missing" };
    removePrivateStateFile(binding.path, existing, binding.directory);
    return { configured: false, source: "missing" };
  }, { busyMessage: "Feishu credential settings are busy; retry shortly" });
}
