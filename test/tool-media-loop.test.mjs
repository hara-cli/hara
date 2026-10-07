import test from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const buildRoot = process.env.HARA_TOOL_MEDIA_TEST_BUILD_ROOT;
const moduleUrl = (path) => buildRoot ? pathToFileURL(join(resolve(buildRoot), path)).href : new URL(`../dist/${path}`, import.meta.url).href;
const { runAgent } = await import(moduleUrl("agent/loop.js"));
const { readToolImageToBase64 } = await import(moduleUrl("tools/tool-images.js"));

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const imageInput = () => ({ data: PNG_BASE64, mediaType: "image/png" });

function fixtureTool(name, run) {
  return { name, description: "Synthetic media fixture", kind: "read", input_schema: { type: "object", properties: {} }, run };
}

function toolsIn(history) {
  return history.flatMap((message) => message.role === "tool" ? message.results : []);
}

function assertNoDurableMedia(history) {
  for (const result of toolsIn(history)) assert.equal(result.images, undefined);
  assert.doesNotMatch(JSON.stringify(history), /hara-tool-images|iVBORw0KGgo|data:image\/png/);
}

function options(provider, cwd, extraTools, ctx = {}, other = {}) {
  return {
    provider, ctx: { cwd, ...ctx }, extraTools,
    approval: "full-auto", approvalChannel: false, confirm: async () => false,
    hooks: false, quiet: true, toolFilter: () => false,
    guardian: { enabled: false }, timeoutMs: 5_000, maxRounds: 5,
    ...other,
  };
}

// Observe only this process's allocations; comparing global tmpdir listings races parallel test workers.
async function trackToolImageDirectories(run) {
  const original = fs.mkdtempSync;
  const directories = [];
  fs.mkdtempSync = function (prefix, ...args) {
    const directory = original.call(this, prefix, ...args);
    if (String(prefix).includes("hara-tool-images-")) directories.push(directory);
    return directory;
  };
  syncBuiltinESMExports();
  try { return await run(directories); }
  finally {
    fs.mkdtempSync = original;
    syncBuiltinESMExports();
  }
}

