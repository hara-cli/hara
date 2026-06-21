// Render a saved session to a readable Markdown transcript — for sharing a decision, pasting into a PR,
// or archiving. Pure (no I/O) so it's testable; `hara export` wires it to loadSession + an optional file.
import type { SessionData } from "./session/store.js";

const CAP = 4000; // per tool-result body, so a giant log doesn't bloat the transcript

/** A session → Markdown: a header (title/model/cwd/date) then each turn (you / hara / tool results). */
export function renderSessionMarkdown(data: SessionData): string {
  const { meta, history } = data;
  const out: string[] = [
    `# ${meta.title || meta.id}`,
    "",
    `- **session** \`${meta.id}\``,
    `- **model** ${meta.provider}:${meta.model}`,
    `- **cwd** ${meta.cwd}`,
    `- **created** ${meta.createdAt}`,
    "",
    "---",
    "",
  ];
  for (const m of history) {
    if (m.role === "user") {
      const text = (m.content ?? "").trim();
      if (text) out.push("## 🧑 You", "", text, "");
    } else if (m.role === "assistant") {
      const parts: string[] = [];
      if (m.text?.trim()) parts.push(m.text.trim());
      for (const tu of m.toolUses ?? []) {
        const input = JSON.stringify(tu.input ?? {});
        parts.push(`> 🔧 \`${tu.name}\`${input && input !== "{}" ? ` \`${input.length > 200 ? input.slice(0, 200) + "…" : input}\`` : ""}`);
      }
      if (parts.length) out.push("## 🤖 hara", "", parts.join("\n\n"), "");
    } else {
      for (const r of m.results ?? []) {
        const body = String(r.content ?? "").trim();
        if (!body) continue;
        out.push(
          `<details><summary>↳ ${r.name}${r.isError ? " (error)" : ""}</summary>`,
          "",
          "```",
          body.length > CAP ? body.slice(0, CAP) + `\n…[${body.length - CAP} more chars]` : body,
          "```",
          "",
          "</details>",
          "",
        );
      }
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
