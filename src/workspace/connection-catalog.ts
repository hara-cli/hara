import { createHash } from "node:crypto";
import { MINIMAX_TOKEN_PLAN_MODELS } from "../providers/minimax.js";
import { CODING_PLAN_FALLBACK_MODELS, DEEPSEEK_FALLBACK_MODELS } from "../providers/models.js";
import { VOLCENGINE_AGENT_PLAN_MODELS, VOLCENGINE_CODING_PLAN_MODELS } from "../providers/volcengine.js";

export const CONNECTION_CATALOG_SCHEMA_VERSION = 1 as const;
export const PI_CATALOG_PACKAGE = "@earendil-works/pi-ai" as const;
export const PI_CATALOG_VERSION = "1.5.0" as const;
export const PI_CATALOG_GENERATED_AT = "2026-11-02T10:43:28.346Z" as const;
export const CONNECTION_CATALOG_MAX_QUERY_LENGTH = 200;
export const CONNECTION_CATALOG_DEFAULT_LIMIT = 100;
export const CONNECTION_CATALOG_MAX_LIMIT = 200;

const SAFE_MODEL_ID = /^[^\s\x00-\x1f\x7f]+$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const MAX_CURSOR_OFFSET = 1_000_000;

type RawPiModel = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly api?: unknown;
  readonly input?: unknown;
  readonly reasoning?: unknown;
  readonly contextWindow?: unknown;
  readonly maxTokens?: unknown;
};

type RawPiModelMap = Readonly<Record<string, RawPiModel>>;

