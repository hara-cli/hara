// Codex second-turn cases: native exit between messages. Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^native exit between messages/u.test(name));
