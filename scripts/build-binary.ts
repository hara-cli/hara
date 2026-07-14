// Compile hara into a single self-contained executable with `bun build --compile`, so it can be
// installed without Node. Run AFTER `tsc` (the guarded CLI entry then loads dist/index.js).
//   bun scripts/build-binary.ts [outfile] [bun-target]
// e.g.  bun scripts/build-binary.ts dist/bin/hara
//       bun scripts/build-binary.ts dist/bin/hara-linux-x64 bun-linux-x64   (cross-compile)
//
// ink lazily imports `react-devtools-core` only when DEV=true; that branch never runs in a shipped
// binary, but Bun's bundler still resolves the static import inside ink's devtools.js. We stub it to an
// empty module so the binary builds clean (and stays smaller) without pulling in the dev-only dependency.
const outfile = process.argv[2] || "dist/bin/hara";
const requestedTarget = process.argv[3]; // optional cross-compile target, e.g. bun-linux-x64 / bun-darwin-arm64
// Bun's unqualified x64 targets assume a newer CPU. Release binaries must also run on older Intel Macs,
// pre-Haswell Linux hosts, and their Windows equivalents, so make the compatibility choice fail-safe even
// if a caller forgets the explicit `-baseline` suffix.
const target = requestedTarget && /^bun-(?:darwin|linux|windows)-x64$/.test(requestedTarget)
  ? `${requestedTarget}-baseline`
  : requestedTarget;

// Bake the version in — the compiled binary has no package.json on its virtual FS to read at runtime.
const version = JSON.parse(await Bun.file("package.json").text()).version as string;

const result = await Bun.build({
  entrypoints: ["dist/cli.js"],
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
  define: { "process.env.HARA_BUILD_VERSION": JSON.stringify(version) },
  plugins: [
    {
      name: "stub-react-devtools",
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, (args) => ({ path: args.path, namespace: "stub-devtools" }));
        build.onLoad({ filter: /.*/, namespace: "stub-devtools" }, () => ({ contents: "export default {}; export const connectToDevTools = () => {};", loader: "js" }));
      },
    },
  ],
});

if (!result.success) {
  for (const m of result.logs) console.error(m);
  process.exit(1);
}
console.log(`✓ built ${outfile}${target ? ` (${target})` : ""}`);
