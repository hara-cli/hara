// Host-only process ownership. Never accepts PIDs, commands or process claims from a model/RPC event.
import { ChildProcess, execFile } from "node:child_process";

export const RUNTIME_GUARD_SCRIPT = 'kill -STOP $$; exec "$@"';
interface ProcessStamp { pid: number; parent: number; group: number; state: string; born: string }
interface Root { child: ChildProcess; retired: boolean; armed: boolean; stamp?: ProcessStamp; exited: boolean; closed: boolean; close: Promise<void> }
export interface RuntimeDrainReport { rootRetained: boolean; observedDescendants: number; signalled: number; remaining: 0 }
const same = (a: ProcessStamp | undefined, b: ProcessStamp | undefined): boolean => !!a && !!b && a.pid === b.pid && a.born === b.born;
const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
function parseProcesses(text: string): Map<number, ProcessStamp> {
  const rows = new Map<number, ProcessStamp>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const value = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/u.exec(line);
    if (!value) throw new Error("Native process inventory could not be verified");
    const row = { pid: Number(value[1]), parent: Number(value[2]), group: Number(value[3]), state: value[4]!, born: value[5]! };
    if (row.pid > 1 && Number.isSafeInteger(row.pid)) rows.set(row.pid, row);
  }
  return rows;
}
function processes(): Promise<Map<number, ProcessStamp>> {
  return new Promise((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
      encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    }, (error, stdout) => {
      if (error) { reject(new Error("Native process inventory could not be verified")); return; }
      try { resolve(parseProcesses(stdout)); } catch { reject(new Error("Native process inventory could not be verified")); }
    });
  });
}

function signal(row: ProcessStamp, live: Map<number, ProcessStamp>, name: NodeJS.Signals): boolean {
  if (!same(row, live.get(row.pid))) return false;
  try { process.kill(row.pid, name); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("Native process tree could not be drained");
  }
}

/** A detached Host-spawned root owns its process group. Also retain observed descendant identities
 * across reparenting and separate tool process groups. A failed inventory never means an empty tree. */
