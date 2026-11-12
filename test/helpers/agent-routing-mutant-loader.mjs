// Explicit verification only. Never imported by production or the ordinary test glob.
import { register } from "node:module";
const mutation = process.env.HARA_C6_TEST_MUTATION;
const substitutions = {
  publicSecrets: ["agent-routing.js", "publicProfile: redactSensitiveValue(candidate.publicProfile).value", "publicProfile: candidate.publicProfile"],
  audienceFirst: ["agent-routing.js", 'const provenance = this.options.authority.assertRoutingTransport(transport), audience = this.audience(input.channelId);', 'const provenance = this.options.authority.assertRoutingTransport(transport); this.options.authority.routingDirectory(transport, this.options.automaticAgentIds(), this.options.automaticAgentIds()); const audience = this.audience(input.channelId);'],
  ties: ["agent-routing-owner.js", 'if (winners.length > 1)', 'if (false)'],
  rejects: ["agent-routing-owner.js", 'return profile.rejects.some(term => matches(body, term));', 'return false;'],
  firstFallback: ["agent-routing-owner.js", 'return none("no_match", candidates.map(row => row.agentId).sort());', 'return candidates.length ? selected(candidates[0].agentId, "duty_match") : none("no_match");'],
  claimAtomic: ["agent-boundary-authority.js", 'if (newRun && routing) {', 'if (false && newRun && routing) {'],
  version: ["agent-boundary-authority.js", 'if (captured.assertSelection() !== undefined || captured.assertAudience() !== undefined)', 'if (false)'],
  consumeOnce: ["agent-boundary-authority.js", 'if (captured.used)', 'if (false)'],
  submitOnce: ["agent-boundary-authority.js", 'if (!captured.used || captured.submitted)', 'if (false)'],
  unknownFrozen: ["agent-routing-state.js", 'if (old.classification.phase !== "submission_started" && canonical(old.classification) !== canonical(next.classification))', 'if (false)'],
  strictKeys: ["agent-routing-classification.js", 'routingFields(raw, ["candidateId"]);', '/* strict output keys removed */'],
  whitelist: ["agent-routing-classification.js", 'if (!(raw.candidateId === null || typeof raw.candidateId === "string" && facts.payload.candidates.some(candidate => candidate.agentId === raw.candidateId)))', 'if (false)'],
  tools: ["agent-routing-classification.js", 'if (result.toolUses.length)', 'if (false)'],
  oldOwner: ["agent-routing-state.js", 'if (old.state === "claimed" && canonical(ownership(old)) !== canonical(ownership(next)) || old.state !== "claimed" && next.state === "claimed" && !next.claim)', 'if (old.state !== "claimed" && next.state === "claimed" && !next.claim)'],
  privatePersona: ["agent-boundary-authority.js", '// Public nomination reads metadata and confirmed duties only, never resource roots, homes or private context.', '// Public nomination reads metadata and confirmed duties only, never resource roots, homes or private context.\n            this.options.resources.agents.channelPrefilterProfiles();'],
};
if (!Object.hasOwn(substitutions, mutation ?? "")) throw new Error("Explicit C6 verification mutation required");
const [target, before, after] = substitutions[mutation];
register("data:text/javascript," + encodeURIComponent(`
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.endsWith("/dist/workspace/" + ${JSON.stringify(target)})) return result;
  const source = Buffer.from(result.source).toString("utf8"), before = ${JSON.stringify(before)}, after = ${JSON.stringify(after)};
  if (source.split(before).length !== 2) throw new Error("C6 mutation target missing or ambiguous");
  process.stderr.write("[C6_MUTATION_APPLIED:${mutation}]\\n");
  return { ...result, source: source.replace(before, after) };
}`), import.meta.url);
