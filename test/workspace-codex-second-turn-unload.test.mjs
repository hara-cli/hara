// Codex second-turn cases: unload hang (one case per file for the strict Intel deadline). Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^unload \{"unloadHang":true\}/u.test(name));
