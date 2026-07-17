// Atomization planner — the execution methodology made real:
// FRAME the task → ATOMIZE into smallest verifiable steps → SEQUENCE as a DAG →
// execute each atom (optionally routed to a role) → VERIFY gate. State is the SSOT
// at .hara/org/plan.json. This is hara's differentiator: not one agent, an org that plans.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../providers/types.js";
import { boundedProviderTurn } from "../providers/bounded-turn.js";
import { roleCatalog, type Role } from "./roles.js";
import { runShell, type SandboxMode } from "../sandbox.js";
import { readModelContextFileSync, readVerifiedRegularFileSnapshot } from "../fs-read.js";
import { atomicWriteText, bindAtomicWritePath } from "../fs-write.js";

export type AtomStatus = "pending" | "running" | "done" | "failed";
export interface Atom {
  id: string;
  title: string;
  detail?: string;
  deps: string[];
  verify?: string; // observable done-criteria (LLM-checked if no `check`)
  check?: string; // shell command that exits 0 iff this step is done (objective gate)
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
{"atoms":[{"id":"a1","title":"imperative step","detail":"how/where","deps":[],"verify":"observable done-criteria","check":"shell command exiting 0 iff done (optional)","role":"<roleId or omit>"}]}
Rules: short ids (a1,a2,…); deps reference earlier ids only; typically 3-8 atoms; each atom small and verifiable. Prefer a concrete 'check' command (e.g. "npm test", "tsc --noEmit", "test -f src/x.ts") so a step is verified objectively; omit 'check' if none fits.`;

/** Ask the model to decompose `task` into an atomized, sequenced plan. */
export async function decompose(
  provider: Provider,
  task: string,
  roles: Role[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Plan> {
  const eligibleRoles = roles.filter((role) => role.modelInvocable !== false);
  const catalog = roleCatalog(eligibleRoles);
  const roleHint = catalog
    ? `\nAvailable roles for the optional "role" field:\n${catalog}\n` +
      "Assign a role only when its specialization materially fits the atom. A read-only role may analyze, " +
      "research, or verify, but must not own an atom that changes files or executes deployment."
    : "";
  const r = await boundedProviderTurn(provider, {
    system: PLAN_SYSTEM + roleHint,
    history: [{ role: "user", content: `Task: ${task}\n\nReturn the JSON plan.` }],
    tools: [],
    onText: () => {},
  }, { timeoutMs: opts.timeoutMs ?? 60_000, signal: opts.signal, label: "plan decomposition" });
  if (r.stop === "error") return { task, atoms: [], createdAt: new Date().toISOString() };
  const roleIds = new Set(eligibleRoles.map((role) => role.id));
  const atoms = parsePlan(r.text);
  for (const atom of atoms) {
    if (atom.role && !roleIds.has(atom.role)) atom.role = undefined;
  }
  return { task, atoms, createdAt: new Date().toISOString() };
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
      check: typeof a.check === "string" && a.check ? a.check : undefined,
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

/** Group atoms into dependency "waves": every atom in a wave depends only on atoms in EARLIER waves, so a
 *  wave's atoms are mutually independent and may run concurrently. Preserves atom order; errors on a cycle. */
export function topoWaves(atoms: Atom[]): { ok: Atom[][] } | { error: string } {
  const byId = new Map(atoms.map((a) => [a.id, a]));
  const remaining = new Map(atoms.map((a) => [a.id, a]));
  const done = new Set<string>();
  const waves: Atom[][] = [];
  while (remaining.size) {
    const wave = [...remaining.values()].filter((a) => a.deps.every((d) => !byId.has(d) || done.has(d)));
    if (!wave.length) return { error: "plan has a dependency cycle — cannot sequence" };
    for (const a of wave) remaining.delete(a.id);
    for (const a of wave) done.add(a.id);
    waves.push(wave);
  }
  return { ok: waves };
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
export async function verify(
  provider: Provider,
  atom: Atom,
  transcriptTail: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ ok: boolean; reason: string }> {
  const r = await boundedProviderTurn(provider, {
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
  }, { timeoutMs: opts.timeoutMs ?? 30_000, signal: opts.signal, label: "plan verification" });
  if (r.stop === "error") return { ok: false, reason: r.errorMsg?.slice(0, 200) || "plan verification failed" };
  const t = r.text.trim();
  if (/^done\b/i.test(t)) return { ok: true, reason: "verified" };
  return { ok: false, reason: t.replace(/^needswork:?\s*/i, "").slice(0, 200) || "did not meet criteria" };
}

/** Objective gate: run the atom's `check` shell command; exit 0 = pass. */
export async function runCheck(cmd: string, cwd: string, sandbox: SandboxMode): Promise<{ ok: boolean; reason: string }> {
  try {
    const { stdout } = await runShell(cmd, cwd, sandbox, { timeout: 120_000, maxBuffer: 1_000_000 });
    return { ok: true, reason: (stdout.trim().split("\n").pop() || "ok").slice(0, 200) };
  } catch (e: any) {
    const out = (e?.stderr || e?.stdout || e?.message || "").toString().trim();
    return { ok: false, reason: (out.split("\n").pop() || `exit ${e?.code ?? "?"}`).slice(0, 200) };
  }
}

const planFile = (cwd: string): string => join(cwd, ".hara", "org", "plan.json");
const planWriteTails = new Map<string, Promise<void>>();

/** SSOT: persist plan state so it's inspectable / resumable. */
export async function savePlan(cwd: string, plan: Plan): Promise<void> {
  const p = planFile(cwd);
  const previous = planWriteTails.get(p) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    // Serialize the live shared plan inside the per-path queue so parallel atoms cannot overwrite a newer
    // sibling state with an older snapshot. The atomic writer binds parent identity and rejects links.
    const text = JSON.stringify(plan, null, 2);
    const boundary = bindAtomicWritePath(p, "save plan");
    let snapshot: Awaited<ReturnType<typeof readVerifiedRegularFileSnapshot>> | null = null;
    try {
      snapshot = await readVerifiedRegularFileSnapshot(boundary.target, undefined, "save plan");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    await atomicWriteText(boundary.target, text, {
      expected: snapshot?.text ?? null,
      expectedIdentity: snapshot ?? undefined,
      boundary,
    });
  });
  planWriteTails.set(p, operation);
  try {
    await operation;
  } finally {
    if (planWriteTails.get(p) === operation) planWriteTails.delete(p);
  }
}
export function loadPlan(cwd: string): Plan | null {
  const p = planFile(cwd);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readModelContextFileSync(p, 64 * 1024 * 1024)) as Plan;
  } catch {
    return null;
  }
}
