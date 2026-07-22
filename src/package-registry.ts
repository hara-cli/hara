/** Explicit package-registry routing for npm/pnpm/yarn/bun installs. Registry switching is user-selected:
 * silently replaying an install against a public mirror can break private scopes and changes the software
 * supply-chain trust boundary. */

export function normalizePackageRegistry(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const expanded = raw === "npmjs"
    ? "https://registry.npmjs.org/"
    : raw === "npmmirror"
      ? "https://registry.npmmirror.com/"
      : raw;
  let url: URL;
  try {
    url = new URL(expanded);
  } catch {
    throw new Error("package registry must be npmjs, npmmirror, or an absolute HTTP(S) URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("package registry must be an HTTP(S) URL without credentials, query parameters, or a fragment");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

export function commandHasPackageRegistry(command: string): boolean {
  return /(?:^|\s)--registry(?:=|\s|$)/iu.test(command);
}

/** The common npm config variable is honored by npm and pnpm; explicit Yarn/Bun variables cover their
 * modern clients too. Values are injected as environment, never interpolated into a shell command. */
export function packageRegistryEnv(registry: string): Record<string, string> {
  return {
    NPM_CONFIG_REGISTRY: registry,
    YARN_NPM_REGISTRY_SERVER: registry,
    BUN_CONFIG_REGISTRY: registry,
  };
}
