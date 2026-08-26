export const MINIMAX_TOKEN_PLAN_BASE_URL = "https://api.minimaxi.com/v1";

/** MiniMax's current Token Plan/Codex model catalog. Live key-scoped discovery remains authoritative. */
export const MINIMAX_TOKEN_PLAN_MODELS = Object.freeze([
  "MiniMax-M3",
]);

export function isOfficialMiniMaxEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  try {
    const url = new URL(baseURL);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "api.minimaxi.com"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && url.pathname.replace(/\/+$/, "") === "/v1";
  } catch {
    return false;
  }
}
