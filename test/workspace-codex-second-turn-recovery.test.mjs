// Codex second-turn cases: MCP initialization failure and missing rollout. Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^(required MCP initialization failure|a nonempty missing rollout)/u.test(name));
