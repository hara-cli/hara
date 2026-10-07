import type { CreateNativeAgentInput } from "../org/roles.js";
import { redactSensitiveText } from "../security/secrets.js";
import type { AgentCreationApproval, Tool } from "../tools/registry.js";

const FIELDS = new Set(["username", "name", "role", "description", "instructions"]);

/** A proposal is not an authority grant. No model, endpoint, credential, tool or runtime settings
 * are accepted here; the saved colleague follows the Space model and ordinary permission gates. */
export function agentCreationProposal(input: unknown): AgentCreationApproval {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provide an Agent proposal.");
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !FIELDS.has(key))) {
    throw new Error("Agent creation cannot grant tools, coding runtimes, credentials or a model override.");
  }
  const field = (name: string, max: number): string => {
    const raw = record[name];
    if (typeof raw !== "string" || !raw.trim() || raw.length > max || /[\u0000\u001b]/.test(raw)) {
      throw new Error(`${name} must contain 1-${max} characters without NUL or escape bytes.`);
    }
    const value = raw.trim();
    if (redactSensitiveText(value).text !== value) throw new Error("Do not put credentials in an Agent profile or instructions.");
    return value;
  };
  const username = field("username", 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username) || username === "main" || username === "readme") {
    throw new Error("Use a non-reserved lowercase Agent username: letters, numbers, dots, dashes or underscores.");
  }
  return {
    kind: "agent-create",
    username,
    name: field("name", 64),
    role: field("role", 128),
    description: field("description", 300),
    instructions: field("instructions", 4_000),
  };
}

export function createAgentCreationTool(deps: {
  /** Re-read the session's immutable audience both before confirmation and immediately before writing. */
  assertPersonalRoot(): void;
  create(input: CreateNativeAgentInput): Promise<{ ref: string; name: string; created: boolean }>;
}): Tool {
  return {
    name: "agent_create",
    description: "Propose a persistent personal Bot for the user's contact list, not a temporary coding worker. "
      + "First use agent_contact(action=list) to find an existing colleague, then agree on the job, boundaries and "
      + "standing instructions. Call once with the final proposal; a live human must confirm the full card before "
      + "anything is saved. Creation does not grant computer access, tools, credentials or coding permissions.",
    kind: "edit",
    input_schema: {
      type: "object",
      properties: {
        username: { type: "string", maxLength: 64, description: "Stable lowercase username; not main or readme." },
        name: { type: "string", maxLength: 64, description: "The colleague's display name." },
        role: { type: "string", maxLength: 128, description: "Short job title." },
        description: { type: "string", maxLength: 300, description: "What this colleague helps with." },
        instructions: { type: "string", maxLength: 4_000, description: "Complete standing instructions, including boundaries and handling missing evidence. Prefer under 1,000 characters; never include conversation history or secrets." },
      },
      required: ["username", "name", "role", "description", "instructions"],
    },
    classify(input) {
      try {
        deps.assertPersonalRoot();
        const approvalPresentation = agentCreationProposal(input);
        return { effect: "edit", concurrencySafe: false, requiresExplicitApproval: true, approvalPresentation };
      } catch {
        // Invalid/unauthorized input is a read-only refusal, not a card asking for unusable authority.
        return { effect: "state", concurrencySafe: false };
      }
    },
    async run(input, ctx) {
      try {
        deps.assertPersonalRoot();
        if (ctx.signal?.aborted) return "Agent creation cancelled; nothing was saved.";
        const proposal = agentCreationProposal(input);
        const result = await deps.create({
          id: proposal.username,
          description: proposal.description,
          instructions: proposal.instructions,
          profile: { displayName: proposal.name, title: proposal.role, bio: proposal.description },
        });
        return JSON.stringify({ ...result, permissionsGranted: false });
      } catch (error) {
        return "Error: " + redactSensitiveText(error instanceof Error ? error.message : String(error)).text.slice(0, 1_000);
      }
    },
  };
}
