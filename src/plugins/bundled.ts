// First-party plugins that must remain installable from the single-file Hara binary. Keep this catalog
// deliberately small: installing one materializes reviewed, versioned text into Hara's normal plugin
// staging/verification path; it never downloads or silently enables third-party code.

const chromeManifest = {
  name: "chrome",
  version: "0.2.0",
  description:
    "With explicit Chrome approval, let hara use the tabs and signed-in session of your running Chrome via chrome-devtools-mcp. Alternative to the isolated Playwright browser — enable one, not both.",
  skills: ["skills"],
  mcpServers: {
    chrome: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest", "--autoConnect"] },
  },
};

const chromeSkill = [
  "---",
  "name: chrome-control",
  "description: Operate a REAL Chrome (with your persistent logins) for web tasks on signed-in sites — via chrome-devtools-mcp (Chrome DevTools Protocol). Use instead of the isolated Playwright `browser` plugin when the task needs your existing accounts/sessions.",
  "when_to_use: when a web task must run on a site you're logged into (your dashboards, accounts, web apps) rather than a fresh anonymous browser.",
  "---",
  "",
  "# Chrome (real, logged-in) via chrome-devtools-mcp",
  "",
  "Tools appear as `mcp__chrome__*` (navigate, click, fill, snapshot, network, performance…). They drive the",
  "running Chrome profile only after Chrome shows a connection prompt and the user approves it.",
  "",
  "## Connect to the current Chrome session",
  "1. Use Chrome 144 or newer.",
  "2. Open `chrome://inspect/#remote-debugging`, enable remote debugging, and keep Chrome running.",
  "3. Connect the `chrome` MCP when the task needs it. Chrome displays a permission dialog; approve only when the",
  "   named task and target site are expected. Chrome keeps an automation banner visible while connected.",
  "",
  "Do not use the old `--remote-debugging-port=9222` instructions against the default Chrome profile. Chrome 136+",
  "ignores remote-debugging switches for the default data directory. A manual port requires a separate",
  "`--user-data-dir`, so it does not safely reuse the ordinary profile's login state.",
  "",
  "## Enable (alternative to `browser`, not both)",
  "Running two browser MCPs at once is confusing. To switch from the isolated Playwright `browser`:",
  "`hara plugin add bundled:chrome && hara plugin disable browser`.",
  "",
  "## Caution",
  "This exposes the approved Chrome profile's open pages and browser data to the MCP while connected. Use it only",
  "in direct CLI/Desktop sessions with Hara's interactive approval channel. Do not enable trusted extensions for an",
  "unattended Hara gateway merely to bypass approval. Confirm every destructive/irreversible action (purchases,",
  "posting, sending, deleting), keep the task to the requested origin, and disconnect when the task ends.",
  "",
].join("\n");

const BUNDLED_PLUGIN_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  chrome: Object.freeze({
    ".hara-plugin/plugin.json": `${JSON.stringify(chromeManifest, null, 2)}\n`,
    "skills/chrome/SKILL.md": chromeSkill,
  }),
});

export function bundledPluginFiles(name: string): Readonly<Record<string, string>> | undefined {
  return Object.hasOwn(BUNDLED_PLUGIN_FILES, name) ? BUNDLED_PLUGIN_FILES[name] : undefined;
}
