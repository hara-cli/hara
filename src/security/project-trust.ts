// One process-wide, launch-time trust decision for repository-controlled configuration and identity pins.
// Capture at module evaluation so later code (including extensions) cannot widen trust by mutating process.env.
const trustedAtStartup = process.env.HARA_TRUST_PROJECT_CONFIG === "1";

export function projectRepositoryTrustedAtStartup(): boolean {
  return trustedAtStartup;
}
