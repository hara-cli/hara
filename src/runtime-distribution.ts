import { OPTIONAL_RUNTIMES, OPTIONAL_RUNTIME_PACKAGES } from "./workspace/runtime-catalog.js";

/** Compiled packaging contract. Native builders verify the exact installed Pi SDK before baking it. */
export const runtimeDistribution = Object.freeze({ schemaVersion: 1, preinstalled: ["pi"], piSdkVersion: "1.5.0",
  optional: [...OPTIONAL_RUNTIMES], installation: "workspace-approved-download-verify-register" });

/** Optional host distribution; never hydrated into the Pi-only formal package. */
export const optionalRuntimeDistributions = OPTIONAL_RUNTIME_PACKAGES;
