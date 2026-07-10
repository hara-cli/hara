// Session-scoped "host unreachable" memory. When a network command (git / curl / …) fails because the
// HOST could not be reached — a TCP connect timeout or a DNS failure, NOT an auth/404/protocol error on a
// host that's actually up — we remember that host for the rest of this hara process. A later command aimed
// at the same host is then short-circuited INSTANTLY (see builtin.ts bash tool) instead of eating another
// ~75s OS-level connect timeout. This is the deterministic half of hara's network fault-tolerance: the
// model can't "forget" it the way a system-prompt rule can be ignored under pressure.
//
// One hara process == one session (same process-local pattern as session-model.ts's force-model flag), so
// a module-local Set is exactly session scope — no need to thread state through ~17 runAgent call sites.
// This module is PURE + fully unit-tested; the only impure step (resolving a bare `git pull`'s remote host
// with a local `git remote get-url`) lives in the bash tool, keeping the classification logic deterministic.

const unreachable = new Set<string>();

/** Remember a host as unreachable for the rest of this session. */
export function markHostUnreachable(host: string): void {
  if (host) unreachable.add(host.toLowerCase());
}

/** Has this host already failed to connect this session? */
export function isHostUnreachable(host: string): boolean {
  return !!host && unreachable.has(host.toLowerCase());
}

/** Snapshot of the hosts marked unreachable (for the pre-check fast path + tests). */
export function unreachableHostsSnapshot(): string[] {
  return [...unreachable];
}

/** Clear the memory — called on /reset (network may have been fixed) and between tests. */
export function resetReachability(): void {
  unreachable.clear();
}

/** Explicit hosts a command references: URLs (http/https/git/ssh/ftp) + scp/ssh `user@host:path` specs.
 *  Pure. A bare `git pull origin main` yields [] — its host lives in the repo's remote config, resolved
 *  separately by the bash tool. */
export function hostsInCommand(command: string): string[] {
  const hosts = new Set<string>();
  // scheme://[user@]host[:port]/…   (github.com from https://github.com/owner/repo.git)
  for (const m of command.matchAll(/\b(?:https?|ssh|git|ftp):\/\/(?:[^/\s'"@]+@)?([^/\s:'"]+)/gi)) {
    hosts.add(m[1].toLowerCase());
  }
  // scp/ssh syntax:  user@host:path   (github.com from git@github.com:owner/repo.git)
  for (const m of command.matchAll(/(?:^|\s)[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):/g)) {
    hosts.add(m[1].toLowerCase());
  }
  return [...hosts];
}

/** Does this command reach out over the network for git? Catches the bare forms (`git pull`, `git fetch`)
 *  that carry no URL, so the tool knows to resolve their remote host before deciding to short-circuit. */
export function isNetworkGitOp(command: string): boolean {
  return /\bgit\b[^\n]*\b(?:clone|fetch|pull|push|ls-remote|remote\s+(?:update|show)|submodule\s+update)\b/.test(command);
}

/** Pull the connect/DNS-failure HOST out of a command's error text — the deterministic signal for WHICH
 *  host is down. Returns "" if the text names no host. Pure. */
export function hostFromConnectError(errText: string): string {
  const m =
    errText.match(/Failed to connect to ([^\s:]+)\s+port/i) ||     // git/curl: Failed to connect to github.com port 443
    errText.match(/Could not resolve host:?\s*([^\s'"]+)/i) ||     // git/curl DNS: Could not resolve host: github.com
    errText.match(/Resolving [^\s]*?\(?([A-Za-z0-9.-]+?)\)? timed out/i) || // curl (28) Resolving api.x.com timed out
    errText.match(/unable to access '[a-z]+:\/\/([^/'"]+)/i);      // git: unable to access 'https://github.com/…'
  return m ? m[1].toLowerCase().replace(/[.,]+$/, "") : "";
}

/** Is this error a genuine host-unreachability — a connect TIMEOUT / DNS failure / no-route, the kind that
 *  burns ~75s — as opposed to (a) auth/404/protocol errors on a host that IS up, or (b) "connection
 *  refused", which is a host that's up and fast-rejecting (a dev server not started yet), NOT the slow
 *  waste we're guarding against. We cache ONLY genuine unreachability. Pure. */
export function isConnectFailure(errText: string): boolean {
  if (/Connection refused|ECONNREFUSED/i.test(errText)) return false; // host is UP (fast reject) — never cache
  return /(?:Failed to connect to [^\n]*port|Could not resolve host|Couldn't connect to server|Connection timed out|Resolving [^\n]*timed out|Operation timed out|[Nn]etwork is unreachable|[Nn]o route to host|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)/.test(errText);
}
