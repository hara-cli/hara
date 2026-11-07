/** Engine-only, zero-model routing evidence. Private persona strings never enter the reply record. */
export interface ChannelPrefilterProfile {
  agentId: string;
  title?: string;
  description?: string;
  instructions?: string;
  aliases?: string[];
}
const stop = new Set(["a", "an", "the", "and", "or", "for", "with", "from", "this", "that", "these", "those", "have", "has", "your", "you", "are", "our", "will", "can", "could", "should", "please", "help", "user", "users", "assistant", "colleague", "specialist", "expert", "role", "task", "tasks", "work", "working", "负责", "帮助", "协助", "用户", "同事", "工作", "任务", "需要", "请你", "可以", "完成", "进行", "作为"]);
function terms(value: string): Set<string> | null {
  const found = new Set<string>();
  for (const word of value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu) ?? []) {
    if (/^[a-z]/u.test(word)) {
      if (!stop.has(word)) {
        found.add(word);
        const stem = word.replace(/(?:ments|ment|ing|ers|er|s)$/u, "");
        if (stem.length >= 4 && !stop.has(stem)) found.add(stem);
      }
    } else {
      for (let index = 0; index < word.length - 1; index++) {
        const pair = word.slice(index, index + 2);
        if (!stop.has(pair)) found.add(pair);
      }
    }
    if (found.size > 4096) return null; // uninspectable evidence is uncertainty, never proof of irrelevance
  }
  return found;
}
function namesMember(body: string, aliases: readonly string[]): boolean {
  const lower = body.toLowerCase();
  return aliases.some(raw => {
    const alias = raw.trim().toLowerCase();
    if (alias.length < 2 || alias.length > 200) return false;
    let at = lower.indexOf(alias);
    while (at >= 0) {
      const before = lower[at - 1] ?? "", after = lower[at + alias.length] ?? "";
      if ((!/[a-z0-9_]$/u.test(alias) || !/[a-z0-9_]/u.test(after))
        && (!/^[a-z0-9_]/u.test(alias) || !/[a-z0-9_]/u.test(before))) return true;
      at = lower.indexOf(alias, at + 1);
    }
    return false;
  });
}
/** False means absent/ambiguous evidence. Only a useful message and useful unmatched role may PASS. */
export function channelRoleUnrelated(body: string, profile: ChannelPrefilterProfile | undefined): boolean {
  if (!profile) return false;
  const input = terms(body), role = terms([profile.title, profile.description, profile.instructions].filter(value => typeof value === "string").join("\n"));
  if (!input?.size || !role?.size || namesMember(body, profile.aliases ?? [])) return false;
  for (const token of input) if (role.has(token)) return false;
  return true;
}
