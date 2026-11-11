import { test } from "node:test"
import assert from "node:assert/strict"
import { verify, readBlock } from "../scripts/sync-design-tokens.mjs"

// The Hara design tokens are generated from uiux/design-language/hara/DESIGN.md and synced by
// scripts/sync-design-tokens.mjs. This fails when a generated file is edited by hand or DESIGN.md is stale.
test("Hara design tokens match the version recorded in DESIGN.md", () => {
  assert.deepEqual(verify(), [])
  assert.match(readBlock().version, /^\d+\.\d+\.\d+$/)
})
