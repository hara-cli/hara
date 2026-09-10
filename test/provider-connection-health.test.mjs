import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ProviderConnectionCircuitRegistry,
  providerCompatibility,
  providerConnectionDescriptor,
  providerModelCapabilities,
  providerTurnRequirements,
  sameProviderAccount,
  withProviderConnectionCircuit,
} from "../dist/providers/connection-health.js";

const target = (overrides = {}) => ({
  provider: "volcengine-agent-plan",
  apiKey: "fixture-key-a",
  baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3",
  model: "glm-5.3-flash",
  ...overrides,
});

const connected = (connectionId, overrides = {}, registry) => {
  const route = target(overrides);
  return withProviderConnectionCircuit({
    id: route.provider,
    model: route.model,
    async turn() {
      return { text: "ok", toolUses: [], stop: "end" };
    },
  }, providerConnectionDescriptor(connectionId, route), registry);
};

test("model capabilities preserve current multimodal and text-only boundaries", () => {
  const glm = providerModelCapabilities(target());
  assert.equal(glm.imageInput, "supported");
  assert.equal(glm.toolCalling, "supported");
  assert.equal(glm.wireApi, "responses");
  assert.equal(glm.contextWindowTokens, 1_024_000);
  assert.equal(glm.region, "cn-beijing");

  const deepseekText = providerModelCapabilities({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
  });
  assert.equal(deepseekText.imageInput, "unsupported");
  assert.equal(deepseekText.toolCalling, "supported");

  const deepseekVision = providerModelCapabilities({
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-flash-vision-exp",
  });
  assert.equal(deepseekVision.imageInput, "supported");

  const minimax = providerModelCapabilities({
    provider: "minimax-token-plan",
    baseURL: "https://api.minimaxi.com/v1",
    model: "MiniMax-M3",
  });
  assert.equal(minimax.imageInput, "supported");
  assert.equal(minimax.contextWindowTokens, 1_000_000);

  const currentArkModels = new Map([
    ["auto", ["unknown", undefined]],
    ["doubao-seed-evolving", ["unknown", 1_024_000]],
    ["doubao-seed-2.1-turbo", ["supported", 256_000]],
    ["doubao-seed-2.0-lite", ["unknown", 256_000]],
    ["doubao-seed-2.0-mini", ["unknown", 256_000]],
    ["glm-5.3-flash", ["supported", 1_024_000]],
    ["glm-5.3", ["unsupported", 1_024_000]],
    ["deepseek-v4-pro", ["unsupported", 1_024_000]],
    ["deepseek-v4-flash", ["unsupported", 1_024_000]],
    ["minimax-m3", ["supported", 1_000_000]],
    ["kimi-k2.7-code", ["supported", 256_000]],
    ["kimi-k3", ["supported", 1_024_000]],
    ["ark-code-latest", ["unknown", undefined]],
    ["glm-latest", ["unknown", undefined]],
  ]);
  for (const [model, [imageInput, contextWindowTokens]] of currentArkModels) {
    const capabilities = providerModelCapabilities({
      provider: "volcengine-agent-plan",
      baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3",
      model,
    });
    assert.equal(capabilities.imageInput, imageInput, `${model} image capability`);
    assert.equal(capabilities.contextWindowTokens, contextWindowTokens, `${model} context window`);
    assert.equal(capabilities.toolCalling, "supported", `${model} uses the Agent Plan tool endpoint`);
  }

  const arkMediaModel = providerModelCapabilities({
    provider: "volcengine-agent-plan",
    baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3",
    model: "doubao-seedream-5.0-lite",
  });
  assert.equal(
    arkMediaModel.toolCalling,
    "unsupported",
    "a manually entered media model must not inherit the Agent Plan conversation-tool contract",
  );
  assert.equal(
    providerModelCapabilities({
      provider: "volcengine-agent-plan",
      baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3",
      model: "future-model-returned-by-live-discovery",
    }).toolCalling,
    "unknown",
    "a newly discovered model stays directly selectable without inheriting unverified tool capability",
  );
});

