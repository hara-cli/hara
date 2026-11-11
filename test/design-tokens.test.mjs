import { test } from "node:test"
import assert from "node:assert/strict"
import { verify, readBlock } from "../scripts/sync-design-tokens.mjs"

// The Hara design tokens are generated in the shared design source and copied by scripts/sync-design-tokens.mjs.
// This fails when a generated file is edited by hand or the record in DESIGN.md is stale. Set HARA_DESIGN_DIST to
// also regenerate the tokens from the design source and compare them byte for byte.
test("Hara design tokens match the version recorded in DESIGN.md", async () => {
  const { problems } = await verify({ from: process.env.HARA_DESIGN_DIST })
  assert.deepEqual(problems, [])
  assert.match(readBlock().version, /^\d+\.\d+\.\d+$/)
})