// Static literal module specifiers only: never construct import paths from RPC input, and never
// import `@earendil-works/pi-ai/providers/all` which also pulls in runtime provider factories.
const PI_CATALOG_LOADERS = Object.freeze({
  "amazon-bedrock": () => import("@earendil-works/pi-ai/providers/amazon-bedrock.models").then(m => m.AMAZON_BEDROCK_MODELS),
  "ant-ling": () => import("@earendil-works/pi-ai/providers/ant-ling.models").then(m => m.ANT_LING_MODELS),
  "anthropic": () => import("@earendil-works/pi-ai/providers/anthropic.models").then(m => m.ANTHROPIC_MODELS),
  "azure": () => import("@earendil-works/pi-ai/providers/azure.models").then(m => m.AZURE_MODELS),
  "baseten": () => import("@earendil-works/pi-ai/providers/baseten.models").then(m => m.BASETEN_MODELS),
  "cerebras": () => import("@earendil-works/pi-ai/providers/cerebras.models").then(m => m.CEREBRAS_MODELS),
  "cloudflare-ai-gateway": () => import("@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models").then(m => m.CLOUDFLARE_AI_GATEWAY_MODELS),
  "cloudflare-workers-ai": () => import("@earendil-works/pi-ai/providers/cloudflare-workers-ai.models").then(m => m.CLOUDFLARE_WORKERS_AI_MODELS),
  "deepseek": () => import("@earendil-works/pi-ai/providers/deepseek.models").then(m => m.DEEPSEEK_MODELS),
  "fireworks": () => import("@earendil-works/pi-ai/providers/fireworks.models").then(m => m.FIREWORKS_MODELS),
  "github-copilot": () => import("@earendil-works/pi-ai/providers/github-copilot.models").then(m => m.GITHUB_COPILOT_MODELS),
  "google": () => import("@earendil-works/pi-ai/providers/google.models").then(m => m.GOOGLE_MODELS),
  "google-vertex": () => import("@earendil-works/pi-ai/providers/google-vertex.models").then(m => m.GOOGLE_VERTEX_MODELS),
  "groq": () => import("@earendil-works/pi-ai/providers/groq.models").then(m => m.GROQ_MODELS),
  "huggingface": () => import("@earendil-works/pi-ai/providers/huggingface.models").then(m => m.HUGGINGFACE_MODELS),
  "kimi-coding": () => import("@earendil-works/pi-ai/providers/kimi-coding.models").then(m => m.KIMI_CODING_MODELS),
  "meta": () => import("@earendil-works/pi-ai/providers/meta.models").then(m => m.META_MODELS),
  "minimax": () => import("@earendil-works/pi-ai/providers/minimax.models").then(m => m.MINIMAX_MODELS),
  "minimax-cn": () => import("@earendil-works/pi-ai/providers/minimax-cn.models").then(m => m.MINIMAX_CN_MODELS),
  "mistral": () => import("@earendil-works/pi-ai/providers/mistral.models").then(m => m.MISTRAL_MODELS),
  "moonshotai": () => import("@earendil-works/pi-ai/providers/moonshotai.models").then(m => m.MOONSHOTAI_MODELS),
  "moonshotai-cn": () => import("@earendil-works/pi-ai/providers/moonshotai-cn.models").then(m => m.MOONSHOTAI_CN_MODELS),
  "nvidia": () => import("@earendil-works/pi-ai/providers/nvidia.models").then(m => m.NVIDIA_MODELS),
  "openai": () => import("@earendil-works/pi-ai/providers/openai.models").then(m => m.OPENAI_MODELS),
  "openai-codex": () => import("@earendil-works/pi-ai/providers/openai-codex.models").then(m => m.OPENAI_CODEX_MODELS),
  "opencode": () => import("@earendil-works/pi-ai/providers/opencode.models").then(m => m.OPENCODE_MODELS),
  "opencode-go": () => import("@earendil-works/pi-ai/providers/opencode-go.models").then(m => m.OPENCODE_GO_MODELS),
  "openrouter": () => import("@earendil-works/pi-ai/providers/openrouter.models").then(m => m.OPENROUTER_MODELS),
  "qwen-token-plan": () => import("@earendil-works/pi-ai/providers/qwen-token-plan.models").then(m => m.QWEN_TOKEN_PLAN_MODELS),
  "qwen-token-plan-cn": () => import("@earendil-works/pi-ai/providers/qwen-token-plan-cn.models").then(m => m.QWEN_TOKEN_PLAN_CN_MODELS),
  "qwen-token-plan-individual": () => import("@earendil-works/pi-ai/providers/qwen-token-plan-individual.models").then(m => m.QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS),
  "radius": () => import("@earendil-works/pi-ai/providers/radius.models").then(m => m.RADIUS_MODELS),
  "together": () => import("@earendil-works/pi-ai/providers/together.models").then(m => m.TOGETHER_MODELS),
  "typesafe": () => import("@earendil-works/pi-ai/providers/typesafe.models").then(m => m.TYPESAFE_MODELS),
  "vercel-ai-gateway": () => import("@earendil-works/pi-ai/providers/vercel-ai-gateway.models").then(m => m.VERCEL_AI_GATEWAY_MODELS),
  "xai": () => import("@earendil-works/pi-ai/providers/xai.models").then(m => m.XAI_MODELS),
  "xiaomi": () => import("@earendil-works/pi-ai/providers/xiaomi.models").then(m => m.XIAOMI_MODELS),
  "xiaomi-token-plan-ams": () => import("@earendil-works/pi-ai/providers/xiaomi-token-plan-ams.models").then(m => m.XIAOMI_TOKEN_PLAN_AMS_MODELS),
  "xiaomi-token-plan-cn": () => import("@earendil-works/pi-ai/providers/xiaomi-token-plan-cn.models").then(m => m.XIAOMI_TOKEN_PLAN_CN_MODELS),
  "xiaomi-token-plan-sgp": () => import("@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp.models").then(m => m.XIAOMI_TOKEN_PLAN_SGP_MODELS),
  "zai": () => import("@earendil-works/pi-ai/providers/zai.models").then(m => m.ZAI_MODELS),
  "zai-coding-cn": () => import("@earendil-works/pi-ai/providers/zai-coding-cn.models").then(m => m.ZAI_CODING_CN_MODELS),
} satisfies Record<string, () => Promise<RawPiModelMap>>);

export type PiCatalogProviderId = keyof typeof PI_CATALOG_LOADERS;
export const PI_CATALOG_PROVIDER_IDS: readonly PiCatalogProviderId[] = Object.freeze(
  Object.keys(PI_CATALOG_LOADERS) as PiCatalogProviderId[],
);
const PI_CATALOG_PROVIDER_SET = new Set<string>(PI_CATALOG_PROVIDER_IDS);

