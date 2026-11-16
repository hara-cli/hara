import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
// Pi is the only preinstalled Agent runtime. Optional CLIs are approved/downloaded/verified at runtime.
// bun scripts/build-binary.ts [outfile] [bun-target] [entrypoint] [pi-only|desktop-sidecar]
const outfile = process.argv[2] || "dist/bin/hara";
const requested = process.argv[3] || (process.arch === "x64" ? `bun-${process.platform === "win32" ? "windows" : process.platform}-x64-baseline` : undefined);
const target = requested && /^bun-(?:darwin|linux|windows)-x64$/.test(requested) ? `${requested}-baseline` : requested;
const entrypoint = process.argv[4] || "dist/cli.js";
const mode = process.argv[5] || "pi-only";
if (!["pi-only", "desktop-sidecar"].includes(mode)) throw new Error("Only Pi-only standalone/sidecar packaging is supported");
const version = JSON.parse(await Bun.file("package.json").text()).version as string;
const thirdPartyNotices = await Bun.file("THIRD_PARTY_NOTICES.md").text();
const pi = JSON.parse(await Bun.file("node_modules/@earendil-works/pi-coding-agent/package.json").text());
if (pi.name !== "@earendil-works/pi-coding-agent" || pi.version !== "1.5.0") throw new Error("Bundled Pi SDK must be exactly 1.5.0");
// S1: include only an explicitly prebuilt/verified Windows worker. Host activation is separate.
let windowsVaultSha: string | undefined;
const windowsTarget = target?.startsWith("bun-windows-") || (!target && process.platform === "win32");
const vaultRoot = "dist/native/win32-x64";
if (windowsTarget && fs.existsSync(`${vaultRoot}/manifest.json`)) {
  if (target && !/^bun-windows-x64(?:-baseline)?$/.test(target) || !target && process.arch !== "x64") throw new Error("Windows credential worker requires an x64 target");
  const manifest = JSON.parse(fs.readFileSync(`${vaultRoot}/manifest.json`, "utf8"));
  const binary = fs.readFileSync(`${vaultRoot}/hara-credential-worker.exe`);
  const digest = createHash("sha256").update(binary).digest("hex");
  if (manifest.protocolVersion !== 1 || manifest.target !== "x86_64-pc-windows-msvc" || manifest.sha256 !== digest) throw new Error("Invalid Windows credential worker bundle");
  windowsVaultSha = digest;
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  fs.copyFileSync(`${vaultRoot}/hara-credential-worker.exe`, path.join(path.dirname(outfile), "hara-credential-worker.exe"));
}
const result = await Bun.build({
  entrypoints: [entrypoint],
  // @ts-expect-error Bun's native compile API is ahead of the bundled TypeScript declarations.
  compile: { outfile, ...(target ? { target } : {}), autoloadBunfig: false, autoloadDotenv: false,
    autoloadPackageJson: false, autoloadTsconfig: false },
  define: { "__HARA_WINDOWS_VAULT_SHA256__": windowsVaultSha ? JSON.stringify(windowsVaultSha) : "undefined",
    "process.env.HARA_BUILD_VERSION": JSON.stringify(version),
    "__HARA_BUNDLED_PI_SDK_VERSION__": JSON.stringify(pi.version),
    "__HARA_BUNDLED_THIRD_PARTY_NOTICES__": JSON.stringify(thirdPartyNotices) },
  plugins: [{ name: "stub-react-devtools", setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, args => ({ path: args.path, namespace: "stub-devtools" }));
    build.onLoad({ filter: /.*/, namespace: "stub-devtools" }, () => ({ contents: "export default {}; export const connectToDevTools = () => {};", loader: "js" }));
  } }],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log(`✓ built ${outfile}${target ? ` (${target})` : ""} [pi-only]`);
