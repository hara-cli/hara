import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(new URL("./jev-wechat-bridge.py", import.meta.url));
const embeddedPath = fileURLToPath(new URL("../src/embedded/jev-wechat.ts", import.meta.url));
const bridge = readFileSync(bridgePath, "utf8");
const current = readFileSync(embeddedPath, "utf8");
const pattern = /(\s*"bridge\.py": decode\(")[A-Za-z0-9+/=]+("\),\s*)/;
const matches = current.match(new RegExp(pattern.source, "g")) ?? [];
if (matches.length !== 1) {
  throw new Error(`expected one embedded bridge.py entry, found ${matches.length}`);
}
const encoded = Buffer.from(bridge, "utf8").toString("base64");
const next = current.replace(pattern, `$1${encoded}$2`);
writeFileSync(embeddedPath, next, "utf8");