const HARA_DOCUMENTED_SOURCES = Object.freeze({
  "alibaba-coding-plan": CODING_PLAN_FALLBACK_MODELS,
  "deepseek-responses": DEEPSEEK_FALLBACK_MODELS,
  "minimax-token-plan": MINIMAX_TOKEN_PLAN_MODELS,
  "volcengine-agent-plan": VOLCENGINE_AGENT_PLAN_MODELS,
  "volcengine-coding-plan": VOLCENGINE_CODING_PLAN_MODELS,
} satisfies Record<string, readonly string[]>);

export type HaraDocumentedCatalogRef = keyof typeof HARA_DOCUMENTED_SOURCES;
export const HARA_DOCUMENTED_REFS: readonly HaraDocumentedCatalogRef[] = Object.freeze(
  Object.keys(HARA_DOCUMENTED_SOURCES) as HaraDocumentedCatalogRef[],
);
const HARA_DOCUMENTED_REF_SET = new Set<string>(HARA_DOCUMENTED_REFS);

export type ConnectionCatalogInputModality = "text" | "image";

export interface PiCatalogModel {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly referenceContextWindow?: number;
  readonly referenceMaxOutputTokens?: number;
  readonly inputModalities?: readonly ConnectionCatalogInputModality[];
  readonly reasoning?: boolean;
}

export interface HaraDocumentedCatalogModel {
  readonly id: string;
}

export interface ConnectionCatalogSummary {
  readonly package: typeof PI_CATALOG_PACKAGE;
  readonly version: typeof PI_CATALOG_VERSION;
  readonly generatedAt: typeof PI_CATALOG_GENERATED_AT;
  readonly digest: string;
}

export type ConnectionCatalogGroupSummary =
  | { readonly source: "pi-catalog"; readonly providerId: PiCatalogProviderId; readonly modelCount: number }
  | { readonly source: "hara-documented"; readonly documentedRef: HaraDocumentedCatalogRef; readonly modelCount: number };

export interface ConnectionCatalogSnapshot {
  readonly schemaVersion: typeof CONNECTION_CATALOG_SCHEMA_VERSION;
  readonly catalog: ConnectionCatalogSummary;
  readonly droppedInvalidCount: number;
  readonly piGroups: Readonly<Record<PiCatalogProviderId, readonly PiCatalogModel[]>>;
  readonly documentedGroups: Readonly<Record<HaraDocumentedCatalogRef, readonly HaraDocumentedCatalogModel[]>>;
  readonly groups: readonly ConnectionCatalogGroupSummary[];
}

export interface ConnectionCatalogQuery {
  readonly providerId?: unknown;
  readonly documentedRef?: unknown;
  readonly query?: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

export type ConnectionCatalogResponse =
  | {
    readonly schemaVersion: typeof CONNECTION_CATALOG_SCHEMA_VERSION;
    readonly catalog: ConnectionCatalogSummary;
    readonly groups: readonly ConnectionCatalogGroupSummary[];
  }
  | {
    readonly schemaVersion: typeof CONNECTION_CATALOG_SCHEMA_VERSION;
    readonly source: "pi-catalog";
    readonly providerId: PiCatalogProviderId;
    readonly catalog: ConnectionCatalogSummary;
    readonly total: number;
    readonly nextCursor: string | null;
    readonly models: readonly PiCatalogModel[];
  }
  | {
    readonly schemaVersion: typeof CONNECTION_CATALOG_SCHEMA_VERSION;
    readonly source: "hara-documented";
    readonly documentedRef: HaraDocumentedCatalogRef;
    readonly catalog: ConnectionCatalogSummary;
    readonly total: number;
    readonly nextCursor: string | null;
    readonly models: readonly HaraDocumentedCatalogModel[];
  };

function isValidModelId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && SAFE_MODEL_ID.test(value);
}

