#!/usr/bin/env node
// hara — placeholder CLI. Real agent coming soon.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
let version = "0.0.1";
try {
  version = JSON.parse(readFileSync(join(__dir, "..", "package.json"), "utf8")).version;
} catch {}

const args = process.argv.slice(2);
if (args[0] === "-v" || args[0] === "--version") {
  console.log(version);
  process.exit(0);
}

console.log(`hara v${version}
A coding agent CLI that runs like an engineering org.

This is an early placeholder — the real thing is under active development.
Track it:  https://github.com/hara-cli/hara
Site:      https://hara.run
`);
