// Dispatcher — route a task to the role that OWNs it (keyword match first, LLM fallback).
import type { Role } from "./roles.js";

/** Deterministic routing by `owns`/`rejects` keywords. null if no clear owner. */
export function routeByKeywords(task: string, roles: Role[]): { role: Role; score: number } | null {
  const t = task.toLowerCase();
  let best: { role: Role; score: number } | null = null;
  for (const r of roles) {
    if (r.rejects.some((k) => k && t.includes(k.toLowerCase()))) continue;
    const score = r.owns.filter((k) => k && t.includes(k.toLowerCase())).length;
    if (score > 0 && (!best || score > best.score)) best = { role: r, score };
  }
  return best;
}

/** Prompt for the LLM dispatcher fallback. */
export function buildDispatchPrompt(task: string, roles: Role[]): string {
  const list = roles.map((r) => `- ${r.id}: ${r.description}`).join("\n");
  return `You are the dispatcher in an engineering org. Pick the single best role to own this task.

Roles:
${list}

Task: ${task}

Reply with ONLY the role id, nothing else.`;
}

/** Resolve a role id from free-form dispatcher output. */
export function parseRoleId(text: string, roles: Role[]): Role | null {
  const t = text.toLowerCase();
  // prefer an exact whole-token id match, else substring
  for (const r of roles) {
    const re = new RegExp(`\\b${r.id.toLowerCase().replace(/[^a-z0-9]/g, "\\$&")}\\b`);
    if (re.test(t)) return r;
  }
  for (const r of roles) if (t.includes(r.id.toLowerCase())) return r;
  return null;
}
