import { OPTIONAL_RUNTIMES } from "./workspace/runtime-catalog.js";

/** Compiled packaging contract. Native builders verify the exact installed Pi SDK before baking it. */
export const runtimeDistribution = Object.freeze({ schemaVersion: 1, preinstalled: ["pi"], piSdkVersion: "1.5.0",
  optional: [...OPTIONAL_RUNTIMES], installation: "workspace-approved-download-verify-register" });