function projectPiModel(raw: RawPiModel): PiCatalogModel | null {
  if (!raw || typeof raw !== "object" || !isValidModelId(raw.id)) return null;
  const name = typeof raw.name === "string" && raw.name.trim().length > 0 ? raw.name : raw.id;
  if (typeof raw.api !== "string" || raw.api.length === 0) return null;

  const projected: {
    id: string;
    name: string;
    api: string;
    referenceContextWindow?: number;
    referenceMaxOutputTokens?: number;
    inputModalities?: readonly ConnectionCatalogInputModality[];
    reasoning?: boolean;
  } = {
    id: raw.id,
    name,
    api: raw.api,
  };

  if (typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0) {
    projected.referenceContextWindow = raw.contextWindow;
  }
  if (typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens) && raw.maxTokens > 0) {
    projected.referenceMaxOutputTokens = raw.maxTokens;
  }
  if (Array.isArray(raw.input)) {
    const modalities = [...new Set(raw.input)].filter(
      (item): item is ConnectionCatalogInputModality => item === "text" || item === "image",
    );
    if (modalities.length > 0) {
      projected.inputModalities = Object.freeze(modalities);
    }
  }
  if (typeof raw.reasoning === "boolean") {
    projected.reasoning = raw.reasoning;
  }

  return Object.freeze(projected);
}

let cachedSnapshotPromise: Promise<ConnectionCatalogSnapshot> | undefined;

async function buildConnectionCatalogSnapshot(): Promise<ConnectionCatalogSnapshot> {
  const piGroupsRecord = {} as Record<PiCatalogProviderId, readonly PiCatalogModel[]>;
  let droppedInvalidCount = 0;

  const loadedEntries = await Promise.all(
    PI_CATALOG_PROVIDER_IDS.map(async (providerId) => {
      const rawMap = await PI_CATALOG_LOADERS[providerId]();
      const models: PiCatalogModel[] = [];
      for (const raw of Object.values(rawMap)) {
        const projected = projectPiModel(raw);
        if (!projected) {
          droppedInvalidCount++;
          continue;
        }
        models.push(projected);
      }
      return [providerId, Object.freeze(models)] as const;
    }),
  );

  for (const [providerId, models] of loadedEntries) {
    piGroupsRecord[providerId] = models;
  }

  const documentedRecord = {} as Record<HaraDocumentedCatalogRef, readonly HaraDocumentedCatalogModel[]>;
  for (const documentedRef of HARA_DOCUMENTED_REFS) {
    const models: HaraDocumentedCatalogModel[] = [];
    for (const id of HARA_DOCUMENTED_SOURCES[documentedRef]) {
      if (!isValidModelId(id)) {
        droppedInvalidCount++;
        continue;
      }
      models.push(Object.freeze({ id }));
    }
    documentedRecord[documentedRef] = Object.freeze(models);
  }

  const piGroups = Object.freeze(piGroupsRecord);
  const documentedGroups = Object.freeze(documentedRecord);

  const groups: ConnectionCatalogGroupSummary[] = [
    ...PI_CATALOG_PROVIDER_IDS.map((providerId) =>
      Object.freeze({ source: "pi-catalog" as const, providerId, modelCount: piGroups[providerId].length }),
    ),
    ...HARA_DOCUMENTED_REFS.map((documentedRef) =>
      Object.freeze({ source: "hara-documented" as const, documentedRef, modelCount: documentedGroups[documentedRef].length }),
    ),
  ];

  const digestPayload = {
    schemaVersion: CONNECTION_CATALOG_SCHEMA_VERSION,
    package: PI_CATALOG_PACKAGE,
    version: PI_CATALOG_VERSION,
    generatedAt: PI_CATALOG_GENERATED_AT,
    piGroups,
    documentedGroups,
  };
  const digest = `sha256:${createHash("sha256").update(JSON.stringify(digestPayload)).digest("hex")}`;

  const catalog: ConnectionCatalogSummary = Object.freeze({
    package: PI_CATALOG_PACKAGE,
    version: PI_CATALOG_VERSION,
    generatedAt: PI_CATALOG_GENERATED_AT,
    digest,
  });

  return Object.freeze({
    schemaVersion: CONNECTION_CATALOG_SCHEMA_VERSION,
    catalog,
    droppedInvalidCount,
    piGroups,
    documentedGroups,
    groups: Object.freeze(groups),
  });
}

/** Load and memoize the offline bundled Pi chat model catalog and Hara documented reference groups.
 * Performs no network, credential vault, environment, or user home directory reads. */
