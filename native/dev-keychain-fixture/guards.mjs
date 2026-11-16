// Mechanical guard fixtures only. No production build/sign/publish caller imports this module.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DEV_SERVICE, FakeLocks } from "./fake-vault.mjs";
import { FixtureError } from "./protocol.mjs";
const reject = () => { throw new FixtureError("invalid_request"); };
const digest = value => createHash("sha256").update(value).digest("hex");
const hashString = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const plain = value => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value, allowed) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"))) reject();
}
export function helperCacheKey(input) {
  keys(input, ["sources", "sdk", "clang", "target", "minOS", "compileArgs", "linkArgs", "identifier", "protocolVersion", "service"]);
  if (!plain(input.sources) || !Object.keys(input.sources).length || Object.entries(input.sources).some(([name, sha]) =>
    !/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === ".." || !hashString(sha))
    || [input.sdk, input.clang, input.target, input.minOS].some(v => typeof v !== "string" || !v || v.length > 256 || /[\/\\]/.test(v))
    || input.identifier !== "com.nanhara.hara.dev.keychain-helper" || input.protocolVersion !== 1 || input.service !== DEV_SERVICE) reject();
  const compileAllowed = ["-O0", "-O1", "-O2", "-Os", "-fobjc-arc", "-g0"];
  if (!Array.isArray(input.compileArgs) || input.compileArgs.some(a => !compileAllowed.includes(a))
    || !Array.isArray(input.linkArgs) || input.linkArgs.some(a => !["-framework", "Foundation", "Security"].includes(a))) reject();
  return digest(JSON.stringify({ sources: Object.fromEntries(Object.entries(input.sources).sort(([a], [b]) => a.localeCompare(b))),
    sdk: input.sdk, clang: input.clang, target: input.target, minOS: input.minOS, compileArgs: input.compileArgs,
    linkArgs: input.linkArgs, identifier: input.identifier, protocolVersion: input.protocolVersion, service: input.service }));
}
export class FakeHelperCache {
  entries = new Map(); admissions = new Map(); locks = new FakeLocks();
  constructor({ compile, sign }) { this.compile = compile; this.sign = sign; }
  async resolve(inputs, assembly) {
    keys(assembly, ["coreSha", "deskSha"]);
    if ([assembly.coreSha, assembly.deskSha].some(v => typeof v !== "string" || !/^[a-f0-9]{40}$/.test(v))) reject();
    const key = helperCacheKey(inputs);
    return this.locks.run(key, async () => {
    let artifact = this.entries.get(key), reused = Boolean(artifact);
    if (!artifact && this.admissions.has(key)) throw new FixtureError("unavailable");
    if (!artifact) {
      const bytes = await this.compile(inputs), signed = await this.sign(bytes);
      if (!Buffer.isBuffer(signed.bytes) || !/^[a-f0-9]{40}$/.test(signed.cdhash) || signed.identifier !== inputs.identifier) reject();
      artifact = { bytes: Buffer.from(signed.bytes), sha256: digest(signed.bytes), cdhash: signed.cdhash, identifier: signed.identifier };
      this.entries.set(key, artifact); this.admissions.set(key, Object.freeze({ sha256: artifact.sha256, cdhash: artifact.cdhash, identifier: artifact.identifier }));
    }
    const admitted = this.admissions.get(key);
    if (!admitted || ["sha256", "cdhash", "identifier"].some(k => artifact[k] !== admitted[k]) || !Buffer.isBuffer(artifact.bytes) || digest(artifact.bytes) !== artifact.sha256 || artifact.identifier !== inputs.identifier) throw new FixtureError("unavailable");
    return { key, reused, sha256: artifact.sha256, cdhash: artifact.cdhash,
      binding: { ...assembly, helperInputKey: key, helperSha256: artifact.sha256 } };
    });
  }
}
const FORMAL_DEFINES = ["__HARA_WINDOWS_VAULT_SHA256__", "process.env.HARA_BUILD_VERSION",
  "__HARA_BUNDLED_PI_SDK_VERSION__", "__HARA_BUNDLED_THIRD_PARTY_NOTICES__"];
