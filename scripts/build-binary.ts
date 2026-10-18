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
if (pi.name !== "@earendil-works/pi-coding-agent" || pi.version !== "1.1.0") throw new Error("Bundled Pi SDK must be exactly 1.1.0");
const result = await Bun.build({
  entrypoints: [entrypoint],
  // @ts-expect-error Bun's native compile API is ahead of the bundled TypeScript declarations.
  compile: { outfile, ...(target ? { target } : {}), autoloadBunfig: false, autoloadDotenv: false,
    autoloadPackageJson: false, autoloadTsconfig: false },
  define: { "process.env.HARA_BUILD_VERSION": JSON.stringify(version),
    "__HARA_BUNDLED_PI_SDK_VERSION__": JSON.stringify(pi.version),
    "__HARA_BUNDLED_THIRD_PARTY_NOTICES__": JSON.stringify(thirdPartyNotices) },
  plugins: [{ name: "stub-react-devtools", setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, args => ({ path: args.path, namespace: "stub-devtools" }));
    build.onLoad({ filter: /.*/, namespace: "stub-devtools" }, () => ({ contents: "export default {}; export const connectToDevTools = () => {};", loader: "js" }));
  } }],
});
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
console.log(`✓ built ${outfile}${target ? ` (${target})` : ""} [pi-only]`);
