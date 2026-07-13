// Schema-enforced structured output — the reliable alternative to "please answer in JSON".
// `hara -p "…" --schema '<json-schema>'` injects a run-scoped `structured_output` tool whose input_schema IS
// the caller's schema: the model must CALL it (function-calling contract does the shaping), we validate the
// payload (belt for providers with loose tool arg enforcement), and the captured value becomes the run's
// machine-readable result. Callers (gateway flows, scripts, cron) parse guaranteed JSON instead of regex-fishing
// prose. Mirrors Claude Code's StructuredOutput; kept dependency-free via an explicit JSON-Schema subset.
import type { Tool } from "../tools/registry.js";

type SchemaObject = Record<string, unknown>;

/**
 * Supported validation keywords are deliberately small and explicit:
 * - `type`: object, array, string, number, integer, boolean, null (or a union array)
 * - `required`, `properties`, and boolean `additionalProperties` for objects
 * - one schema in `items` for arrays (tuple schemas are not supported)
 * - `enum` containing JSON primitive values
 * - annotation-only `title` and `description`
 *
 * Every other JSON-Schema keyword is rejected. In particular, combinators and references such as
 * `$ref`, `allOf`, `anyOf`, `oneOf`, and `not` must never be silently accepted: doing so would make
 * the CLI promise a constraint that this dependency-free validator did not enforce.
 */
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "enum",
  "title",
  "description",
]);
const SUPPORTED_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function isSchemaObject(value: unknown): value is SchemaObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(schema: SchemaObject, key: string): unknown {
  return Object.hasOwn(schema, key) ? schema[key] : undefined;
}

function schemaTypes(schema: SchemaObject): string[] {
  const type = own(schema, "type");
  return type === undefined ? [] : Array.isArray(type) ? type as string[] : [type as string];
}

function describeSchemaValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function validateSchemaDefinition(schema: unknown, path = "$schema"): string | null {
  if (!isSchemaObject(schema)) return `${path}: schema must be a plain JSON object`;

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) return `${path}.${keyword}: unsupported JSON-Schema keyword`;
  }

  const type = own(schema, "type");
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (types.length === 0) return `${path}.type: type array must not be empty`;
    const seen = new Set<string>();
    for (const candidate of types) {
      if (typeof candidate !== "string" || !SUPPORTED_SCHEMA_TYPES.has(candidate)) {
        return `${path}.type: unsupported JSON-Schema type ${describeSchemaValue(candidate)}`;
      }
      if (seen.has(candidate)) return `${path}.type: duplicate type ${describeSchemaValue(candidate)}`;
      seen.add(candidate);
    }
  }

  for (const annotation of ["title", "description"] as const) {
    const value = own(schema, annotation);
    if (value !== undefined && typeof value !== "string") return `${path}.${annotation}: expected string`;
  }

  const enumValues = own(schema, "enum");
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues) || enumValues.length === 0) return `${path}.enum: expected a non-empty array`;
    for (const value of enumValues) {
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
        return `${path}.enum: only JSON primitive values are supported`;
      }
      if (typeof value === "number" && !Number.isFinite(value)) return `${path}.enum: numbers must be finite`;
    }
  }

  const required = own(schema, "required");
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) {
      return `${path}.required: expected an array of property names`;
    }
    if (new Set(required).size !== required.length) return `${path}.required: property names must be unique`;
  }

  const properties = own(schema, "properties");
  if (properties !== undefined) {
    if (!isSchemaObject(properties)) return `${path}.properties: expected an object of property schemas`;
    for (const [key, child] of Object.entries(properties)) {
      const error = validateSchemaDefinition(child, `${path}.properties.${key}`);
      if (error) return error;
    }
  }

  const additionalProperties = own(schema, "additionalProperties");
  if (additionalProperties !== undefined && typeof additionalProperties !== "boolean") {
    return `${path}.additionalProperties: only boolean values are supported`;
  }

  const items = own(schema, "items");
  if (items !== undefined) {
    const error = validateSchemaDefinition(items, `${path}.items`);
    if (error) return error;
  }

  const types = schemaTypes(schema);
  const hasObjectKeyword = required !== undefined || properties !== undefined || additionalProperties !== undefined;
  if (hasObjectKeyword && !types.includes("object")) {
    return `${path}: object keywords require type "object"`;
  }
  if (items !== undefined && !types.includes("array")) return `${path}: items requires type "array"`;
  return null;
}

