import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const execute = promisify(execFile), factory = new URL("../dist/workspace/provider.js", import.meta.url).href;
// A fully replaced child environment contains only declared fake values. Never read/snapshot a real
// auth token to prove isolation, and never mutate the test parent or operator's environment.
for (const provider of ["openai", "anthropic"]) test(`Workspace ${provider} cannot inherit SDK credentials, audience headers or debug logs`, async () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-scoped-sdk-"))), received = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* bounded fixture request; no recording of model content */ }
    received.push(request.headers); response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "local fixture only" } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const script = `import { createWorkspaceProvider } from ${JSON.stringify(factory)};
      const binding = { connectionId:"mc_local", credentialGeneration:"gen_local", connectionRevision:1, model:"local-model", reasoning:null };
      const connection = { id:binding.connectionId, credentialGeneration:binding.credentialGeneration, revision:1, status:"active", provider:${JSON.stringify(provider)},
        label:"mock", baseURL:${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)}, apiKey:"workspace-fake-key", defaultModel:binding.model };
      const result = await createWorkspaceProvider(connection,binding).turn({system:"local fixture",history:[{role:"user",content:"hello"}],tools:[],onText(){}});
      if(result.stop!=="error") throw new Error("expected normalized local fixture error");
      console.log("local-scope-verified");`;
    const { stdout, stderr } = await execute(process.execPath, ["--input-type=module", "-e", script], { timeout: 10000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, OPENAI_API_KEY: "foreign-openai-fake-key", OPENAI_ADMIN_KEY: "foreign-admin-fake-key",
        OPENAI_WEBHOOK_SECRET: "foreign-webhook-fake-key", OPENAI_ORG_ID: "foreign-org", OPENAI_PROJECT_ID: "foreign-project", OPENAI_LOG: "debug",
        ANTHROPIC_API_KEY: "foreign-anthropic-fake-key", ANTHROPIC_AUTH_TOKEN: "foreign-bearer-fake-key", ANTHROPIC_WEBHOOK_SIGNING_KEY: "foreign-signing-fake-key", ANTHROPIC_LOG: "debug" } });
    assert.equal(received.length, 1, "SDK retries remain disabled"); const headers = received[0];
    if (provider === "openai") { assert.equal(headers.authorization, "Bearer workspace-fake-key"); assert.equal(headers["openai-organization"], undefined); assert.equal(headers["openai-project"], undefined); }
    else { assert.equal(headers["x-api-key"], "workspace-fake-key"); assert.equal(headers.authorization, undefined); }
    assert.equal(stdout.trim(), "local-scope-verified", "Workspace must not inherit SDK debug logging"); assert.equal(stderr, "");
    assert.deepEqual(fs.readdirSync(home), [], "SDK cannot initialize ambient account/config files");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(home, { recursive: true, force: true }); }
});
