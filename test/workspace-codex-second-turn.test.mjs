// Codex second-turn cases: effort change and changed standing. Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^(auto low to medium|changed standing waits)/u.test(name));
