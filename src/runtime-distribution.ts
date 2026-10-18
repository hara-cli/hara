/** Compiled packaging contract. Native builders verify the exact installed Pi SDK before baking it. */
export const runtimeDistribution = Object.freeze({ schemaVersion: 1, preinstalled: ["pi"], piSdkVersion: "1.1.0",
  optional: ["opencode", "codex", "claude"], installation: "workspace-approved-download-verify-register" });