export function loadConnectionCatalog(): Promise<ConnectionCatalogSnapshot> {
  cachedSnapshotPromise ??= buildConnectionCatalogSnapshot();
  return cachedSnapshotPromise;
}

/** Query the offline connection catalog with strict whitelist validation and bounded pagination. */
export async function queryConnectionCatalog(input?: ConnectionCatalogQuery): Promise<ConnectionCatalogResponse> {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
    throw new Error("Invalid connection catalog query");
  }
  const params = input ?? {};

  let providerId: PiCatalogProviderId | undefined;
  if (Object.hasOwn(params, "providerId")) {
    if (typeof params.providerId !== "string" || !PI_CATALOG_PROVIDER_SET.has(params.providerId)) {
      throw new Error("Unsupported connection catalog provider");
    }
    providerId = params.providerId as PiCatalogProviderId;
  }

  let documentedRef: HaraDocumentedCatalogRef | undefined;
  if (Object.hasOwn(params, "documentedRef")) {
    if (typeof params.documentedRef !== "string" || !HARA_DOCUMENTED_REF_SET.has(params.documentedRef)) {
      throw new Error("Unsupported documented connection catalog group");
    }
    documentedRef = params.documentedRef as HaraDocumentedCatalogRef;
  }

  if (providerId && documentedRef) {
    throw new Error("Specify at most one of providerId or documentedRef");
  }

  let search = "";
  if (Object.hasOwn(params, "query")) {
    if (typeof params.query !== "string" || params.query.length > CONNECTION_CATALOG_MAX_QUERY_LENGTH || CONTROL_CHARS.test(params.query)) {
      throw new Error("Invalid connection catalog search query");
    }
    search = params.query.trim().toLowerCase();
  }

  let limit = CONNECTION_CATALOG_DEFAULT_LIMIT;
  if (Object.hasOwn(params, "limit")) {
    if (typeof params.limit !== "number" || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > CONNECTION_CATALOG_MAX_LIMIT) {
      throw new Error("Invalid connection catalog page limit");
    }
    limit = params.limit;
  }

  let offset = 0;
  if (Object.hasOwn(params, "cursor")) {
    if (typeof params.cursor !== "string" || !CURSOR_PATTERN.test(params.cursor)) {
      throw new Error("Invalid connection catalog cursor");
    }
    const parsed = Number(params.cursor);
    if (!Number.isSafeInteger(parsed) || parsed > MAX_CURSOR_OFFSET) {
      throw new Error("Invalid connection catalog cursor");
    }
    if (!providerId && !documentedRef) {
      throw new Error("Connection catalog cursor requires providerId or documentedRef");
    }
    offset = parsed;
  }

  const snapshot = await loadConnectionCatalog();

  if (providerId) {
    const all = snapshot.piGroups[providerId];
    const filtered = search
      ? all.filter((m) => m.id.toLowerCase().includes(search) || m.name.toLowerCase().includes(search))
      : all;
    const models = filtered.slice(offset, offset + limit);
    const nextOffset = offset + models.length;
    return {
      schemaVersion: snapshot.schemaVersion,
      source: "pi-catalog",
      providerId,
      catalog: snapshot.catalog,
      total: filtered.length,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
      models,
    };
  }

  if (documentedRef) {
    const all = snapshot.documentedGroups[documentedRef];
    const filtered = search
      ? all.filter((m) => m.id.toLowerCase().includes(search))
      : all;
    const models = filtered.slice(offset, offset + limit);
    const nextOffset = offset + models.length;
    return {
      schemaVersion: snapshot.schemaVersion,
      source: "hara-documented",
      documentedRef,
      catalog: snapshot.catalog,
      total: filtered.length,
      nextCursor: nextOffset < filtered.length ? String(nextOffset) : null,
      models,
    };
  }

  const groups = search
    ? snapshot.groups.filter((group) =>
      group.source === "pi-catalog"
        ? group.providerId.toLowerCase().includes(search)
        : group.documentedRef.toLowerCase().includes(search),
    )
    : snapshot.groups;

  return {
    schemaVersion: snapshot.schemaVersion,
    catalog: snapshot.catalog,
    groups,
  };
}
