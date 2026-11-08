import test from "node:test";
import assert from "node:assert/strict";
import { runtimeFailureDto } from "./helpers/runtime-failure-dto.mjs";
const prefix="hara_runtime_failure_v1=";
test("diagnostic consumer preserves the structured metadata when a governor hint follows it",()=>{
  const dto={runtime:"cursor",kind:"runtime_failed",elapsedMs:503,errorFirstLine:"Error: native startup rejected [path] account=[redacted]",extensionsIsolation:"inherited"};
  assert.deepEqual(runtimeFailureDto(prefix+JSON.stringify(dto)),dto);
  assert.deepEqual(runtimeFailureDto(prefix+JSON.stringify(dto)+" — provider overloaded; authorize another saved model connection for automatic fallback"),dto);
});
test("quoted braces and escaped quotes never truncate a diagnostic object",()=>{
  const dto={kind:"runtime_failed",errorFirstLine:'Error: "}" and \\ { remain quoted'};
  assert.deepEqual(runtimeFailureDto(prefix+JSON.stringify(dto)+" — bounded human hint"),dto);
});
test("missing, duplicate, nested, multiline and incomplete diagnostic objects are refused",()=>{
  for(const message of ["plain failure",prefix+"[]",prefix+'{"kind":"runtime_failed"',prefix+'{"kind":"runtime_failed","kind":"timeout"}',prefix+'{"nested":{}}',prefix+'{"kind":\n"runtime_failed"}',prefix+'{} '+prefix+'{}'])assert.throws(()=>runtimeFailureDto(message));
});
