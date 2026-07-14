// ask_user — pause mid-turn to ask the user a structured question and continue with their answer.
// Mirrors Claude Code's AskUserQuestion / cc-haha + hermes `ask_user`: use it ONLY when genuinely blocked
// on a decision only the user can make (an ambiguous requirement, a real fork in approach) — never for
// anything you can derive from the code/context. The question (and optional numbered choices) is shown
// through the SAME input channel as the approval prompt (ctx.ask), so it works in both the classic REPL and
// the TUI. In headless / non-TTY / `-p` / gateway runs there is no interactive user (ctx.ask is absent) — the
// tool returns a clear "proceed with your best judgment" string instead of hanging. kind:"read" so it never
// itself triggers the approval gate (the interaction IS the prompt).
import { registerTool, type ToolContext } from "./registry.js";

/** Returned when nobody can answer (headless / non-TTY / -p / gateway / sub-agent). Phrased so the model
 *  keeps going on its own judgment rather than re-asking or stalling. */
export const NO_INTERACTIVE_USER = "(no interactive user available — proceed with your best judgment)";

registerTool({
  name: "ask_user",
  description:
    "Ask the user ONE structured question mid-turn and wait for their answer, then continue. " +
    "Use this ONLY when you are genuinely blocked on a decision that ONLY the user can make — an ambiguous " +
    "requirement, a missing preference, or a real fork in approach where guessing wrong is costly. " +
    "Do NOT use it for anything you can infer from the code, files, or context, and do NOT use it to narrate " +
    "or ask permission for an action (the approval gate already handles that). " +
    "Provide `options` (a short list of likely answers) when the choice is constrained — they are shown as a " +
    "numbered menu — but the user may always type a free-text answer instead. The tool returns the user's " +
    "answer (chosen option or free text) as its result. " +
    "In a non-interactive run (no terminal) it returns a 'proceed with your best judgment' note instead of " +
    "blocking, so prefer making a reasonable call over asking when context already answers the question.",
  kind: "read", // the prompt itself is the interaction; never route it through the approval gate
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string", description: "the single, specific question to put to the user" },
      options: {
        type: "array",
        items: { type: "string" },
        description: "optional likely answers, shown as a numbered menu (the user may still type their own answer)",
      },
      header: { type: "string", description: "optional short label/topic for the question (e.g. 'Database choice')" },
      context: { type: "string", description: "optional one-line context shown before the question (keep it short)" },
    },
    required: ["question"],
  },
  async run(input: any, ctx: ToolContext): Promise<string> {
    const question = typeof input.question === "string" ? input.question.trim() : "";
    if (!question) return "ask_user needs a non-empty `question`.";

    // No interactive user (headless / non-TTY / -p / gateway / sub-agent): do NOT block — let the model proceed.
    if (typeof ctx.ask !== "function") return NO_INTERACTIVE_USER;

    const options = Array.isArray(input.options)
      ? input.options.map((o: unknown) => String(o ?? "").trim()).filter((o: string) => o.length > 0)
      : undefined;

    const header = typeof input.header === "string" ? input.header.trim() : "";
    const context = typeof input.context === "string" ? input.context.trim() : "";
    // Compose a compact prompt: [header] (context) question — the channel renders it.
    const prompt = [header ? `[${header}] ` : "", context ? `${context}\n` : "", question].join("");

    try {
      const answer = await ctx.ask(prompt, options && options.length ? options : undefined, ctx.signal);
      const text = typeof answer === "string" ? answer.trim() : "";
      return text || "(the user gave an empty answer)";
    } catch (e: any) {
      // Cancellation is authoritative. Let the agent loop close the open tool round as interrupted/deadline;
      // converting it into an ordinary "no user" result would let the model continue after Esc.
      if (ctx.signal?.aborted) throw e;
      // If the interactive prompt fails for any reason, degrade gracefully rather than crash the turn.
      return `${NO_INTERACTIVE_USER} (ask failed: ${e?.message ?? e})`;
    }
  },
});
