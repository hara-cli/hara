// Scripted providers emulate model choices using the exact advertised native/Hara tool names.
// No extra tool is admitted: unknown choices stay unknown for the production gateway to reject.
export function scriptedWorkspaceProvider(provider) {
  return { ...provider, async turn(args) {
    const byNative = new Map(args.tools.filter(tool => tool.name.startsWith("mcp__hara__")).map(tool => [tool.name, tool.name.slice("mcp__hara__".length)]));
    const byCanonical = new Map([...byNative].map(([native, name]) => [name, native]));
    const canonical = name => byNative.get(name) ?? name;
    const history = args.history.map(message => message.role === "assistant" ? { ...message, toolUses: message.toolUses.map(call => ({ ...call, name: canonical(call.name) })) }
      : message.role === "tool" ? { ...message, results: message.results.map(result => ({ ...result, name: canonical(result.name) })) } : message);
    const reply = await provider.turn({ ...args, tools: args.tools.map(tool => ({ ...tool, name: canonical(tool.name) })), history });
    return { ...reply, toolUses: reply.toolUses.map(call => ({ ...call, name: byCanonical.get(call.name) ?? call.name })) };
  } };
}
