// Codex second-turn cases: nonempty missing rollout (one case per file for the strict Intel deadline). Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^a nonempty missing rollout/u.test(name));