function actualType(value: unknown): string {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = actualType(value);
  if (type === "integer") return actual === "number" && Number.isFinite(value) && Number.isInteger(value);
  if (type === "number") return actual === "number" && Number.isFinite(value);
  return type === actual;
}

function validateValue(value: unknown, schema: SchemaObject, path: string): string | null {
  const types = schemaTypes(schema);
  if (types.length && !types.some((type) => matchesType(value, type))) {
    return `${path}: expected ${types.join("|")}, got ${actualType(value)}`;
  }

  const enumValues = own(schema, "enum") as Array<string | number | boolean | null> | undefined;
  if (enumValues && !enumValues.some((candidate) => candidate === value)) {
    return `${path}: value not in enum ${JSON.stringify(enumValues)}`;
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value) && types.includes("object")) {
    const object = value as Record<string, unknown>;
    const required = own(schema, "required") as string[] | undefined;
    for (const key of required ?? []) {
      if (!Object.hasOwn(object, key)) return `${path}.${key}: required property missing`;
    }

    const properties = own(schema, "properties") as SchemaObject | undefined;
    for (const [key, child] of Object.entries(properties ?? {})) {
      if (Object.hasOwn(object, key)) {
        const error = validateValue(object[key], child as SchemaObject, `${path}.${key}`);
        if (error) return error;
      }
    }

    if (own(schema, "additionalProperties") === false) {
      for (const key of Object.keys(object)) {
        if (!properties || !Object.hasOwn(properties, key)) return `${path}.${key}: unexpected property`;
      }
    }
  }

  if (Array.isArray(value) && types.includes("array")) {
    const items = own(schema, "items") as SchemaObject | undefined;
    if (items) {
      for (let index = 0; index < value.length; index++) {
        const error = validateValue(value[index], items, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  return null;
}

/** Validate `value` against the supported JSON-Schema subset. Returns null when valid, otherwise a path-rich
 * error. Invalid or unsupported schemas are errors too; they are never treated as permissive schemas. */
export function validateAgainstSchema(value: unknown, schema: unknown, path = "$"): string | null {
  const schemaError = validateSchemaDefinition(schema);
  if (schemaError) return `invalid schema — ${schemaError}`;
  return validateValue(value, schema as SchemaObject, path);
}

/** Parse a `--schema` CLI value: inline JSON, or (by the caller) file contents. Returns the schema object or
 *  an error string. Top level must be an object schema — tool arguments are always a JSON object. */
export function parseSchemaArg(raw: string): object | { error: string } {
  let schema: unknown;
  try {
    schema = JSON.parse(raw);
  } catch (e) {
    return { error: `--schema is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isSchemaObject(schema)) return { error: "--schema must be a JSON object (a JSON-Schema)" };
  let normalized: SchemaObject = schema;
  if (!Object.hasOwn(normalized, "type")) normalized = { ...normalized, type: "object" };
  if (own(normalized, "type") !== "object") {
    return { error: "--schema top level must have type:'object' (tool args are an object)" };
  }
  if (!Object.hasOwn(normalized, "properties")) normalized = { ...normalized, properties: {} };
  const schemaError = validateSchemaDefinition(normalized);
  if (schemaError) return { error: `--schema is unsupported or invalid: ${schemaError}` };
  return normalized;
}

/** The instruction appended to the prompt so the model knows the contract. */
export const STRUCTURED_INSTRUCTION =
  "\n\nWhen you have the final answer, you MUST call the `structured_output` tool exactly once with the result " +
  "matching its schema. Do not print the result as text — the tool call IS the answer.";

/** The retry nudge when a turn ends without the tool having been called. */
export const STRUCTURED_NUDGE =
  "You finished without calling `structured_output`. Call it NOW with your final result matching the schema — the tool call is the only accepted answer.";

/** Build the run-scoped structured_output tool. `sink` receives the validated payload (last call wins). */
export function structuredOutputTool(schema: object, sink: (value: unknown) => void): Tool {
  const schemaError = validateSchemaDefinition(schema);
  if (schemaError) throw new Error(`Invalid structured-output schema: ${schemaError}`);
  return {
    name: "structured_output",
    description: "Record the final structured result of this task. Call exactly once, when done, with the complete answer.",
    input_schema: schema as Tool["input_schema"],
    kind: "read", // never prompts; the payload is data, not an action
    async run(input: unknown): Promise<string> {
      const err = validateAgainstSchema(input, schema);
      if (err) return `schema validation failed — ${err}. Fix the payload and call structured_output again.`;
      sink(input);
      return "structured result recorded.";
    },
  };
}
