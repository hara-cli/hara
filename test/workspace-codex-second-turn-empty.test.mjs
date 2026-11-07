// Codex second-turn cases: empty unmaterialized thread recovery. Shared cases live in helpers/codex-second-turn-cases.mjs.
import { registerSecondTurnCases } from "./helpers/codex-second-turn-cases.mjs";
registerSecondTurnCases(name => /^(rejectTurnStart|terminateBeforeTurnStart): empty unmaterialized/u.test(name));
