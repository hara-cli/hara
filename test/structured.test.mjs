import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSchemaArg,
  structuredOutputTool,
  validateAgainstSchema,
} from "../dist/agent/structured.js";

const schema = {
  type: "object",
  required: ["status", "items"],
  properties: {
    status: { type: "string", enum: ["ok", "error"] },
    count: { type: "integer" },
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          tags: { type: "array", items: { type: "string", enum: ["safe", "fast"] } },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

test("validateAgainstSchema: required, type, enum, additionalProperties, and nested arrays", () => {
  const valid = { status: "ok", count: 2, items: [{ id: "a", tags: ["safe", "fast"] }] };
  assert.equal(validateAgainstSchema(valid, schema), null);

  assert.match(validateAgainstSchema({ items: [] }, schema), /^\$\.status: required property missing$/);
  assert.match(validateAgainstSchema({ status: "ok", count: 1.5, items: [] }, schema), /^\$\.count: expected integer, got number$/);
  assert.match(validateAgainstSchema({ status: "maybe", items: [] }, schema), /^\$\.status: value not in enum/);
  assert.match(validateAgainstSchema({ status: "ok", items: [], extra: true }, schema), /^\$\.extra: unexpected property$/);
  assert.match(validateAgainstSchema({ status: "ok", items: "not-an-array" }, schema), /^\$\.items: expected array/);
  assert.match(validateAgainstSchema({ status: "ok", items: [{ id: 7 }] }, schema), /^\$\.items\[0\]\.id: expected string, got number$/);
  assert.match(validateAgainstSchema({ status: "ok", items: [{ id: "a", tags: ["slow"] }] }, schema), /^\$\.items\[0\]\.tags\[0\]: value not in enum/);
  assert.match(validateAgainstSchema({ status: "ok", items: [{ id: "a", extra: 1 }] }, schema), /^\$\.items\[0\]\.extra: unexpected property$/);
});

test("validateAgainstSchema: inherited properties never satisfy required or property validation", () => {
  const inheritedNamesSchema = JSON.parse(`{
    "type":"object",
    "required":["toString","__proto__"],
    "properties":{"toString":{"type":"string"},"__proto__":{"type":"string"}},
    "additionalProperties":false
  }`);

  assert.equal(validateAgainstSchema({}, inheritedNamesSchema), "$.toString: required property missing");
  assert.equal(
    validateAgainstSchema(Object.assign(Object.create({ toString: "inherited", __proto__: "inherited" }), {}), inheritedNamesSchema),
    "$.toString: required property missing",
  );
  assert.equal(validateAgainstSchema(JSON.parse('{"toString":"own"}'), inheritedNamesSchema), "$.__proto__: required property missing");
  assert.equal(validateAgainstSchema(JSON.parse('{"toString":"own","__proto__":"own"}'), inheritedNamesSchema), null);

  const closedEmptySchema = { type: "object", properties: {}, additionalProperties: false };
  assert.equal(validateAgainstSchema({ toString: "own" }, closedEmptySchema), "$.toString: unexpected property");
  assert.equal(validateAgainstSchema(JSON.parse('{"__proto__":"own"}'), closedEmptySchema), "$.__proto__: unexpected property");
});

test("validateAgainstSchema: nested additionalProperties:false applies without a properties map", () => {
  const noNestedProperties = {
    type: "object",
    required: ["result"],
    properties: {
      result: { type: "object", additionalProperties: false },
    },
    additionalProperties: false,
  };

  assert.equal(validateAgainstSchema({ result: {} }, noNestedProperties), null);
  assert.equal(validateAgainstSchema({ result: { surprise: true } }, noNestedProperties), "$.result.surprise: unexpected property");
});

test("parseSchemaArg: normalizes object schemas and rejects malformed/non-object input", () => {
  assert.deepEqual(parseSchemaArg('{"required":["answer"]}'), {
    type: "object",
    required: ["answer"],
    properties: {},
  });
  assert.deepEqual(parseSchemaArg('{"type":"object","properties":{"answer":{"type":"string"}}}'), {
    type: "object",
    properties: { answer: { type: "string" } },
  });

  for (const raw of ["not-json", "null", "[]", '"text"', '{"type":"array"}']) {
    const parsed = parseSchemaArg(raw);
    assert.equal(typeof parsed.error, "string", raw);
    assert.ok(parsed.error.length > 0, raw);
  }
});

test("parseSchemaArg: rejects unsupported keywords and types at every depth", () => {
  for (const raw of [
    '{"type":"object","$ref":"#/$defs/result"}',
    '{"type":"object","oneOf":[{"type":"object"}]}',
    '{"type":"object","properties":{"result":{"$ref":"#/result"}}}',
    '{"type":"object","properties":{"result":{"oneOf":[{"type":"string"}]}}}',
    '{"type":"object","properties":{"result":{"type":"date"}}}',
  ]) {
    const parsed = parseSchemaArg(raw);
    assert.equal(typeof parsed.error, "string", raw);
    assert.match(parsed.error, /unsupported or invalid/, raw);
  }
});

test("structuredOutputTool: refuses an unsupported schema before it reaches a provider", () => {
  assert.throws(
    () => structuredOutputTool({ type: "object", oneOf: [{ type: "object" }] }, () => {}),
    /unsupported JSON-Schema keyword/,
  );
});

test("structuredOutputTool: invalid payload is rejected and only a valid payload reaches the sink", async () => {
  const captured = [];
  const tool = structuredOutputTool(schema, (value) => captured.push(value));
  assert.equal(tool.name, "structured_output");
  assert.equal(tool.kind, "read");
  assert.equal(tool.input_schema, schema);

  const invalid = await tool.run({ status: "ok", items: [{ id: 9 }] }, {});
  assert.match(invalid, /schema validation failed/);
  assert.deepEqual(captured, []);

  const value = { status: "ok", count: 1, items: [{ id: "task-1", tags: ["safe"] }] };
  assert.equal(await tool.run(value, {}), "structured result recorded.");
  assert.deepEqual(captured, [value]);
});
