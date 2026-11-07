// Codex second-turn cases: unload hang and notSubscribed. Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^unload \{"unload(Hang|Status":"notSubscribed")/u.test(name));