export class RuntimeProcessBoundary {
  private readonly roots: Root[] = [];
  private readonly known = new Map<number, ProcessStamp>();
  private readonly baseline = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private ready: Promise<void> = Promise.resolve();
  private needsBaseline = false;
  private residentRootPrepared = false;
  private active = false;
  private draining?: Promise<RuntimeDrainReport>;
  private wrapped = false;
  private inventoryFailed = false;
  private closed = false;
  private readonly key = (row: ProcessStamp) => `${row.pid}:${row.born}`;
  markWrapped(): void { if (this.closed) throw new Error("Native boundary is closed"); if (!this.active && !this.draining) this.beginAttempt(); this.wrapped = true; }
  beginAttempt(): void {
    if (this.closed || this.draining) throw new Error("Native process tree is still draining");
    this.baseline.clear();
    this.needsBaseline = this.roots.some(root => !root.closed);
    this.active = true;
  }
  async prepareAttempt(): Promise<void> {
    await this.ready.catch(() => {});
    if (this.needsBaseline) {
      const live = this.observe(await processes());
      for (const row of this.descendants(live)) this.baseline.add(this.key(row));
      this.needsBaseline = false;
    }
    this.watch();
  }
  /** Host-only: after runtime initialization, before its first turn. A launcher may own the
   * actual app-server child. Preserve those already-owned processes, never caller-supplied PIDs. */
  async prepareResidentRoot(): Promise<void> {
    if (this.closed || this.draining || !this.active || this.residentRootPrepared) throw new Error("Resident root initialization is unavailable or already prepared");
    await this.ready;
    const live = this.observe(await processes());
    const roots = this.roots.filter(root => !root.retired && !root.closed);
    if (this.closed || this.draining || !this.active || roots.length !== 1 || !roots[0]!.armed
      || !same(roots[0]!.stamp, live.get(roots[0]!.child.pid!))) throw new Error("Initialized resident process ownership could not be verified");
    for (const row of this.descendants(live)) this.baseline.add(this.key(row));
    this.needsBaseline = false; this.residentRootPrepared = true; this.watch();
  }
  /** Called synchronously by the trusted spawn primitive, before its result can reach any adapter. */
  own(child: ChildProcess, processGroup: boolean): Promise<void> {
    if (this.closed || this.draining || !(child instanceof ChildProcess) || !processGroup || this.roots.some(root => !root.closed)) throw new Error("Native process requires one owned detached root");
    const root: Root = { child, retired: false, armed: false, exited: false, closed: false, close: Promise.resolve() };
    root.close = new Promise(resolve => child.once("close", () => { root.closed = true; resolve(); }));
    this.residentRootPrepared = false;
    this.roots.push(root);
    child.once("exit", () => {
      root.exited = true;
      // Close inherited background pipes as soon as the root exits, rather than waiting for a timeout.
      void this.drain(false).catch(() => { if (root.armed) this.inventoryFailed = true; });
    });
    const register = async () => {
      if (!child.pid) throw new Error("Native process PID unavailable");
      try {
        if (!child.spawnargs.includes("hara-native-guard") || !child.spawnargs.includes(RUNTIME_GUARD_SCRIPT)) throw new Error("Native startup guard missing");
        const deadline = Date.now() + 5000;
        let live: Map<number, ProcessStamp>, row: ProcessStamp | undefined;
        // The wrapper stops BEFORE executing the runtime. No native code runs until Host ownership is armed.
        do { live = await processes(); row = live.get(child.pid); } while (row && !row.state.includes("T") && Date.now() < deadline);
        if (!row || !row.state.includes("T") || row.group !== child.pid) throw new Error("Native root did not reach its owned startup barrier");
        root.stamp = row; this.known.set(row.pid, row); this.observe(live!); this.needsBaseline = false;
        root.armed = true; this.watch(); signal(row, live!, "SIGCONT");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* The original owned handle only. */ }
        if (root.armed) this.inventoryFailed = true; throw new Error("Native process ownership could not be established");
      }
    };
    const ready = child.pid ? register() : new Promise<void>((resolve, reject) => {
      child.once("spawn", () => { void register().then(resolve, reject); }); child.once("error", () => reject(new Error("Native process could not spawn")));
    });
    this.ready = ready; void ready.catch(() => {}); return ready;
  }
  private watch(): void {
    if (this.timer || !this.active || !this.roots.some(root => !root.closed)) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.draining || !this.active) return;
      void processes().then(live => {
        if (!this.draining && this.active) this.observe(live);
      }).catch(() => { if (this.active) this.inventoryFailed = true; }).finally(() => this.watch());
    }, 250);
    this.timer.unref();
  }
  private observe(live: Map<number, ProcessStamp>): Map<number, ProcessStamp> {
    const owned = new Set<number>();
    for (const [pid, row] of this.known) if (same(row, live.get(pid))) owned.add(pid);
    const groups = new Set(this.roots.flatMap(root => !root.retired && root.stamp ? [root.stamp.pid] : []));
    for (const row of this.known.values()) if (row.group === row.pid && same(row, live.get(row.pid))) groups.add(row.group);
    for (const row of live.values()) if (groups.has(row.group)) {
      const leader = live.get(row.group), knownLeader = this.known.get(row.group);
      if (leader && knownLeader && !same(leader, knownLeader)) continue;
      owned.add(row.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of live.values()) if (!owned.has(row.pid) && owned.has(row.parent)) { owned.add(row.pid); changed = true; }
    }
    for (const pid of owned) this.known.set(pid, live.get(pid)!);
    return live;
  }

  private descendants(live: Map<number, ProcessStamp>): ProcessStamp[] {
    const roots = new Set(this.roots.flatMap(root => root.stamp ? [root.stamp.pid] : []));
    return [...this.known.values()].filter(row => !roots.has(row.pid) && !live.get(row.pid)?.state.startsWith("Z") && same(row, live.get(row.pid)));
  }
  async drain(keepRoot = false): Promise<RuntimeDrainReport> {
    await this.ready.catch(() => {});
    if (keepRoot && this.needsBaseline) throw new Error("Resident attempt process baseline was not prepared");
    if (this.draining) {
      await this.draining;
      if (keepRoot || !this.roots.some(root => !root.closed)) return { rootRetained: keepRoot, observedDescendants: 0, signalled: 0, remaining: 0 };
    }
    const operation = this.performDrain(keepRoot); this.draining = operation;
    try { return await operation; } finally { if (this.draining === operation) this.draining = undefined; }
  }
  private async performDrain(keepRoot: boolean): Promise<RuntimeDrainReport> {
    clearTimeout(this.timer); this.timer = undefined; this.active = false;
    if (!this.roots.length) {
      if (this.wrapped) throw new Error("Native spawn did not attach its process ownership hook");
      return { rootRetained: false, observedDescendants: 0, signalled: 0, remaining: 0 };
    }
    const observationGap = this.inventoryFailed;
    const deadline = Date.now() + 8000; let signalled = 0, observedDescendants = 0, stable = 0;
    let success = false, certified = false;
    const retained: ProcessStamp[] = [];
    try {
      let live = this.observe(await processes());
      // Freeze the launcher and initialized runtime children while draining this attempt's tools.
      // Signalling the whole group would also kill the resident app-server we are preserving.
      if (keepRoot) {
        retained.push(...this.roots.flatMap(root => !root.retired && root.stamp ? [root.stamp] : []),
          ...this.descendants(live).filter(row => this.baseline.has(this.key(row))));
        for (const row of retained) signal(row, live, "SIGSTOP");
      }
      for (let pass = 0; pass < 32 && Date.now() < deadline; pass++) {
        live = this.observe(await processes());
        const descendants = this.descendants(live).filter(row => !keepRoot || !this.baseline.has(this.key(row)));
        observedDescendants = Math.max(observedDescendants, descendants.length);
        const targets = [...descendants, ...(!keepRoot ? this.roots.flatMap(root => !root.retired && root.stamp && !live.get(root.stamp.pid)?.state.startsWith("Z") && same(root.stamp, live.get(root.stamp.pid)) ? [root.stamp] : []) : [])];
        // Zombies have exited and cannot execute; their parent/launchd still owns reaping them.
        if (!targets.length) { if (++stable >= 2) { success = true; break; } }
        else {
          stable = 0;
          for (const row of targets) {
            signalled += Number(signal(row, live, pass === 0 ? "SIGTERM" : "SIGKILL"));
            if (pass === 0) signal(row, live, "SIGCONT");
          }
        }
        await delay(pass === 0 ? 100 : 50);
      }
      if (!success) throw new Error("Native process tree remains live or its cleanup is unverified");
      if (observationGap) throw new Error("Native descendant observation was incomplete; cleanup is not certified");
      this.inventoryFailed = false;
      if (!keepRoot) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([Promise.all(this.roots.map(root => root.close)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native process close remains unverified")), 2000); })]); }
        finally { clearTimeout(timer); }
      }
      if (!keepRoot) { for (const root of this.roots) root.retired = true; this.known.clear(); }
      else {
        const live = await processes();
        for (const [pid, row] of this.known) if (!same(row, live.get(pid))) this.known.delete(pid);
      }
      certified = true;
      return { rootRetained: keepRoot, observedDescendants, signalled, remaining: 0 };
    } finally {
      if (keepRoot && certified) {
        const live = await processes(); for (const row of retained) signal(row, live, "SIGCONT");
      }
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.drain(false); this.closed = true; clearTimeout(this.timer); this.timer = undefined;
  }
}
