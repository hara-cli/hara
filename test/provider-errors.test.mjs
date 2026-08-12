import test from "node:test";
import assert from "node:assert/strict";
import { safeProviderErrorMessage } from "../dist/providers/errors.js";

test("provider diagnostics redact caller-known and recognizable credentials", () => {
  const opaqueKey = "opaque-control-key-ce81";
  const result = safeProviderErrorMessage({
    status: 401,
    message: `request failed: Authorization=Bearer ${opaqueKey}; url=https://admin:${opaqueKey}@api.example.test/v1`,
  }, [opaqueKey]);

  assert.match(result, /^401 request failed:/);
  assert.doesNotMatch(result, /opaque-control-key|ce81/);
  assert.doesNotMatch(result, /admin:opaque/);
  assert.match(result, /\*\*\*/);
});

test("provider diagnostics stay on one line, strip controls, cap hostile payloads, and preserve a useful fallback", () => {
  const result = safeProviderErrorMessage(`bad\r\n\t\u0000\u001b[31m${"x".repeat(3_000)}`);
  assert.doesNotMatch(result, /[\r\n\t\u0000\u001b]/);
  assert.match(result, /^bad \[31m/);
  assert.equal(result.length, 2_000);
  assert.ok(result.endsWith("…"));
  assert.equal(safeProviderErrorMessage({}), "Provider request failed.");
});
