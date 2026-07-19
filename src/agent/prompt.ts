import { createHash } from "node:crypto";
import type {
  SystemPromptPart,
  SystemPromptSource,
  SystemPromptStability,
} from "../providers/types.js";

export interface AssembledSystemPrompt {
  /** Provider-compatible full prompt. */
  text: string;
  /** Deterministic prefix boundaries used by cache-aware providers and diagnostics. */
  parts: SystemPromptPart[];
}

const STABILITY_ORDER: Record<SystemPromptStability, number> = {
  static: 0,
  session: 1,
  turn: 2,
};

function promptDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Assemble the model's runtime context as a governed object instead of an ever-growing string.
 *
 * Ordering is intentionally monotonic. If a caller tries to place stable material after a dynamic task
 * suffix, fail during assembly instead of silently destroying provider prefix-cache locality. */
export class PromptAssembler {
  private readonly parts: SystemPromptPart[] = [];
  private readonly ids = new Set<string>();
  private lastStability: SystemPromptStability = "static";

  add(
    id: string,
    stability: SystemPromptStability,
    source: SystemPromptSource,
    content: string | undefined,
  ): this {
    const normalizedId = id.trim();
    const normalizedContent = content?.trim();
    if (!normalizedContent) return this;
    if (!normalizedId) throw new Error("system prompt part id must not be empty");
    if (this.ids.has(normalizedId)) throw new Error(`duplicate system prompt part id: ${normalizedId}`);
    if (this.parts.length && STABILITY_ORDER[stability] < STABILITY_ORDER[this.lastStability]) {
      throw new Error(`system prompt part '${normalizedId}' (${stability}) cannot follow ${this.lastStability} context`);
    }
    this.ids.add(normalizedId);
    this.lastStability = stability;
    this.parts.push({
      id: normalizedId,
      stability,
      source,
      content: normalizedContent,
      digest: promptDigest(normalizedContent),
    });
    return this;
  }

  build(): AssembledSystemPrompt {
    const parts = this.parts.map((part) => ({ ...part }));
    return {
      text: parts.map((part) => part.content).join("\n\n"),
      parts,
    };
  }
}