test("tool pixels reach only the next native model request, never durable history, and snapshots are cleaned", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-native-tool-media-loop-"));
  const durable = [{ role: "user", content: "Inspect the synthetic capture and finish." }];
  const runtime = [];
  let turns = 0;
  let image;
  const screenshot = fixtureTool("fixture_media_native", async (_input, ctx) => {
    ctx.attachToolImage(imageInput());
    return "Synthetic observation captured.";
  });
  const noop = fixtureTool("fixture_media_native_noop", async () => "Additional read completed.");
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn({ history }) {
      assertNoDurableMedia(durable);
      if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "native-1", name: screenshot.name, input: {} }] };
      if (turns === 2) {
        image = toolsIn(history).find((result) => result.id === "native-1").images?.[0];
        assert.ok(image, "the next request contains native tool media");
        assert.equal(readToolImageToBase64(image), PNG_BASE64);
        return { text: "", stop: "tool_use", toolUses: [{ id: "native-2", name: noop.name, input: {} }] };
      }
      assert.equal(toolsIn(history).some((result) => result.images?.length), false, "older pixels are not retransmitted");
      assert.equal(existsSync(image.path), false, "successful native consumption releases the private snapshot");
      return { text: "Observation complete.", stop: "end", toolUses: [] };
    },
  };
  try {
    const outcome = await runAgent(durable, options(provider, cwd, [screenshot, noop], {}, { onRuntimeItem(event) { runtime.push(event); } }));
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(turns, 3);
    assertNoDurableMedia(durable);
    assert.equal(existsSync(dirname(image.path)), false);
    assert.doesNotMatch(JSON.stringify(runtime), /hara-tool-images|iVBORw0KGgo|data:image\/png/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("explicit vision-first route inspects through the authorized callback and keeps main requests text-only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-inspect-tool-media-loop-"));
  const durable = [{ role: "user", content: "Inspect the synthetic observation." }];
  let turns = 0;
  let inspected = 0;
  let image;
  const screenshot = fixtureTool("fixture_media_inspect", async (_input, ctx) => {
    ctx.attachToolImage(imageInput());
    return "Synthetic capture.";
  });
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn({ history }) {
      if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "inspect-1", name: screenshot.name, input: {} }] };
      assert.equal(toolsIn(history).some((result) => result.images?.length), false);
      assert.match(toolsIn(history).find((result) => result.id === "inspect-1").content, /synthetic red square/);
      return { text: "Observation complete.", stop: "end", toolUses: [] };
    },
  };
  try {
    const outcome = await runAgent(durable, options(provider, cwd, [screenshot], {
      toolImageMode: () => "inspect",
      async inspectImage(snapshot, _hint, signal) {
        inspected++;
        image = snapshot;
        assert.equal(readToolImageToBase64(snapshot), PNG_BASE64);
        assert.equal(signal.aborted, false);
        return { text: "A synthetic red square.", model: "authorized-synthetic-image-model" };
      },
    }));
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(inspected, 1);
    assert.equal(existsSync(dirname(image.path)), false);
    assertNoDurableMedia(durable);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("unavailable tool-image route records an honest unread marker and preserves structured errors", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-unavailable-tool-media-loop-"));
  const durable = [{ role: "user", content: "Read the synthetic tool result." }];
  let turns = 0;
  let inspected = 0;
  const screenshot = fixtureTool("fixture_media_unavailable", async (_input, ctx) => {
    ctx.attachToolImage(imageInput());
    ctx.markToolError();
    return "The fixture reports a structured failure.";
  });
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn({ history }) {
      if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "unavailable-1", name: screenshot.name, input: {} }] };
      const result = toolsIn(history).find((item) => item.id === "unavailable-1");
      assert.equal(result.images, undefined);
      assert.equal(result.isError, true);
      assert.match(result.content, /[Ii]mage was not read|pixels were not inspected/);
      return { text: "The observation is unavailable.", stop: "end", toolUses: [] };
    },
  };
  try {
    const outcome = await runAgent(durable, options(provider, cwd, [screenshot], {
      toolImageMode: () => "unavailable",
      async inspectImage() { inspected++; return { text: "must not run", model: "wrong" }; },
    }));
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(inspected, 0);
    assert.equal(toolsIn(durable).find((item) => item.id === "unavailable-1").isError, true);
    assertNoDurableMedia(durable);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("cancelling a non-cooperative pending image inspection returns promptly, cleans media and cannot persist late text", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-cancel-tool-media-loop-"));
  const durable = [{ role: "user", content: "Inspect the synthetic capture." }];
  const controller = new AbortController();
  let beginInspect;
  const entered = new Promise((resolve) => { beginInspect = resolve; });
  let finishInspect;
  let image;
  let turns = 0;
  const screenshot = fixtureTool("fixture_media_cancel", async (_input, ctx) => {
    ctx.attachToolImage(imageInput());
    return "Synthetic capture.";
  });
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn() {
      turns++;
      return { text: "", stop: "tool_use", toolUses: [{ id: "cancel-1", name: screenshot.name, input: {} }] };
    },
  };
  let enteredTimer;
  try {
    const pending = runAgent(durable, options(provider, cwd, [screenshot], {
      toolImageMode: () => "inspect",
      inspectImage(snapshot) {
        image = snapshot;
        beginInspect();
        return new Promise((resolve) => { finishInspect = resolve; });
      },
    }, { signal: controller.signal }));
    await Promise.race([entered, new Promise((_resolve, reject) => {
      enteredTimer = setTimeout(() => reject(new Error("synthetic image inspection did not start")), 2_000);
    })]);
    clearTimeout(enteredTimer);
    const abortedAt = Date.now();
    controller.abort();
    const outcome = await pending;
    assert.ok(Date.now() - abortedAt < 1_000, "logical cancellation does not wait for the abandoned inspect callback");
    assert.notEqual(outcome.status, "completed");
    assert.equal(turns, 1);
    assert.equal(existsSync(dirname(image.path)), false);
    assertNoDurableMedia(durable);
    const closed = JSON.stringify(durable);
    finishInspect({ text: "LATE_UNTRUSTED_IMAGE_DESCRIPTION", model: "synthetic" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(JSON.stringify(durable), closed);
    assert.doesNotMatch(JSON.stringify(durable), /LATE_UNTRUSTED/);
  } finally {
    clearTimeout(enteredTimer);
    controller.abort();
    finishInspect?.({ text: "discarded", model: "synthetic" });
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const requestMode of ["unavailable", "inspect"]) {
  test(`a route changing from native to ${requestMode} before inference explicitly reports unread pixels and releases snapshots`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `hara-route-${requestMode}-tool-media-loop-`));
    const durable = [{ role: "user", content: "Read the synthetic capture through the current route." }];
    let turns = 0;
    let modeChecks = 0;
    let inspected = 0;
    const screenshot = fixtureTool(`fixture_media_route_${requestMode}`, async (_input, ctx) => {
      ctx.attachToolImage(imageInput());
      return "Synthetic image attached.";
    });
    const provider = {
      id: "synthetic", model: "synthetic", supportsToolImages: true,
      async turn({ history }) {
        if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "route-change-1", name: screenshot.name, input: {} }] };
        const result = toolsIn(history).find((item) => item.id === "route-change-1");
        assert.equal(result.images, undefined);
        assert.match(result.content, /[Ii]mage was NOT read in this request/);
        assert.match(result.content, /route changed or is unavailable/);
        assert.match(result.content, /fresh observation/);
        assert.doesNotMatch(JSON.stringify(history), /iVBORw0KGgo|data:image\/png|hara-tool-images/);
        return { text: "The capture needs a fresh authorized observation.", stop: "end", toolUses: [] };
      },
    };
    try {
      await trackToolImageDirectories(async (directories) => {
        const outcome = await runAgent(durable, options(provider, cwd, [screenshot], {
          // The first check happens when the tool completes; the next happens during request preparation.
          toolImageMode() { return modeChecks++ === 0 ? "native" : requestMode; },
          async inspectImage() { inspected++; return { text: "must not inspect stale media", model: "synthetic" }; },
        }));
        assert.equal(outcome.status, "completed", outcome.error);
        assert.equal(turns, 2);
        assert.ok(modeChecks >= 2);
        assert.equal(inspected, 0, "a mid-round route change requires a fresh observation, not silent rerouting");
        assert.equal(directories.length, 1, "the captured native snapshot had a private owner");
        for (const directory of directories) assert.equal(existsSync(directory), false, "old snapshots are released");
        assertNoDurableMedia(durable);
      });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

test("duplicated tool-call identities stop before execution or durable recording and allocate no media", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-duplicate-tool-media-loop-"));
  const durable = [{ role: "user", content: "Inspect the synthetic captures." }];
  let executions = 0;
  let turns = 0;
  const first = fixtureTool("fixture_media_duplicate_first", async (_input, ctx) => {
    executions++;
    ctx.attachToolImage(imageInput());
    return "first captured";
  });
  const second = fixtureTool("fixture_media_duplicate_second", async (_input, ctx) => {
    executions++;
    ctx.attachToolImage(imageInput());
    return "second captured";
  });
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn() {
      turns++;
      return { text: "", stop: "tool_use", toolUses: [
        { id: "duplicate-image-id", name: first.name, input: {} },
        { id: "duplicate-image-id", name: second.name, input: {} },
      ] };
    },
  };
  try {
    await trackToolImageDirectories(async (directories) => {
      const outcome = await runAgent(durable, options(provider, cwd, [first, second]));
      assert.equal(outcome.status, "error");
      assert.match(outcome.error, /identities.*duplicated/);
      assert.equal(turns, 1);
      assert.equal(executions, 0);
      assert.equal(directories.length, 0, "invalid protocol responses cannot allocate an image owner");
      assert.equal(durable.some((message) => message.role === "assistant" && message.toolUses?.length), false);
      assert.equal(durable.some((message) => message.role === "tool"), false);
      assert.doesNotMatch(JSON.stringify(durable), /duplicate-image-id|fixture_media_duplicate/);
      assertNoDurableMedia(durable);
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("a tool-call ID reused across rounds cannot attach fresh pixels to an older observation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-reused-tool-media-id-"));
  const durable = [{ role: "user", content: "Inspect two synthetic observations." }];
  let turns = 0;
  const snapshotPaths = [];
  const screenshot = fixtureTool("fixture_media_reused_id", async (_input, ctx) => {
    ctx.attachToolImage(imageInput());
    return "Synthetic capture.";
  });
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn({ history }) {
      assertNoDurableMedia(durable);
      if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "reused-image-call", name: screenshot.name, input: {} }] };
      if (turns === 2) {
        const current = toolsIn(history).find((result) => result.id === "reused-image-call").images[0];
        snapshotPaths.push(current.path);
        assert.equal(readToolImageToBase64(current), PNG_BASE64);
        return { text: "", stop: "tool_use", toolUses: [{ id: "reused-image-call", name: screenshot.name, input: {} }] };
      }
      const results = toolsIn(history).filter((result) => result.id === "reused-image-call");
      assert.equal(results.length, 2);
      assert.equal(results[0].images?.length ?? 0, 0, "historical results never receive the latest pixels");
      assert.equal(results[1].images?.length, 1);
      snapshotPaths.push(results[1].images[0].path);
      assert.notEqual(snapshotPaths[0], snapshotPaths[1]);
      assert.equal(existsSync(snapshotPaths[0]), false, "the earlier consumed capture was already disposed");
      assert.equal(readToolImageToBase64(results[1].images[0]), PNG_BASE64);
      return { text: "Both observations handled.", stop: "end", toolUses: [] };
    },
  };
  try {
    const outcome = await runAgent(durable, options(provider, cwd, [screenshot]));
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(turns, 3);
    assert.equal(snapshotPaths.length, 2);
    for (const path of snapshotPaths) assert.equal(existsSync(dirname(path)), false);
    assertNoDurableMedia(durable);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const inspectMode of ["throw", "success"]) {
  test(`image inspection ${inspectMode} cannot persist echoed data URIs, raw pixels or private paths`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `hara-inspect-${inspectMode}-media-redaction-`));
    const durable = [{ role: "user", content: "Inspect the synthetic image." }];
    let turns = 0;
    let snapshotPath;
    const screenshot = fixtureTool(`fixture_media_inspection_${inspectMode}_echo`, async (_input, ctx) => {
      ctx.attachToolImage(imageInput());
      return "Synthetic capture.";
    });
    const provider = {
      id: "synthetic", model: "synthetic", supportsToolImages: true,
      async turn({ history }) {
        if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "inspection-echo-1", name: screenshot.name, input: {} }] };
        assert.equal(toolsIn(history).some((result) => result.images?.length), false);
        assertNoDurableMedia(history);
        assert.doesNotMatch(JSON.stringify(history), /iVBORw0KGgo|data:image\/png|hara-tool-images/);
        const result = toolsIn(history).find((item) => item.id === "inspection-echo-1");
        assert.match(result.content, /Useful diagnostic/);
        if (inspectMode === "throw") assert.equal(result.isError, true);
        return { text: "Observation handled.", stop: "end", toolUses: [] };
      },
    };
    try {
      const outcome = await runAgent(durable, options(provider, cwd, [screenshot], {
        toolImageMode: () => "inspect",
        async inspectImage(image) {
          snapshotPath = image.path;
          const echoed = `Useful diagnostic. URI data:image/png;base64,${PNG_BASE64} raw ${PNG_BASE64} path ${image.path}`;
          if (inspectMode === "throw") throw new Error(echoed);
          return { text: echoed, model: "synthetic" };
        },
      }));
      assert.equal(outcome.status, "completed", outcome.error);
      assert.equal(existsSync(dirname(snapshotPath)), false);
      assertNoDurableMedia(durable);
      assert.doesNotMatch(JSON.stringify(durable), /iVBORw0KGgo|data:image\/png|hara-tool-images/);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

test("returned native provider errors are redacted before outcome and failed-tool transcript retention", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-native-media-error-redaction-"));
  const durable = [{ role: "user", content: "Read the synthetic capture." }];
  let turns = 0;
  let snapshotPath;
  const screenshot = fixtureTool("fixture_media_native_error_echo", async (_input, ctx) => {
    ctx.attachToolImage(imageInput());
    return "Synthetic capture.";
  });
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn({ history }) {
      if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "native-echo-1", name: screenshot.name, input: {} }] };
      const image = toolsIn(history).find((result) => result.id === "native-echo-1").images[0];
      snapshotPath = image.path;
      return {
        text: "", stop: "error", errorMsg: `Useful diagnostic. URI data:image/png;base64,${PNG_BASE64} raw ${PNG_BASE64} path ${image.path}`,
        toolUses: [{ id: "native-error-pending-call", name: screenshot.name, input: {} }],
      };
    },
  };
  try {
    const outcome = await runAgent(durable, options(provider, cwd, [screenshot]));
    assert.equal(outcome.status, "error");
    assert.match(outcome.error, /Useful diagnostic/);
    assert.doesNotMatch(outcome.error, /iVBORw0KGgo|data:image\/png|hara-tool-images/);
    assert.equal(existsSync(dirname(snapshotPath)), false);
    assertNoDurableMedia(durable);
    assert.doesNotMatch(JSON.stringify(durable), /iVBORw0KGgo|data:image\/png|hara-tool-images/);
    const failed = toolsIn(durable).find((result) => result.id === "native-error-pending-call");
    assert.equal(failed.isError, true);
    assert.match(failed.content, /Useful diagnostic/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

function textSink(chunks) {
  return { text(delta) { chunks.push(delta); }, reasoning() {}, status() {}, tool() {}, diff() {}, notice() {} };
}

for (const echoMode of ["data-uri", "raw-base64"]) {
  test(`split streamed ${echoMode} echo is scrubbed before the UI or durable history can retain pixels`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `hara-stream-${echoMode}-media-redaction-`));
    const durable = [{ role: "user", content: "Inspect the synthetic capture." }];
    const visible = [];
    let turns = 0;
    const screenshot = fixtureTool(`fixture_stream_media_${echoMode.replaceAll("-", "_")}`, async (_input, ctx) => {
      ctx.attachToolImage(imageInput());
      return "Synthetic capture.";
    });
    const provider = {
      id: "synthetic", model: "synthetic", supportsToolImages: true,
      async turn({ history, onText }) {
        if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "stream-echo-1", name: screenshot.name, input: {} }] };
        const image = toolsIn(history).find((result) => result.id === "stream-echo-1").images[0];
        const secret = echoMode === "data-uri" ? `data:image/png;base64,${PNG_BASE64}` : PNG_BASE64;
        const output = `Useful observation. ${secret} path ${image.path}`;
        const begin = output.indexOf(secret);
        for (const delta of [output.slice(0, begin + 8), output.slice(begin + 8, begin + 38), output.slice(begin + 38)]) {
          onText(delta);
          assert.equal(visible.length, 0, "media-bearing output is buffered until complete tokens can be redacted");
        }
        return { text: output, stop: "end", toolUses: [] };
      },
    };
    try {
      const outcome = await runAgent(durable, options(provider, cwd, [screenshot], { ui: textSink(visible) }, { quiet: false }));
      assert.equal(outcome.status, "completed", outcome.error);
      assert.match(visible.join(""), /Useful observation/);
      assert.doesNotMatch(visible.join(""), /iVBORw0KGgo|data:image\/png|hara-tool-images/);
      assertNoDurableMedia(durable);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

test("ordinary streaming after a text-only tool still reaches the UI before the provider settles", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-ordinary-tool-stream-"));
  const durable = [{ role: "user", content: "Perform the synthetic read." }];
  const visible = [];
  let turns = 0;
  const noop = fixtureTool("fixture_text_only_stream", async () => "Read completed.");
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn({ onText }) {
      if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "text-stream-1", name: noop.name, input: {} }] };
      onText("The first ordinary delta. ");
      assert.match(visible.join(""), /The first ordinary delta/, "a tool without pixels does not defer ordinary streaming");
      onText("The second ordinary delta.");
      return { text: "The first ordinary delta. The second ordinary delta.", stop: "end", toolUses: [] };
    },
  };
  try {
    const outcome = await runAgent(durable, options(provider, cwd, [noop], { ui: textSink(visible) }, { quiet: false }));
    assert.equal(outcome.status, "completed", outcome.error);
    assert.match(visible.join(""), /The second ordinary delta/);
    assertNoDurableMedia(durable);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const echoMode of ["pixels", "path", "nested", "json-string", "structured-answer", "object-key"]) {
  test(`native ${echoMode} echoed in model tool arguments stops without execution, UI leakage or an open tool protocol`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `hara-tool-input-${echoMode}-privacy-`));
    const durable = [{ role: "user", content: "Inspect the synthetic capture." }];
    const visible = [];
    const runtime = [];
    const stats = { input: 0, output: 0 };
    const opaque = { type: "responses_reasoning", items: [{ type: "reasoning", id: "safe-reasoning", summary: [], encrypted_content: "legitimate-opaque-state" }] };
    let turns = 0;
    let executions = 0;
    let image;
    let originalInput;
    const screenshot = fixtureTool(`fixture_input_media_${echoMode.replaceAll("-", "_")}`, async (_input, ctx) => {
      ctx.attachToolImage(imageInput());
      return "Synthetic capture.";
    });
    const noop = fixtureTool("fixture_input_media_noop", async () => { executions++; return "Must not run."; });
    const provider = {
      id: "synthetic", model: "synthetic", supportsToolImages: true,
      async turn({ history }) {
        if (turns++ === 0) return { text: "", stop: "tool_use", usage: { input: 10, output: 2 }, toolUses: [{ id: "input-capture", name: screenshot.name, input: {} }] };
        image = toolsIn(history).find((result) => result.id === "input-capture").images[0];
        assert.equal(readToolImageToBase64(image), PNG_BASE64);
        originalInput = echoMode === "pixels" ? { data: PNG_BASE64 }
          : echoMode === "path" ? { path: image.path }
          : echoMode === "nested" ? { nested: [{ value: `data:image/png;base64,${PNG_BASE64}`, path: image.path }] }
          : echoMode === "json-string" ? { body: JSON.stringify({ data: PNG_BASE64, path: image.path }).replaceAll("/", "\\/") }
          : echoMode === "object-key" ? { [image.path]: "private key", [PNG_BASE64]: "private pixels" }
          : { completion: { state: "verified", final_answer: `Observed ${PNG_BASE64} at ${image.path}` } };
        return {
          text: "Useful safe description.", stop: "tool_use", continuation: opaque, usage: { input: 12, output: 8, cachedInput: 4 },
          toolUses: [
            { id: "input-echo", name: echoMode === "structured-answer" ? "task_checkpoint" : noop.name, input: originalInput },
            { id: "input-safe-sibling", name: noop.name, input: { value: "safe" } },
          ],
        };
      },
    };
    const ui = { ...textSink(visible), tool(...args) { visible.push(JSON.stringify(args)); }, notice(text) { visible.push(text); } };
    try {
      const outcome = await runAgent(durable, options(provider, cwd, [screenshot, noop], { ui }, {
        quiet: false, stats, onRuntimeItem(item) { runtime.push(item); },
      }));
      assert.equal(outcome.status, "error");
      assert.match(outcome.error, /blocked a model response.*private tool image/);
      assert.equal(turns, 2, "privacy rejection does not retry the provider automatically");
      assert.equal(executions, 0, "neither tainted nor safe sibling calls execute");
      assert.equal(stats.input, 22);
      assert.equal(stats.output, 10);
      assert.equal(stats.providerCalls, 2);
      assert.equal(stats.cachedInput, 4);
      const response = durable.find((message) => message.role === "assistant" && message.toolUses.some((call) => call.id === "input-echo"));
      assert.ok(response);
      assert.strictEqual(response.continuation, opaque, "legitimate opaque continuation is not altered");
      assert.notStrictEqual(response.toolUses[0].input, originalInput, "only the retained projection is changed");
      for (const call of response.toolUses) {
        const result = toolsIn(durable).find((item) => item.id === call.id);
        assert.equal(result?.isError, true, "each rejected call has a matching closed result");
      }
      assertNoDurableMedia(durable);
      assert.doesNotMatch(JSON.stringify([visible, runtime, outcome]), /iVBORw0KGgo|data:image\/png|hara-tool-images/);
      assert.equal(existsSync(dirname(image.path)), false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

for (const continuationMode of ["chat-reasoning", "responses-summary", "responses-content", "responses-encrypted", "call-identity", "cyclic-input"]) {
  test(`contaminated ${continuationMode} drops the entire native response, retains a safe terminal row and never executes`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), `hara-continuation-${continuationMode}-privacy-`));
    const durable = [{ role: "user", content: "Inspect the synthetic capture." }];
    const visible = [];
    const runtime = [];
    let turns = 0;
    let executions = 0;
    let image;
    const screenshot = fixtureTool("fixture_reasoning_media_capture", async (_input, ctx) => {
      ctx.attachToolImage(imageInput()); return "Synthetic capture.";
    });
    const noop = fixtureTool("fixture_reasoning_media_noop", async () => { executions++; return "Must not run."; });
    const provider = {
      id: "synthetic", model: "synthetic", supportsToolImages: true,
      async turn({ history, onReasoning }) {
        if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "reasoning-capture", name: screenshot.name, input: {} }] };
        image = toolsIn(history).find((result) => result.id === "reasoning-capture").images[0];
        const echo = `Private ${PNG_BASE64} path ${image.path}`;
        onReasoning?.(echo);
        const item = { type: "reasoning", id: "reasoning-id", summary: [] };
        if (continuationMode === "responses-summary") item.summary = [{ type: "summary_text", text: echo }];
        if (continuationMode === "responses-content") item.content = [{ type: "reasoning_text", text: echo }];
        if (continuationMode === "responses-encrypted") item.encrypted_content = echo;
        const input = {};
        if (continuationMode === "cyclic-input") input.self = input;
        return {
          text: "Safe description.", stop: "tool_use",
          continuation: continuationMode === "chat-reasoning" ? { type: "chat_reasoning", text: echo } : { type: "responses_reasoning", items: [item] },
          toolUses: [{ id: continuationMode === "call-identity" ? image.path : "reasoning-denied-call", name: noop.name, input }],
        };
      },
    };
    const ui = { ...textSink(visible), reasoning(text) { visible.push(text); }, tool(...args) { visible.push(JSON.stringify(args)); }, notice(text) { visible.push(text); } };
    try {
      const outcome = await runAgent(durable, options(provider, cwd, [screenshot, noop], { ui }, {
        quiet: false, onRuntimeItem(item) { runtime.push(item); },
      }));
      assert.equal(outcome.status, "error");
      assert.equal(turns, 2);
      assert.equal(executions, 0);
      assert.equal(durable.some((message) => message.role === "assistant" && message.continuation), false);
      assert.equal(durable.some((message) => message.role === "assistant" && message.toolUses.some((call) => call.name === noop.name)), false);
      assert.equal(toolsIn(durable).some((result) => result.name === noop.name), false, "the dropped round has no orphan tool results");
      assert.match(durable.at(-1).text, /blocked a model response/);
      assert.deepEqual(durable.at(-1).toolUses, []);
      assertNoDurableMedia(durable);
      assert.doesNotMatch(JSON.stringify([visible, runtime, outcome]), /iVBORw0KGgo|data:image\/png|hara-tool-images/);
      assert.equal(existsSync(dirname(image.path)), false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

test("uncontaminated native tool parameters and opaque continuation retain exact identity and execute unchanged", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-clean-native-continuation-"));
  const durable = [{ role: "user", content: "Inspect the synthetic capture." }];
  const input = { value: "ordinary exact argument", nested: [7, true] };
  const continuation = { type: "chat_reasoning", text: "legitimate opaque reasoning" };
  let turns = 0;
  let executions = 0;
  const screenshot = fixtureTool("fixture_clean_media_capture", async (_input, ctx) => { ctx.attachToolImage(imageInput()); return "Synthetic capture."; });
  const noop = fixtureTool("fixture_clean_media_noop", async (actual) => {
    executions++;
    assert.strictEqual(actual, input);
    return "Read completed.";
  });
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn() {
      if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "clean-capture", name: screenshot.name, input: {} }] };
      if (turns === 2) return { text: "", stop: "tool_use", continuation, toolUses: [{ id: "clean-next", name: noop.name, input }] };
      return { text: "Observation complete.", stop: "end", toolUses: [] };
    },
  };
  try {
    const outcome = await runAgent(durable, options(provider, cwd, [screenshot, noop]));
    assert.equal(outcome.status, "completed", outcome.error);
    assert.equal(executions, 1);
    const response = durable.find((message) => message.role === "assistant" && message.toolUses.some((call) => call.id === "clean-next"));
    assert.strictEqual(response.continuation, continuation);
    assert.strictEqual(response.toolUses[0].input, input);
    assertNoDurableMedia(durable);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("mixed gateway credential solicitation and private media stops before correction retry or durable prose", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-mixed-credential-media-privacy-"));
  const previousGateway = process.env.HARA_GATEWAY;
  process.env.HARA_GATEWAY = "synthetic-fixture-only";
  const durable = [{ role: "user", content: "Inspect the synthetic capture." }];
  const visible = [];
  let turns = 0;
  let executions = 0;
  let image;
  const solicitation = "Please paste your admin session token here.";
  const screenshot = fixtureTool("fixture_mixed_media_capture", async (_input, ctx) => {
    ctx.attachToolImage(imageInput()); return "Synthetic capture.";
  });
  const noop = fixtureTool("fixture_mixed_media_noop", async () => { executions++; return "Must not run."; });
  const provider = {
    id: "synthetic", model: "synthetic", supportsToolImages: true,
    async turn({ history, onText }) {
      if (turns++ === 0) return { text: "", stop: "tool_use", toolUses: [{ id: "mixed-capture", name: screenshot.name, input: {} }] };
      assert.equal(turns, 2, "privacy rejection must not request a credential-correction model turn");
      image = toolsIn(history).find((result) => result.id === "mixed-capture").images[0];
      onText(solicitation);
      return { text: solicitation, stop: "tool_use", toolUses: [{ id: "mixed-echo", name: noop.name, input: { pixels: PNG_BASE64, path: image.path } }] };
    },
  };
  const ui = { ...textSink(visible), tool(...args) { visible.push(JSON.stringify(args)); }, notice(text) { visible.push(text); } };
  try {
    const outcome = await runAgent(durable, options(provider, cwd, [screenshot, noop], { ui }, { quiet: false }));
    assert.equal(outcome.status, "error");
    assert.match(outcome.error, /blocked a model response/);
    assert.equal(turns, 2);
    assert.equal(executions, 0);
    assert.equal(JSON.stringify(durable).includes(solicitation), false);
    assert.equal(visible.join("").includes(solicitation), false);
    assertNoDurableMedia(durable);
    assert.equal(toolsIn(durable).find((result) => result.id === "mixed-echo").isError, true);
    assert.equal(existsSync(dirname(image.path)), false);
  } finally {
    if (previousGateway === undefined) delete process.env.HARA_GATEWAY;
    else process.env.HARA_GATEWAY = previousGateway;
    rmSync(cwd, { recursive: true, force: true });
  }
});
