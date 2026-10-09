// Compile hara into a single self-contained executable with `bun build --compile`, so it can be
// installed without Node. Run AFTER `tsc` (the guarded CLI entry then loads dist/index.js).
//   bun scripts/build-binary.ts [outfile] [bun-target] [entrypoint] [embedded|desktop-sidecar]
// e.g.  bun scripts/build-binary.ts dist/bin/hara
//       bun scripts/build-binary.ts dist/bin/hara-linux-x64 bun-linux-x64   (cross-compile)
//
// ink lazily imports `react-devtools-core` only when DEV=true; that branch never runs in a shipped
// binary, but Bun's bundler still resolves the static import inside ink's devtools.js. We stub it to an
// empty module so the binary builds clean (and stays smaller) without pulling in the dev-only dependency.
import { codeRuntimeTarget, prepareBundledCodeRuntime, bundledCodeRuntimeModule } from "./bundled-opencode.mjs";
const outfile = process.argv[2] || "dist/bin/hara";
const requestedTarget = process.argv[3]; // optional cross-compile target, e.g. bun-linux-x64 / bun-darwin-arm64
// Private acceptance builds can compile a candidate emitted outside the live CLI distribution.
const entrypoint = process.argv[4] ?? "dist/cli.js";
// Desktop already ships the checksum-pinned OpenCode externalBin. Keep that artifact as its one
// runtime source instead of also embedding a second copy in the Hara sidecar.
const codeRuntimeMode = process.argv[5] ?? "embedded";
if (codeRuntimeMode !== "embedded" && codeRuntimeMode !== "desktop-sidecar") {
  throw new Error("unsupported coding runtime packaging mode");
}
// Bun's unqualified x64 targets assume a newer CPU. Release binaries must also run on older Intel Macs,
// pre-Haswell Linux hosts, and their Windows equivalents, so make the compatibility choice fail-safe even
// if a caller forgets the explicit `-baseline` suffix.
const normalizedTarget = requestedTarget && /^bun-(?:darwin|linux|windows)-x64$/.test(requestedTarget)
  ? `${requestedTarget}-baseline`
  : requestedTarget;
// An omitted standalone target must not embed a baseline runtime in a modern-CPU Hara executable.
// Desktop may intentionally omit its target after verifying the native baseline Bun compiler.
const target = normalizedTarget || (codeRuntimeMode === "embedded" ? codeRuntimeTarget(undefined).bunTarget : undefined);

// Bake the version in — the compiled binary has no package.json on its virtual FS to read at runtime.
const version = JSON.parse(await Bun.file("package.json").text()).version as string;
const thirdPartyNotices = await Bun.file("THIRD_PARTY_NOTICES.md").text();
// Pi discovers its version through package.json in Node. A compiled executable has no adjacent npm
// package: bake only the exact installed SDK version, never an environment-controlled substitute.
const piMetadata = JSON.parse(await Bun.file("node_modules/@earendil-works/pi-coding-agent/package.json").text());
if (piMetadata.name !== "@earendil-works/pi-coding-agent" || piMetadata.version !== "1.1.0") {
  throw new Error("the bundled Pi SDK must match the reviewed exact version 1.1.0");
}

const bundledCodeRuntime = codeRuntimeMode === "embedded" ? await prepareBundledCodeRuntime(target) : undefined;
let embeddedModuleCount = 0;
let result;
try {
result = await Bun.build({
  entrypoints: [entrypoint],
  // @ts-expect-error — `compile` is a valid Bun.build option (produces a standalone executable)
  compile: {
    outfile,
    ...(target ? { target } : {}),
    // A Hara binary is routinely launched inside untrusted projects. Bun enables these two loaders by
    // default for standalone executables; a project bunfig preload would otherwise execute before Hara's
    // own permission and sensitive-file boundaries, and a project .env would silently enter our process.
    // Keep every ambient project config loader explicitly disabled so future Bun defaults cannot weaken it.
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadPackageJson: false,
    autoloadTsconfig: false,
  },
  define: {
    "process.env.HARA_BUILD_VERSION": JSON.stringify(version),
    "__HARA_BUNDLED_PI_SDK_VERSION__": JSON.stringify(piMetadata.version),
    "__HARA_BUNDLED_THIRD_PARTY_NOTICES__": JSON.stringify(thirdPartyNotices),
  },
  plugins: [
    ...(bundledCodeRuntime ? [{
      name: "embed-locked-coding-runtime",
      setup(build) {
        build.onLoad({ filter: /[\\/]coding[\\/]bundled-opencode\.js$/ }, async (args) => {
          embeddedModuleCount += 1;
          if (embeddedModuleCount !== 1) throw new Error("duplicate bundled coding runtime module");
          return {
            contents: bundledCodeRuntimeModule(await Bun.file(args.path).text(), bundledCodeRuntime.manifest, bundledCodeRuntime.assetPath),
            loader: "js",
          };
        });
      },
    }] : []),
    {
      name: "stub-react-devtools",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({ path: args.path, namespace: "stub-devtools" }));
        build.onLoad({ filter: /.*/, namespace: "stub-devtools" }, () => ({ contents: "export default {}; export const connectToDevTools = () => {};", loader: "js" }));
      },
    },
  ],
});
if (result.success && bundledCodeRuntime && embeddedModuleCount !== 1) {
  throw new Error("standalone build did not embed the coding runtime module");
}
} finally {
  bundledCodeRuntime?.cleanup();
}

if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
console.log(`✓ built ${outfile}${target ? ` (${target})` : ""} [${codeRuntimeMode}]`);
