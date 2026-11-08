// Codex second-turn cases: required MCP initialization failure (one case per file for the strict Intel deadline). Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^required MCP initialization failure/u.test(name));
