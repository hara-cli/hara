import { readFileSync } from "node:fs";

declare const __HARA_BUNDLED_THIRD_PARTY_NOTICES__: string | undefined;

/** The compiled executable carries this exact text; Node reads only its own installed package. */
export function thirdPartyNotices(): string {
  if (typeof __HARA_BUNDLED_THIRD_PARTY_NOTICES__ !== "undefined") return __HARA_BUNDLED_THIRD_PARTY_NOTICES__;
  return readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
}
