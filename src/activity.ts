// Live concurrency signal — how many tool/subagent operations are in flight right now.
// The status bar subscribes to render the "⛁ N" indicator; the agent loop inc/dec around
// parallel tool execution (and, later, spawned subagents).
let running = 0;
let peak = 0;
let listener: (() => void) | null = null;

export const activity = {
  get running(): number {
    return running;
  },
  get peak(): number {
    return peak;
  },
  inc(): void {
    running++;
    if (running > peak) peak = running;
    listener?.();
  },
  dec(): void {
    running = Math.max(0, running - 1);
    listener?.();
  },
  resetPeak(): void {
    peak = running;
  },
  onChange(fn: (() => void) | null): void {
    listener = fn;
  },
};
