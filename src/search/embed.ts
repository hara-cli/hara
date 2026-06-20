// Embedding providers for the semantic index — local Ollama (offline default), DashScope/Qwen, or any
// OpenAI-compatible /embeddings endpoint. Returns null when embeddings aren't configured → callers stay
// lexical. Uses global fetch (Node ≥20). No new dependency.
import type { HaraConfig } from "../config.js";
import type { Embedder } from "./semindex.js";

const DEFAULT_MODEL: Record<string, string> = {
  ollama: "nomic-embed-text",
  qwen: "text-embedding-v3",
  openai: "text-embedding-3-small",
};

/** Build an Embedder from config, or null if embeddings are off/unconfigured (→ lexical fallback). */
export function getEmbedder(cfg: HaraConfig): Embedder | null {
  const provider = cfg.embedProvider;
  if (!provider || provider === "off") return null;
  const model = cfg.embedModel || DEFAULT_MODEL[provider] || "embed";

  if (provider === "ollama") {
    const base = (cfg.embedBaseURL || "http://localhost:11434").replace(/\/$/, "");
    return async (texts) => {
      const out: number[][] = [];
      for (const input of texts) {
        const r = await fetch(`${base}/api/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, prompt: input }),
        });
        if (!r.ok) throw new Error(`ollama embeddings ${r.status}`);
        out.push((await r.json()).embedding);
      }
      return out;
    };
  }

  // qwen (DashScope compatible-mode) + any OpenAI-compatible endpoint: POST /embeddings { model, input[] }
  const base = (cfg.embedBaseURL || (provider === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : cfg.baseURL || "https://api.openai.com/v1")).replace(/\/$/, "");
  const key = cfg.embedApiKey || cfg.apiKey || "";
  return async (texts) => {
    const r = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!r.ok) throw new Error(`embeddings ${r.status}`);
    return ((await r.json()).data || []).map((d: { embedding: number[] }) => d.embedding);
  };
}
