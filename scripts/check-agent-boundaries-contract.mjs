// Read-only cross-repository contract drift check. Never syncs/writes consumers.
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("..", import.meta.url));
const source = "src/workspace/agent-boundaries-contract.ts";
const fixture = "test/fixtures/agent-boundaries-v1.json";
const lockPath = "docs/contracts/agent-boundaries-v1.lock.json";
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const lock = JSON.parse(readFileSync(resolve(root, lockPath), "utf8"));
if (hash(resolve(root, source)) !== lock.sourceSha256 || hash(resolve(root, fixture)) !== lock.fixturesSha256) throw new Error("Core contract lock mismatch");
if (process.argv.length > 3) throw new Error("Usage: node scripts/check-agent-boundaries-contract.mjs [desktop-repository]");
if (process.argv[2]) {
  const desktop = realpathSync(resolve(process.argv[2]));
  if (JSON.parse(readFileSync(resolve(desktop, "package.json"), "utf8")).name !== "hara-desktop") throw new Error("Not a Desktop repository");
  const other = JSON.parse(readFileSync(resolve(desktop, lockPath), "utf8"));
  if (JSON.stringify(other) !== JSON.stringify(lock)
    || hash(resolve(desktop, "src/contracts/agent-boundaries-v1.ts")) !== lock.sourceSha256
    || hash(resolve(desktop, fixture)) !== lock.fixturesSha256) throw new Error("Desktop contract/fixture drift");
}
console.log("Agent boundaries C0 source/fixtures match the reviewed contract lock");
