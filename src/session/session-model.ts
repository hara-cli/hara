// Session-level model selection — small module so the four role-provider call sites in index.ts
// (runOrg / executeAtom / review-chain / runSubagent) can consult "is the user forcing all roles
// to the session model?" without importing index.ts. The state is plain process-local, reset
// between processes (we never persist `--force` across runs — only the session-pinned model).
//
// Priority chain (highest first):
//   /model X --force  (this session, all roles)  ← sessionForceModel === true
//   /model X          (this session, defaults respect role.model)
//   --model X         (CLI flag, written into meta.model)
//   meta.model        (resume; restored into cfg.model at startup)
//   role.model        (org role frontmatter — respected by default)
//   profile.model / defaultModel / provider default

let _forced = false;

/** Switch on/off "force all roles to use the session model" for this process. */
export function setSessionForceModel(on: boolean): void {
  _forced = !!on;
}

/** Is the session-force flag on? */
export function isSessionForceModel(): boolean {
  return _forced;
}

/** Resolve the model a role should run under given current force state.
 *  - default (no --force): role's frontmatter model wins if set, else fall back to session model.
 *  - with --force: session model wins, role.model is ignored.
 *  Returns undefined when there's no override needed (role.model is unset OR equals cfg.model OR
 *  force is on AND we should rebuild with cfg.model only when role.model would otherwise have
 *  switched providers — i.e. callers should still gate "rebuild provider only if different"). */
export function effectiveRoleModel(roleModel: string | undefined, sessionModel: string): string | undefined {
  if (_forced) return undefined; // force → use the session/base provider, ignore role.model entirely
  if (!roleModel) return undefined;
  if (roleModel === sessionModel) return undefined;
  return roleModel;
}
