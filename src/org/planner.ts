// Atomization planner — the execution methodology made real:
// FRAME the task → ATOMIZE into smallest verifiable steps → SEQUENCE as a DAG →
// execute each atom (optionally routed to a role) → VERIFY gate. State is the SSOT
// at .hara/org/plan.json. This is hara's differentiator: not one agent, an org that plans.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../providers/types.js";
import type { Role } from "./roles.js";

export type AtomStatus = "pending" | "running" | "done" | "failed";
export interface Atom {
  id: string;
  title: string;
  detail?: string;
  deps: string[];
  verify?: string; // observable done-criteria
  role?: string; // optional role id to route this atom to
  status: AtomStatus;
  note?: string; // verify result / failure reason
}
export interface Plan {
  task: string;
  atoms: Atom[];
  createdAt: string;
}

const PLAN_SYSTEM = `You are hara's planner. Decompose a coding task using this method:
1) FRAME the goal in one sentence.
2) ATOMIZE into the smallest independently-verifiable steps.
3) SEQUENCE them with dependencies (a step lists the ids it depends on).
Return ONLY a JSON object, no prose:
{"atoms":[{"id":"a1","title":"imperative step","detail":"how/where","deps":[],"verify":"observable done-criteria","role":"<roleId or omit>"}]}
Rules: short ids (a1,a2,…); deps reference earlier ids only; typically 3-8 atoms; each atom small and verifiable.`;

/** Ask the model to decompose `task` into an atomized, sequenced plan. */
export async function decompose(provider: Provider, task: string, roles: Role[]): Promise<Plan> {
  const roleHint = roles.length ? `\nAvailable roles for the optional "role" field: ${roles.map((r) => r.id).join(", ")}.` : "";
  const r = await provider.turn({
    system: PLAN_SYSTEM + roleHint,
    history: [{ role: "user", content: `Task: ${task}\n\nReturn the JSON plan.` }],
    tools: [],
    onText: () => {},
  });
  return { task, atoms: parsePlan(r.text), createdAt: new Date().toISOString() };
}

/** Extract + normalize atoms from the model's (possibly fenced/noisy) JSON reply. */
export function parsePlan(text: string): Atom[] {
  const json = extractJson(text);
  if (!json) return [];
  let raw: any;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.atoms) ? raw.atoms : [];
  const atoms: Atom[] = [];
  list.forEach((a: any, i: number) => {
    if (!a || typeof a.title !== "string") return;
    atoms.push({
      id: typeof a.id === "string" && a.id ? a.id : `a${i + 1}`,
      title: a.title.trim(),
      detail: typeof a.detail === "string" ? a.detail : undefined,
      deps: Array.isArray(a.deps) ? a.deps.filter((d: any) => typeof d === "string") : [],
      verify: typeof a.verify === "string" ? a.verify : undefined,
      role: typeof a.role === "string" && a.role ? a.role : undefined,
      status: "pending",
    });
  });
  return atoms;
}

function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

/** Topological order (Kahn). Unknown deps are ignored; returns an error on a cycle. */
export function topoOrder(atoms: Atom[]): { ok: Atom[] } | { error: string } {
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const indeg = new Map(atoms.map((a) => [a.id, 0]));
  const adj = new Map<string, string[]>(atoms.map((a) => [a.id, []]));
  for (const a of atoms) {
    for (const d of a.deps) {
      if (!byId.has(d)) continue; // ignore dangling deps
      indeg.set(a.id, (indeg.get(a.id) ?? 0) + 1);
      adj.get(d)!.push(a.id);
    }
  }
  const q = atoms.filter((a) => (indeg.get(a.id) ?? 0) === 0).map((a) => a.id);
  const order: Atom[] = [];
  while (q.length) {
    const id = q.shift()!;
    order.push(byId.get(id)!);
    for (const nx of adj.get(id)!) {
      indeg.set(nx, indeg.get(nx)! - 1);
      if (indeg.get(nx) === 0) q.push(nx);
    }
  }
  if (order.length !== atoms.length) return { error: "plan has a dependency cycle — cannot sequence" };
  return { ok: order };
}

/** Prompt to execute a single atom in the context of the overall plan. */
export function atomPrompt(atom: Atom, plan: Plan, done: Atom[]): string {
  const priors = done.length ? `Already completed: ${done.map((a) => a.title).join("; ")}.\n` : "";
  return (
    `You are executing ONE step of a larger plan — do only this step.\n` +
    `Overall task: ${plan.task}\n` +
    `${priors}` +
    `This step (${atom.id}): ${atom.title}\n` +
    (atom.detail ? `Details: ${atom.detail}\n` : "") +
    `Done when: ${atom.verify ?? "the step is complete"}\n` +
    `Use tools as needed. Finish with a one-line result.`
  );
}

/** Soft verification gate: ask the model whether the atom met its done-criteria. */
export async function verify(provider: Provider, atom: Atom, transcriptTail: string): Promise<{ ok: boolean; reason: string }> {
  const r = await provider.turn({
    system:
      "You verify whether a coding step met its done-criteria. " +
      "Reply EXACTLY 'DONE' if met, or 'NEEDSWORK: <short reason>' if not. No other text.",
    history: [
      {
        role: "user",
        content: `Step: ${atom.title}\nDone-criteria: ${atom.verify ?? "step complete"}\n\nWhat the agent did:\n${transcriptTail.slice(0, 4000)}\n\nVerdict:`,
      },
    ],
    tools: [],
    onText: () => {},
  });
  const t = r.text.trim();
  if (/^done\b/i.test(t)) return { ok: true, reason: "verified" };
  return { ok: false, reason: t.replace(/^needswork:?\s*/i, "").slice(0, 200) || "did not meet criteria" };
}

function planDir(cwd: string): string {
  const d = join(cwd, ".hara", "org");
  mkdirSync(d, { recursive: true });
  return d;
}
const planFile = (cwd: string): string => join(planDir(cwd), "plan.json");

/** SSOT: persist plan state so it's inspectable / resumable. */
export function savePlan(cwd: string, plan: Plan): void {
  writeFileSync(planFile(cwd), JSON.stringify(plan, null, 2), "utf8");
}
export function loadPlan(cwd: string): Plan | null {
  const p = planFile(cwd);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Plan;
  } catch {
    return null;
  }
}
