import { isAbsolute, resolve } from "node:path";
/** Trusted custom-provider composition only. Does not read/copy credentials or change host files.
 * configHome must be a Host-owned, separate config directory admitted as runtimeHome by the policy. */
export function claudeCustomProviderEnv(host: NodeJS.ProcessEnv, configHome: string, provider: {
  baseURL: string; apiKey?: string; authToken?: string;
}): NodeJS.ProcessEnv {
  if (configHome === "/" || !isAbsolute(configHome) || resolve(configHome) !== configHome || configHome === host.CLAUDE_CONFIG_DIR || configHome === host.HOME
    || configHome === (host.HOME ?? "") + "/.claude" || !/^https?:\/\//u.test(provider.baseURL)) throw new Error("Custom provider requires a separate trusted configuration directory");
  if (Boolean(provider.apiKey) === Boolean(provider.authToken)) throw new Error("Custom provider requires exactly one explicit credential source");
  const env = { ...host };
  for (const key of Object.keys(env)) if (/^(?:ANTHROPIC_|CLAUDE_CODE_OAUTH_)/u.test(key)) delete env[key];
  return { ...env, CLAUDE_CONFIG_DIR: configHome, ANTHROPIC_BASE_URL: provider.baseURL,
    ...(provider.apiKey ? { ANTHROPIC_API_KEY: provider.apiKey } : { ANTHROPIC_AUTH_TOKEN: provider.authToken }),
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1", CLAUDE_CODE_DISABLE_AGENT_VIEW: "1" };
}
