/**
 * Resolve Hara's provider-neutral coding runtime.
 *
 * Desktop injects an absolute path to the checksum-pinned executable bundled beside the Hara
 * sidecar. Standalone CLI installs keep the existing, explicit PATH-based OpenCode integration.
 * The downstream process resolver still validates that an absolute candidate exists and is an
 * executable regular file before it can run.
 */
export function haraCodeRuntimeCommand(env: NodeJS.ProcessEnv = process.env): string {
  const bundled = env.HARA_CODE_RUNTIME_PATH?.trim();
  return bundled || "opencode";
}
