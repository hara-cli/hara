// Codex second-turn cases: unload notLoaded. Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^unload \{"unloadStatus":"notLoaded"/u.test(name));
