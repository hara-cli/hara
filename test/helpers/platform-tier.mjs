// Platform write protection for tests (decision B): the full tier exists only where the Host has macOS
// Seatbelt. Elsewhere the product default is the controlled tier, and full-tier requests are refused
// (asserted by test/runtime-platform-tiers.test.mjs and test/workspace-platform-tiers.test.mjs).
export const SEATBELT = process.platform === "darwin";
export const DEFAULT_TIER = SEATBELT ? "full-protected" : "controlled";
/** A test whose subject is full-tier behavior runs only with Seatbelt; the reason is reported, never hidden. */
export const FULL_TIER_SKIP = SEATBELT ? false
  : "full tier requires macOS Seatbelt (decision B); off macOS the refusal is asserted by the platform-tier tests";
/** Gemini needs Hara's Seatbelt-protected project settings overlay; off macOS it is refused (counterpart test below). */
export const GEMINI_SKIP = SEATBELT ? false : "Gemini protected project settings require macOS Seatbelt; off macOS the refusal is asserted instead";
/** Assertions about OS-enforced write denial hold only inside Seatbelt; elsewhere the write is merely never credited. */
export const OFF_MACOS_ONLY = SEATBELT ? "this assertion covers a Host without Seatbelt" : false;
