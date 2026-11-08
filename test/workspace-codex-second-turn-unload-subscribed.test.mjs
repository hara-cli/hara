// Codex second-turn cases: unload notSubscribed (one case per file for the strict Intel deadline). Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^unload \{"unloadStatus":"notSubscribed"/u.test(name));
