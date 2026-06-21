// Compile hara into a single self-contained executable with `bun build --compile`, so it can be
// installed without Node. Run AFTER `tsc` (it bundles dist/index.js).
//   bun scripts/build-binary.ts [outfile] [bun-target]
// e.g.  bun scripts/build-binary.ts dist/bin/hara
//       bun scripts/build-binary.ts dist/bin/hara-linux-x64 bun-linux-x64   (cross-compile)
//
// ink lazily imports `react-devtools-core` only when DEV=true; that branch never runs in a shipped
// binary, but Bun's bundler still resolves the static import inside ink's devtools.js. We stub it to an
// empty module so the binary builds clean (and stays smaller) without pulling in the dev-only dependency.
const outfile = process.argv[2] || "dist/bin/hara";
const target = process.argv[3]; // optional cross-compile target, e.g. bun-linux-x64 / bun-darwin-arm64

// Bake the version in — the compiled binary has no package.json on its virtual FS to read at runtime.
const version = JSON.parse(await Bun.file("package.json").text()).version as string;

const result = await Bun.build({
  entrypoints: ["dist/index.js"],
  // @ts-expect-error — `compile` is a valid Bun.build option (produces a standalone executable)
  compile: { outfile, ...(target ? { target } : {}) },
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
