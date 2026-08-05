export const ORGANIZATION_SERVICE_KINDS = [
  "MODEL_CONTROL",
  "DESK_TASKS",
  "COLLAB",
  "EXTENSION_CATALOG",
] as const;

export type OrganizationServiceKind =
  typeof ORGANIZATION_SERVICE_KINDS[number];
export type OrganizationServiceMode =
  | "HARA_HOSTED"
  | "CUSTOMER_HOSTED";
export type OrganizationServiceRegion = "CN" | "GLOBAL";

export interface OrganizationServiceBinding {
  tenantId: string;
  service: OrganizationServiceKind;
  mode: OrganizationServiceMode;
  accountRegion: OrganizationServiceRegion;
  apiOrigin: string;
  issuer?: string;
  jwksUri?: string;
  audience?: string;
  status: "ACTIVE";
  capabilitiesVersion: number;
  configVersion: number;
}

const SERVICE_KIND_SET = new Set<string>(ORGANIZATION_SERVICE_KINDS);
const SERVICE_MODE_SET = new Set<string>([
  "HARA_HOSTED",
  "CUSTOMER_HOSTED",
]);
const SERVICE_REGION_SET = new Set<string>(["CN", "GLOBAL"]);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const SAFE_TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_AUDIENCE = /^[A-Za-z0-9._:/-]{1,160}$/;
const SECRET_FIELDS = new Set([
  "credential",
  "credential_ref",
  "credentialRef",
  "enroll_key",
  "enrollKey",
  "token",
  "api_key",
  "apiKey",
  "secret",
]);

const isLoopback = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "[::1]"
    || normalized === "::1";
};

function normalizeUrl(
  value: unknown,
  field: string,
  originOnly: boolean,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string"
    || value.length > 2048
    || value !== value.trim()
    || CONTROL_CHARACTERS.test(value)
  ) {
    throw new Error(`enroll response contains an invalid ${field}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`enroll response contains an invalid ${field}`);
  }
  if (
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname)))
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (originOnly && parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new Error(`enroll response contains an invalid ${field}`);
  }
  return originOnly
    ? parsed.origin
    : parsed.toString().replace(/\/$/, "");
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1_000_000) {
    throw new Error(`enroll response contains an invalid ${field}`);
  }
  return Number(value);
}

function parseOne(value: unknown): OrganizationServiceBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("enroll response contains an invalid service_bindings");
  }
  const record = value as Record<string, unknown>;
  for (const field of SECRET_FIELDS) {
    if (Object.hasOwn(record, field)) {
      throw new Error(
        "enroll response service_bindings must not contain credentials",
      );
    }
  }
  const tenantId = record.tenant_id ?? record.tenantId;
  const service = record.service;
  const mode = record.mode;
  const accountRegion = record.account_region ?? record.accountRegion;
  const status = record.status;
  if (
    typeof tenantId !== "string"
    || !SAFE_TENANT_ID.test(tenantId)
    || typeof service !== "string"
    || !SERVICE_KIND_SET.has(service)
    || typeof mode !== "string"
    || !SERVICE_MODE_SET.has(mode)
    || typeof accountRegion !== "string"
    || !SERVICE_REGION_SET.has(accountRegion)
    || status !== "ACTIVE"
  ) {
    throw new Error("enroll response contains an invalid service_bindings");
  }
  const apiOrigin = normalizeUrl(
    record.api_origin ?? record.apiOrigin,
    "service_bindings api_origin",
    true,
  );
  if (!apiOrigin) {
    throw new Error("enroll response contains an invalid service_bindings");
  }
  const issuer = normalizeUrl(record.issuer, "service_bindings issuer", false);
  const jwksUri = normalizeUrl(
    record.jwks_uri ?? record.jwksUri,
    "service_bindings jwks_uri",
    false,
  );
  const audience = record.audience;
  if (
    audience !== undefined
    && audience !== null
    && (
      typeof audience !== "string"
      || audience !== audience.trim()
      || !SAFE_AUDIENCE.test(audience)
    )
  ) {
    throw new Error("enroll response contains an invalid service_bindings audience");
  }
  if (service === "COLLAB" && (!issuer || !jwksUri || !audience)) {
    throw new Error("enroll response contains an incomplete COLLAB service binding");
  }
  return Object.freeze({
    tenantId,
    service: service as OrganizationServiceKind,
    mode: mode as OrganizationServiceMode,
    accountRegion: accountRegion as OrganizationServiceRegion,
    apiOrigin,
    ...(issuer ? { issuer } : {}),
    ...(jwksUri ? { jwksUri } : {}),
    ...(typeof audience === "string" ? { audience } : {}),
    status: "ACTIVE" as const,
    capabilitiesVersion: positiveVersion(
      record.capabilities_version ?? record.capabilitiesVersion,
      "service_bindings capabilities_version",
    ),
    configVersion: positiveVersion(
      record.config_version ?? record.configVersion,
      "service_bindings config_version",
    ),
  });
}

/** Parse the redacted, active-only organization services advertised during enrollment. */
export function parseOrganizationServiceBindings(
  value: unknown,
): OrganizationServiceBinding[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > ORGANIZATION_SERVICE_KINDS.length) {
    throw new Error("enroll response contains an invalid service_bindings");
  }
  const result = value.map(parseOne);
  const services = new Set(result.map((binding) => binding.service));
  const tenantIds = new Set(result.map((binding) => binding.tenantId));
  if (services.size !== result.length || tenantIds.size > 1) {
    throw new Error("enroll response contains duplicate or mixed-tenant service_bindings");
  }
  return result;
}

export function serviceBindingHost(apiOrigin: string): string {
  try {
    return new URL(apiOrigin).host;
  } catch {
    return "invalid endpoint";
  }
}
