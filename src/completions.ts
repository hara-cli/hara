// Shell completion scripts (bash / zsh / fish), generated from the command tree so they never drift.
// `hara completions <shell>` prints one; the user evals it in their shell rc. Completes the top-level
// subcommands, the subcommands of each group (cron/memory/plugin/roles/skills/config), and falls back to
// file completion otherwise. Hand-rolled (no dependency) — same minimal-deps philosophy as the rest.

export type CmdTree = { top: string[]; subs: Record<string, string[]> };

const bash = ({ top, subs }: CmdTree): string => {
  const cases = Object.entries(subs)
    .map(([cmd, sub]) => `    ${cmd}) COMPREPLY=( $(compgen -W "${sub.join(" ")}" -- "$cur") ); return;;`)
    .join("\n");
  return `# hara bash completion — add to ~/.bashrc:  eval "$(hara completions bash)"
_hara() {
  local cur prev; cur="\${COMP_WORDS[COMP_CWORD]}"; prev="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then COMPREPLY=( $(compgen -W "${top.join(" ")}" -- "$cur") ); return; fi
  case "$prev" in
${cases}
    *) COMPREPLY=( $(compgen -f -- "$cur") );;
  esac
}
complete -F _hara hara
`;
};

const zsh = ({ top, subs }: CmdTree): string => {
  const cases = Object.entries(subs)
    .map(([cmd, sub]) => `    ${cmd}) compadd -- ${sub.join(" ")} ;;`)
    .join("\n");
  return `# hara zsh completion — add to ~/.zshrc:  eval "$(hara completions zsh)"
_hara() {
  if (( CURRENT == 2 )); then compadd -- ${top.join(" ")}; return; fi
  case "\${words[2]}" in
${cases}
    *) _files ;;
  esac
}
compdef _hara hara
`;
};

const fish = ({ top, subs }: CmdTree): string => {
  const lines = [
    "# hara fish completion — save to ~/.config/fish/completions/hara.fish:  hara completions fish > ~/.config/fish/completions/hara.fish",
    "complete -c hara -f",
    `complete -c hara -n __fish_use_subcommand -a "${top.join(" ")}"`,
    ...Object.entries(subs).map(([cmd, sub]) => `complete -c hara -n "__fish_seen_subcommand_from ${cmd}" -a "${sub.join(" ")}"`),
  ];
  return lines.join("\n") + "\n";
};

/** Render the completion script for a shell, or null if the shell isn't supported. */
export function completionScript(shell: string, tree: CmdTree): string | null {
  const gen: Record<string, (t: CmdTree) => string> = { bash, zsh, fish };
  return gen[shell] ? gen[shell](tree) : null;
}