export function assertFormalBuildSpec(options, { mode, resources = [], trustedPlugins = [] } = {}) {
  keys(options, ["entrypoints", "compile", "define", "plugins"]);
  if (!["pi-only", "desktop-sidecar"].includes(mode) || !Array.isArray(resources)
    || resources.some(name => name !== "hara-credential-worker.exe")
    || !Array.isArray(options.entrypoints) || options.entrypoints.length !== 1 || options.entrypoints[0] !== "dist/cli.js") reject();
  if (!Array.isArray(options.plugins) || !Array.isArray(trustedPlugins) || options.plugins.length !== trustedPlugins.length
    || options.plugins.some((plugin, i) => plugin !== trustedPlugins[i])) reject();
  keys(options.define, FORMAL_DEFINES); // Presence rejects unknown/Dev keys, even when their value is false.
  if (Object.values(options.define).some(value => typeof value !== "string")) reject();
  keys(options.compile, ["outfile", "target", "autoloadBunfig", "autoloadDotenv", "autoloadPackageJson", "autoloadTsconfig"]);
  if (typeof options.compile.outfile !== "string" || !options.compile.outfile
    || ["autoloadBunfig", "autoloadDotenv", "autoloadPackageJson", "autoloadTsconfig"].some(k => options.compile[k] !== false)) reject();
  if (options.compile.target !== undefined && !/^bun-(darwin|linux|windows)-(arm64|x64)(-baseline)?$/.test(options.compile.target)) reject();
}
export function assertFormalModuleGraph(modules) {
  if (!Array.isArray(modules) || !modules.length || modules.some(name => typeof name !== "string"
    || /(^|[\/\\])dev-cli(?:\.|[\/\\]|$)|dev-keychain|credentials\.dev\.v1/i.test(name))) reject();
}
const needles = ["credentials.dev.v1", "HARA_DEV_CREDENTIAL_VAULT_ONLY_V1", "hara-dev-keychain-helper"]
  .flatMap(value => [Buffer.from(value, "utf8"), Buffer.from(value, "utf16le")]);
const overlap = Math.max(...needles.map(b => b.length)) - 1;
function executableFamily(fd, size) {
  const head = Buffer.alloc(64); const count = fs.readSync(fd, head, 0, 64, 0);
  if (count >= 32 && ["cffaedfe", "feedfacf", "cefaedfe", "feedface"].includes(head.subarray(0, 4).toString("hex"))) return "mach-o";
  if (count >= 64 && head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && [1, 2].includes(head[4]) && [1, 2].includes(head[5])) return "elf";
  if (count >= 64 && head.toString("ascii", 0, 2) === "MZ") {
    const offset = head.readUInt32LE(0x3c), signature = Buffer.alloc(4);
    if (BigInt(offset) + 4n <= size && fs.readSync(fd, signature, 0, 4, offset) === 4 && signature.equals(Buffer.from([0x50, 0x45, 0, 0]))) return "pe";
  }
  reject(); // A namespace scan is not a replacement for the existing architecture/signature gates.
}
export function inspectFormalSidecar(file, expectedSha256) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !hashString(expectedSha256)) reject();
  let fd;
  try {
    if (fs.realpathSync(file) !== path.resolve(file)) reject();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n || before.size > 512n * 1024n * 1024n) reject();
    const format = executableFamily(fd, before.size);
    const hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024); let carry = Buffer.alloc(0), total = 0n;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null); if (!count) break;
      total += BigInt(count); if (total > before.size) reject();
      const bytes = chunk.subarray(0, count); hash.update(bytes);
      const window = Buffer.concat([carry, bytes]); if (needles.some(needle => window.includes(needle))) reject();
      carry = Buffer.from(window.subarray(Math.max(0, window.length - overlap)));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (total !== before.size || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(k => before[k] !== after[k])) reject();
    const sha256 = hash.digest("hex"); if (sha256 !== expectedSha256) reject();
    return { file, sha256, format, dev: String(before.dev), ino: String(before.ino), size: String(before.size), mtimeNs: String(before.mtimeNs) };
  } catch { reject(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export async function fakeFormalPipeline(options, context, hooks) {
  assertFormalBuildSpec(options, context);
  assertFormalModuleGraph(context.modules);
  const artifact = await hooks.compile(options); // Explicit injected fake; there is no default tool execution.
  const checked = inspectFormalSidecar(artifact.file, artifact.sha256);
  if (hooks.beforeSign) await hooks.beforeSign();
  const current = inspectFormalSidecar(artifact.file, artifact.sha256);
  if (["dev", "ino", "size", "mtimeNs", "sha256", "format"].some(k => checked[k] !== current[k])) reject();
  await hooks.sign(current); await hooks.publish(current);
  return current;
}
