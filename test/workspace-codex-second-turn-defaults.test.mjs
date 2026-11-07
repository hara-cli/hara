// Codex second-turn cases: sticky default resolution. Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^(medium switches to the declared none default|unknown default after concrete effort)/u.test(name));
