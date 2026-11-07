import { plain, text } from "./local-state.js";

/** A missing/invalid field never erases the other fields of a human-reviewed proposal. */
export function colleagueProposal(input: unknown, objective: string, retainedUsernames: readonly string[]) {
  const row = plain(input) ? input : {};
  const displayName = text(row.displayName, 80) ? row.displayName : "";
  const title = text(row.title, 180) ? row.title : "";
  const reserved = new Set(["main", "hara", ...retainedUsernames]);
  let username = typeof row.username === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.username) ? row.username : "";
  if (!username || reserved.has(username)) {
    const seed = `${displayName} ${title}`.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || "colleague";
    username = seed;
    for (let suffix = 2; reserved.has(username); suffix++) username = `${seed}-${suffix}`;
  }
  return { username, displayName, title,
    instructions: typeof row.instructions === "string" && row.instructions.length <= 8000 ? row.instructions : objective.slice(0, 8000),
    project: row.project === "" || text(row.project, 240) ? row.project : "" };
}