test("a circuit is isolated by exact credential/model route and recovers through one half-open probe", () => {
  let now = 1_000;
  const registry = new ProviderConnectionCircuitRegistry({ now: () => now });
  const first = providerConnectionDescriptor("account-a", target());
  const otherModel = providerConnectionDescriptor("account-a", target({ model: "kimi-k3" }));
  const otherAccount = providerConnectionDescriptor("account-b", target({ apiKey: "fixture-key-b" }));

  registry.failure(first.runtimeKey, "overloaded");
  registry.failure(first.runtimeKey, "overloaded");
  assert.equal(registry.snapshot(first.runtimeKey).circuit, "closed");
  registry.failure(first.runtimeKey, "overloaded");
  const opened = registry.snapshot(first.runtimeKey);
  assert.equal(opened.circuit, "open");
  assert.equal(opened.state, "unavailable");
  assert.equal(registry.snapshot(otherModel.runtimeKey).state, "unknown");
  assert.equal(registry.snapshot(otherAccount.runtimeKey).state, "unknown");
  assert.equal(registry.begin(first.runtimeKey).allowed, false);

  now = Date.parse(opened.retryAt);
  assert.equal(registry.snapshot(first.runtimeKey).circuit, "half_open");
  assert.equal(registry.begin(first.runtimeKey).allowed, true);
  assert.equal(registry.begin(first.runtimeKey).allowed, false, "only one half-open request may probe");
  assert.equal(registry.success(first.runtimeKey).circuit, "closed");
  assert.equal(registry.snapshot(first.runtimeKey).state, "healthy");
});

test("auth health is account-aware while model health remains model-scoped", () => {
  const one = connected("account-a", { model: "glm-5.3-flash" });
  const sameAccountModel = connected("account-a", { model: "kimi-k3" });
  const duplicateSavedConnection = connected("renamed-account-a", { model: "deepseek-v4-pro" });
  const otherAccount = connected("account-b", { apiKey: "fixture-key-b", model: "kimi-k3" });
  assert.equal(sameProviderAccount(one, sameAccountModel), true);
  assert.equal(sameProviderAccount(one, duplicateSavedConnection), true, "a duplicate label cannot disguise the same credential and endpoint as another account");
  assert.equal(sameProviderAccount(one, otherAccount), false);
});

test("automatic fallback is rejected when input, tools, context, or health are incompatible", () => {
  const registry = new ProviderConnectionCircuitRegistry({ now: () => 10_000 });
  const textOnly = connected("deepseek", {
    provider: "deepseek",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
  }, registry);
  const imageTurn = providerTurnRequirements([
    { role: "user", content: "inspect", images: [{ path: "/fixture/a.png", mediaType: "image/png" }] },
  ], []);
  assert.deepEqual(providerCompatibility(textOnly, imageTurn), { ok: false, reason: "image_input" });

  const unknown = withProviderConnectionCircuit({
    id: "custom",
    model: "unknown-model",
    async turn() { return { text: "", toolUses: [], stop: "end" }; },
  }, providerConnectionDescriptor("custom", {
    provider: "openai",
    baseURL: "https://example.invalid/v1",
    apiKey: "fixture",
    model: "unknown-model",
  }), registry);
  assert.deepEqual(
    providerCompatibility(unknown, { imageInput: false, toolCalling: true }),
    { ok: false, reason: "tool_calling" },
  );
  const unresolvedContextRequirement = providerTurnRequirements([], [], unknown, "context_overflow");
  assert.equal(unresolvedContextRequirement.contextWindowComparisonUnavailable, true);
  assert.deepEqual(
    providerCompatibility(textOnly, unresolvedContextRequirement),
    { ok: false, reason: "context_window" },
    "context failover stays disabled when the failed model's actual window is unknown",
  );
  assert.deepEqual(
    providerCompatibility(textOnly, { imageInput: false, toolCalling: false, minimumContextWindowTokens: 1_024_001 }),
    { ok: false, reason: "context_window" },
  );

  registry.failure(textOnly.connection.runtimeKey, "auth");
  assert.deepEqual(
    providerCompatibility(textOnly, { imageInput: false, toolCalling: false }),
    { ok: false, reason: "circuit_open" },
  );
});

test("provider wrapper records terminal health and blocks an opened route without another wire call", async () => {
  let calls = 0;
  const registry = new ProviderConnectionCircuitRegistry({ now: () => 5_000 });
  const route = target();
  const descriptor = providerConnectionDescriptor("account-a", route);
  const provider = withProviderConnectionCircuit({
    id: route.provider,
    model: route.model,
    async turn() {
      calls += 1;
      return { text: "", toolUses: [], stop: "error", errorMsg: "invalid API key", errorMetadata: { status: 401 } };
    },
  }, descriptor, registry);
  const args = { system: "", history: [], tools: [], onText() {} };
  assert.equal((await provider.turn(args)).stop, "error");
  assert.equal(registry.snapshot(descriptor.runtimeKey).circuit, "open");
  const blocked = await provider.turn(args);
  assert.equal(blocked.errorMetadata.code, "HARA_CIRCUIT_OPEN");
  assert.equal(calls, 1);
});
