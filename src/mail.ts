// Engine-owned mailbox connections. The UI supplies intents; provider credentials stay in the
// provider's keychain/shared Feishu capability. Receiving never executes instructions from mail.
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { existsSync, realpathSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, removePrivateStateFile, withPrivateStateLockSync, writePrivateStateFileSync } from "./security/private-state.js";
import { redactSensitiveText } from "./security/secrets.js";

export interface MailScope { spaceId: string; profileId: string; identityKey: string; }
export interface MailConnection extends MailScope {
  id: string; provider: "tencent" | "feishu" | "imap"; mailbox: string; projectId: string; mainBotId: string;
  servers?: MailServers;
  transport?: "cli" | "api" | "imap-smtp"; ownership?: "personal" | "company"; receiverMode?: "local" | "server"; allowReplies?: boolean;
  revision: number; deskRevision: number; paused: boolean; verifiedAt: number; after: string;
  checks?: { list: string; body: string; attachments: string; sending: string };
  pageCursor?: string; pageCursors?: string[]; windowBefore?: string; lastSyncAt?: number; pending: string[];
}
export interface MailServers { imapHost: string; imapPort: number; imapSecurity: "tls" | "starttls"; smtpHost: string; smtpPort: number; smtpSecurity: "tls" | "starttls"; }
type Data = Record<string, any>;
type BusCall = (scope: MailScope, method: "GET" | "POST", path: string, body?: Data, runtime?: boolean) => Promise<any>;
type Run = (provider: MailConnection["provider"], args: string[]) => Promise<Data>;
const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
const privateFile = (parts: string[], leaf: string) => bindPrivateHaraStateFile(homedir(), ["mail", ...parts], leaf);
const read = (parts: string[], leaf: string): Data | null => {
  const f = readPrivateStateFileSnapshotSync(privateFile(parts, leaf).path, 2 * 1024 * 1024);
  return f ? JSON.parse(f.text) : null;
};
const save = (parts: string[], leaf: string, value: unknown): void => {
  const f = privateFile(parts, leaf), old = readPrivateStateFileSnapshotSync(f.path, 2 * 1024 * 1024);
  writePrivateStateFileSync(f, JSON.stringify(value) + "\n", old ? { expectedText: old.text } : { expectedMissing: true });
};
const exactMailbox = (v: unknown): string => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) || s.length > 254) throw new Error("exact mailbox address required");
  return s;
};
function standardServers(input: unknown, provider: string): MailServers {
  const values = input && typeof input === "object" ? input as Data : {};
  const result: Data = {};
  for (const protocol of ["imap", "smtp"]) {
    const host = String(values[protocol + "Host"] || (provider === "feishu" ? protocol + ".feishu.cn" : "")).trim().toLowerCase();
    const port = Number(values[protocol + "Port"] || (protocol === "imap" ? 993 : 465));
    const security = values[protocol + "Security"] || "tls";
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes(".") || host.includes("..") || host.length > 253) throw new Error("explicit IMAP and SMTP server hostnames required");
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !["tls", "starttls"].includes(security)) throw new Error("mail servers require valid ports and verified TLS or STARTTLS");
    result[protocol + "Host"] = host; result[protocol + "Port"] = port; result[protocol + "Security"] = security;
  }
  return result as MailServers;
}
function agentlyCommand(): { command: string; prefix: string[] } {
  const directories = (process.env.PATH || "").split(delimiter).filter(isAbsolute);
  // A GUI app does not inherit an interactive NVM PATH. Find the existing official installation;
  // never run a shell startup file, install packages, or change the user's Node configuration.
  const nvm = join(homedir(), ".nvm", "versions", "node");
  try { directories.push(...readdirSync(nvm).filter(v => /^v\d+\.\d+\.\d+$/.test(v)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 50).map(v => join(nvm, v, "bin"))); } catch { /* optional installation location */ }
  if (process.platform === "win32" && process.env.APPDATA) directories.push(join(process.env.APPDATA, "npm"));
  else directories.push("/opt/homebrew/bin", "/usr/local/bin");
  const candidates = directories.map(p => join(p, process.platform === "win32" ? "agently-cli.cmd" : "agently-cli"));
  const found = candidates.find(existsSync);
  if (!found) throw new Error("Agent Mail CLI is not installed; install the official agently-cli before authorization");
  const target = process.platform === "win32" && found.endsWith(".cmd")
    ? join(dirname(found), "node_modules", "@tencent-qqmail", "agently-cli", "scripts", "run.js") : realpathSync(found);
  if (target.endsWith(".js")) {
    try {
      const req = createRequire(target), pkg = `@tencent-qqmail/agently-cli-${process.platform}-${process.arch}`;
      const native = join(dirname(req.resolve(`${pkg}/package.json`)), "bin", process.platform === "win32" ? "agently-cli.exe" : "agently-cli");
      if (existsSync(native)) return { command: native, prefix: [] };
    } catch { /* use a known modern Node runtime when no native binary is installed */ }
    if (!process.versions.bun) return { command: process.execPath, prefix: [target] };
    throw new Error("Agent Mail native executable is unavailable; repair the official CLI installation");
  }
  return { command: found, prefix: [] };
}
export async function runMailProvider(provider: MailConnection["provider"], args: string[]): Promise<Data> {
  const exec = promisify(execFile);
  let command: string, prefix: string[];
  if (provider === "tencent") ({ command, prefix } = agentlyCommand());
  else {
    const helper = join(homedir(), ".codex", "skills", "feishu-communicate", "scripts", "feishu_chat.py");
    if (!existsSync(helper)) throw new Error("shared feishu-communicate capability is not installed");
    command = "python3"; prefix = [helper];
  }
  try {
    const r = await exec(command, [...prefix, ...args], { timeout: 25_000, maxBuffer: 512 * 1024, windowsHide: true });
    const value = JSON.parse(r.stdout);
    if (value.ok === false) throw new Error("provider rejected the request");
    return value;
  } catch (error: any) {
    throw new Error(`mail provider request failed (${typeof error?.code === "number" ? error.code : "unavailable"}); check authorization and connectivity`);
  }
}

export class MailEngine {
  private receiverId = randomUUID();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private started = false;
  private keepAlive = false;
  private watchScope?: MailScope;
  private running = new Set<string>();
  private states = new Map<string, Data>();
  private leases = new Map<string, number>();
  private retryAt = new Map<string, number>();
  private auth: { scope: MailScope; mailbox: string; child?: ChildProcess; phase: string; url?: string; error?: string; timer?: ReturnType<typeof setTimeout> } | undefined;
  constructor(private bus: BusCall, private resolveScope: (profileId: string, spaceId: string) => MailScope, private run: Run = runMailProvider) {}
  private connections(): MailConnection[] { return Object.values(read([], "connections.json")?.connections || {}); }
  private update(connection: MailConnection, expectedRevision?: number): void {
    withPrivateStateLockSync(homedir(), ["mail"], "connections", () => {
      const file = read([], "connections.json") || { version: 1, connections: {} };
      const prior = file.connections[connection.id];
      if (expectedRevision !== undefined && prior?.revision !== expectedRevision) throw new Error("mail connection changed; refresh before retrying");
      file.connections[connection.id] = connection; save([], "connections.json", file);
    });
  }
  private assertScope(scope: MailScope): void {
    const current = this.resolveScope(scope.profileId, scope.spaceId);
    if (current.identityKey !== scope.identityKey) throw new Error("organization enrollment changed; bind the mailbox again");
  }
  private connection(scope: MailScope, id: string): MailConnection {
    this.assertScope(scope);
    const c = this.connections().find(c => c.id === id && c.spaceId === scope.spaceId && c.profileId === scope.profileId && c.identityKey === scope.identityKey);
    if (!c) throw new Error("mail connection is missing or needs rebinding"); return c;
  }
  private accountFile(mailbox: string): string { return privateFile(["accounts"], hash(mailbox) + ".json").path; }
  private imapArgs(operation: string, mailbox: string, accountFile?: string): string[] { return [operation, "--mailbox", mailbox, "--account-file", accountFile || this.accountFile(mailbox)]; }
  private async verify(provider: MailConnection["provider"], mailbox: string, transport?: string, accountFile?: string): Promise<void> {
    if (provider === "tencent") {
      const me = await this.run(provider, ["+me"]);
      if (!me.data?.aliases?.some((a: Data) => a.is_primary === true && String(a.email).toLowerCase() === mailbox)) throw new Error("authorized primary mailbox does not match; no account was switched");
    } else {
      const result = await this.run(provider, transport === "imap-smtp" ? this.imapArgs("mail-imap-doctor", mailbox, accountFile) : ["mail-doctor", "--backend", "api", "--mailbox", mailbox]);
      if (result.ok !== true || result.source_mailbox?.toLowerCase() !== mailbox) throw new Error("Feishu mailbox access is not verified");
    }
  }
  private async probe(provider: MailConnection["provider"], mailbox: string, transport?: string, accountFile?: string): Promise<NonNullable<MailConnection["checks"]>> {
    const list = provider === "tencent"
      ? (await this.run(provider, ["message", "+list", "--dir", "inbox", "--limit", "1"])).data?.data
      : (await this.run(provider, transport === "imap-smtp" ? [...this.imapArgs("mail-imap-messages", mailbox, accountFile), "--after", "1970-01-01T00:00:00Z", "--before", new Date().toISOString(), "--max", "1"] : ["mail-messages", "--backend", "api", "--mailbox", mailbox, "--max", "1"])).messages;
    if (!Array.isArray(list)) throw new Error("mail list access was not verified");
    if (list.length) {
      const messageId = list[0].message_id || list[0].mail_message_id;
      if (typeof messageId !== "string" || !messageId || messageId.length > 500) throw new Error("mail message ID missing");
      const full = provider === "tencent" ? (await this.run(provider, ["message", "+read", "--id", messageId])).data
        : (await this.run(provider, transport === "imap-smtp" ? [...this.imapArgs("mail-imap-get-message", mailbox, accountFile), "--message-id", messageId] : ["mail-get-message", "--backend", "api", "--mailbox", mailbox, "--message-id", messageId])).message;
      if (!full || String(full.message_id || full.mail_message_id) !== messageId) throw new Error("mail body access was not verified");
    }
    return { list: "verified", body: list.length ? "verified" : "empty-inbox", attachments: "not-requested", sending: transport === "imap-smtp" ? "smtp-auth-verified" : "disabled" };
  }
  private config(c: Data): Data {
    return { id: c.id, provider: c.provider, mailbox: c.mailbox, projectId: c.projectId, mainBotId: c.mainBotId,
      transport: c.transport, servers: c.servers, ownership: c.ownership, receiverMode: c.receiverMode, allowReplies: c.allowReplies === true, removed: c.removed === true };
  }
  async request(scope: MailScope, operation: string, input: Data = {}): Promise<Data> {
    this.assertScope(scope);
    if (operation === "list") {
      const remote = await this.bus(scope, "GET", "/mail-bindings"); this.assertScope(scope);
      return { connections: (remote.bindings || []).filter((r: Data) => !r.removed).map((r: Data) => {
        const c = this.connections().find(c => c.id === r.id && c.spaceId === scope.spaceId && c.profileId === scope.profileId);
        return { ...r, local: !!c, revision: r.revision, pendingCount: c?.pending.length || r.receiver?.pendingCount || 0,
          checks: c?.checks || r.receiver?.checks, phase: r.paused ? "paused" : r.receiver?.phase || (c && this.started ? "waiting" : "stopped"),
          lastSyncAt: c?.lastSyncAt || r.receiver?.lastSyncAt, ...(c ? this.states.get(c.id) || {} : {}),
          needsRebind: !!c && c.identityKey !== scope.identityKey, receiverRunning: !!r.receiver?.active || (!!c && this.started && !this.closed) };
      }), offline: remote.offline === true, syncedAt: remote.syncedAt, auth: this.auth?.scope.identityKey === scope.identityKey ? this.authStatus() : undefined };
    }
    if (operation === "auth.start") {
      const mailbox = exactMailbox(input.mailbox);
      if (this.auth?.child) throw new Error("an authorization is already pending");
      if (this.connections().some(c => c.provider === "tencent" && (c.spaceId !== scope.spaceId || c.mailbox !== mailbox))) throw new Error("this host already has a Tencent mailbox binding; unbind it before changing authorization");
      const cmd = agentlyCommand(), child = spawn(cmd.command, [...cmd.prefix, "auth", "login"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      const state = this.auth = { scope, mailbox, child, phase: "waiting" } as NonNullable<MailEngine["auth"]>;
      let output = "";
      const consume = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-16_384);
        const url = output.match(/https:\/\/agent\.qq\.com\/page\/oauth\?[^\s\x1b]+/)?.[0];
        if (url) state.url = url; // opaque provider URL: never rewrite it
      };
      child.stdout?.on("data", consume); child.stderr?.on("data", consume);
      const finish = (phase: string, error?: string) => { if (state.timer) clearTimeout(state.timer); state.child = undefined; state.phase = phase; state.error = error; if (phase !== "waiting") state.url = undefined; };
      child.once("error", () => finish("failed", "authorization could not start"));
      child.once("exit", code => finish(code === 0 ? "ready" : "failed", code === 0 ? undefined : "authorization failed or was cancelled; retry only when you choose to"));
      state.timer = setTimeout(() => { child.kill("SIGTERM"); finish("failed", "authorization expired"); }, 5 * 60_000);
      state.timer.unref(); return this.authStatus();
    }
    if (operation === "auth.status" || operation === "auth.cancel") {
      if (this.auth?.scope.identityKey !== scope.identityKey) return { phase: "idle" };
      if (operation === "auth.cancel") { this.auth.child?.kill("SIGTERM"); if (this.auth.timer) clearTimeout(this.auth.timer); this.auth = undefined; }
      return this.authStatus();
    }
    if (operation === "bind") {
      input = { ...input, provider: input.provider || "imap" };
      if (!["tencent", "feishu", "imap"].includes(input.provider)) throw new Error("select a supported mail transport");
      const mailbox = exactMailbox(input.mailbox);
      if (this.connections().some(c => c.mailbox === mailbox && c.spaceId !== scope.spaceId)) throw new Error("mailbox is already bound to another Space");
      const transport: NonNullable<MailConnection["transport"]> = input.provider === "tencent" ? "cli" : input.provider === "imap" || input.transport === "imap-smtp" ? "imap-smtp" : "api";
      const servers = transport === "imap-smtp" ? standardServers(input.servers, input.provider) : undefined;
      let staged: ReturnType<typeof privateFile> | undefined;
      try {
      if (transport === "imap-smtp") {
        const password = input.password || read(["accounts"], hash(mailbox) + ".json")?.password;
        if (typeof password !== "string" || !password || password.length > 4096 || /[\r\n\x00]/.test(password)) throw new Error("dedicated mail client password required");
        const leaf = "bind-" + randomUUID() + ".json";
        save(["accounts"], leaf, { mailbox, password, ...servers });
        staged = privateFile(["accounts"], leaf);
      }
      await this.verify(input.provider, mailbox, transport, staged?.path);
      const checks = await this.probe(input.provider, mailbox, transport, staged?.path); this.assertScope(scope);
      const remote = (await this.bus(scope, "GET", "/mail-bindings")).bindings?.find((b: Data) => !b.removed && b.mailbox === mailbox);
      const id = remote?.id || hash(`${scope.spaceId}:${input.provider}:${mailbox}`).slice(0, 40);
      const old = this.connections().find(c => c.id === id);
      if (remote && Number(input.expectedRevision) !== remote.revision) throw new Error("connection revision changed; refresh before binding on this host");
      const config = { id, provider: input.provider, mailbox, transport, servers, projectId: input.projectId, mainBotId: input.mainBotId,
        ownership: (input.ownership === "company" ? "company" : "personal") as "company" | "personal", receiverMode: (input.receiverMode === "server" ? "server" : "local") as "server" | "local", allowReplies: transport === "imap-smtp" && input.allowReplies === true };
      const b = await this.bus(scope, "POST", "/mail-bindings", { ...config, paused: true, expectedRevision: remote?.revision || 0, requestKey: input.requestKey || randomUUID() });
      this.assertScope(scope);
      if (staged) save(["accounts"], hash(mailbox) + ".json", JSON.parse(readPrivateStateFileSnapshotSync(staged.path, 16384)!.text));
      const c: MailConnection = { ...scope, ...config, revision: (old?.revision || 0) + 1, deskRevision: b.binding.revision, paused: true, verifiedAt: Date.now(), checks, after: old?.after || new Date().toISOString(), pending: old?.pending || [] };
      this.assertScope(scope); this.update(c, old?.revision); return { connection: { ...c, pending: undefined, pendingCount: c.pending.length } };
      } finally {
        if (staged) {
          const expected = readPrivateStateFileSnapshotSync(staged.path, 16384);
          if (expected) removePrivateStateFile(staged.path, expected, staged.directory);
        }
      }
    }
    if (operation === "pause" || operation === "start" || operation === "remove") {
      const remote = (await this.bus(scope, "GET", "/mail-bindings")).bindings?.find((r: Data) => r.id === input.id && !r.removed);
      if (!remote || Number(input.expectedRevision) !== remote.revision) throw new Error("connection revision changed");
      const b = await this.bus(scope, "POST", "/mail-bindings", { ...this.config(remote), paused: operation !== "start", removed: operation === "remove", expectedRevision: remote.revision, requestKey: input.requestKey || randomUUID() });
      const local = this.connections().find(c => c.id === input.id && c.identityKey === scope.identityKey);
      if (!local) return { stopped: operation !== "start", removed: operation === "remove", revision: b.binding.revision };
      const c = this.connection(scope, String(input.id));
      c.paused = operation !== "start"; c.deskRevision = b.binding.revision;
      const before = c.revision; c.revision++; this.update(c, before); this.leases.delete(c.id);
      if (operation === "remove") {
        withPrivateStateLockSync(homedir(), ["mail"], "connections", () => { const f = read([], "connections.json")!; delete f.connections[c.id]; save([], "connections.json", f); });
        this.states.delete(c.id);
      }
      this.retryAt.delete(c.id);
      if (operation === "start") this.start(); return { stopped: c.paused, removed: operation === "remove", revision: c.revision };
    }
    const c = this.connection(scope, String(input.id || ""));
    if (operation === "sync") { await this.sync(c); return { ...(this.states.get(c.id) || {}), pendingCount: this.connection(scope, c.id).pending.length }; }
    throw new Error("unsupported mailbox operation");
  }
  private authStatus(): Data { return this.auth ? { phase: this.auth.phase, url: this.auth.url, error: this.auth.error } : { phase: "idle" }; }
  start(keepAlive = false, only?: MailScope): void {
    this.keepAlive ||= keepAlive; this.watchScope = only || this.watchScope;
    if (this.closed || this.timer) return;
    this.started = true;
    const tick = async () => {
      this.timer = undefined;
      try {
        for (const c of this.connections()) {
          if (this.closed) break;
          if (this.watchScope && (c.spaceId !== this.watchScope.spaceId || c.profileId !== this.watchScope.profileId)) continue;
          if ((this.retryAt.get(c.id) || 0) > Date.now()) continue;
          await this.sync(c).catch(() => { this.retryAt.set(c.id, Date.now() + 60_000); });
        }
      } catch { /* a damaged private-state file must not create an unhandled background rejection */ }
      if (!this.closed) { this.timer = setTimeout(() => void tick(), 15_000); if (!this.keepAlive) this.timer.unref(); }
    };
    this.timer = setTimeout(() => void tick(), 0); if (!this.keepAlive) this.timer.unref();
  }
  async sync(snapshot: MailConnection): Promise<void> {
    if (this.running.has(snapshot.id)) throw new Error("mail sync already running");
    this.running.add(snapshot.id);
    try {
      let c = this.connection(snapshot, snapshot.id);
      const remote = (await this.bus(c, "GET", "/mail-bindings", undefined, true)).bindings?.find((r: Data) => r.id === c.id);
      if (!remote) throw new Error("mail connection is no longer authorized");
      if (["provider", "mailbox", "projectId", "mainBotId", "transport"].some(k => (remote[k] || (k === "transport" ? c.provider === "tencent" ? "cli" : "api" : "")) !== ((c as Data)[k] || (k === "transport" ? c.provider === "tencent" ? "cli" : "api" : "")))) throw new Error("mail routing changed in Desk; explicitly bind this host again");
      if (["imapHost", "imapPort", "imapSecurity", "smtpHost", "smtpPort", "smtpSecurity"].some(k => (remote.servers?.[k] || null) !== ((c.servers as Data | undefined)?.[k] || null))) throw new Error("mail servers changed in Desk; explicitly verify and bind this host again");
      if (remote.revision !== c.deskRevision || remote.paused !== c.paused || remote.removed) {
        const beforeRevision = c.revision;
        c.paused = remote.paused || remote.removed; c.deskRevision = remote.revision;
        c.allowReplies = remote.allowReplies; c.revision++; this.update(c, beforeRevision);
      }
      if (c.paused || this.closed) throw new Error("mail intake is paused or stopped");
      const activeRevision = c.revision;
      let lease: Data, leasedAt = 0;
      const ensureLease = async () => {
        const latest = this.connection(c, c.id);
        if (latest.paused || latest.revision !== activeRevision || this.closed) throw new Error("mail intake configuration changed or receiver stopped");
        if (Date.now() - leasedAt < 30_000) return;
        lease = await this.bus(c, "POST", `/mail-bindings/${c.id}/lease`, { receiverId: this.receiverId, receiverFence: this.leases.get(c.id) || 0 }, true);
        this.leases.set(c.id, lease.receiverFence); leasedAt = Date.now();
      };
      await ensureLease();
      const drain = async () => {
        c = this.connection(c, c.id);
        for (const leaf of c.pending.slice(0, 50)) {
          await ensureLease();
          const m = read([c.id, "inbox"], leaf)!;
          const latest = this.connection(c, c.id); if (latest.paused || latest.revision !== activeRevision) throw new Error("mail intake configuration changed");
          const result = await this.bus(c, "POST", "/intake", { projectId: c.projectId, bindingId: c.id, receiverId: this.receiverId, receiverFence: lease!.receiverFence,
            requestKey: `mail:${c.id}:${leaf.slice(0, 64)}`, title: m.subject, body: `[Untrusted mail; sender/roles are assertions]\nFrom: ${m.from}\n\n${m.body}`, sourceMessageId: m.id, kind: "feedback" }, true);
          m.state = "submitted"; m.taskId = result.task.id; save([c.id, "inbox"], leaf, m);
          c = this.connection(c, c.id); c.pending = c.pending.filter(x => x !== leaf); this.update(c, c.revision);
        }
      };
      await drain(); // Already durably received mail can reach Desk even during a provider outage.
      if (c.transport === "imap-smtp" && c.allowReplies) await this.sendQueued(c, () => ensureLease(), () => lease!);
      await this.verify(c.provider, c.mailbox, c.transport);
      let messages: Data[], cursor: string | undefined, before = c.windowBefore || new Date().toISOString();
      if (c.provider === "tencent") {
        const r = await this.run(c.provider, ["message", "+list", "--dir", "inbox", "--limit", "20", "--after", c.after, "--before", before, ...(c.pageCursor ? ["--cursor", c.pageCursor] : [])]);
        messages = r.data?.data;
        if (!Array.isArray(messages)) throw new Error("provider returned an invalid message list");
        cursor = r.data.pagination?.has_more ? r.data.pagination.next_cursor : undefined;
        if (r.data.pagination?.has_more && !cursor) throw new Error("provider pagination cursor missing");
      } else {
        const r = await this.run(c.provider, c.transport === "imap-smtp"
          ? [...this.imapArgs("mail-imap-messages", c.mailbox), "--after", c.after, "--before", before, "--max", "20", ...(c.pageCursor ? ["--page-cursor", c.pageCursor] : [])]
          : ["mail-messages", "--backend", "api", "--mailbox", c.mailbox, "--max", "20", "--pagination", ...(c.pageCursor ? ["--page-cursor", c.pageCursor] : [])]);
        messages = r.messages;
        if (!Array.isArray(messages)) throw new Error("shared Feishu capability returned an invalid list");
        cursor = r.has_more ? r.next_page_cursor : undefined;
        if (r.has_more && !cursor) throw new Error("shared Feishu capability needs bounded pagination support; intake cursor was not advanced");
        if (messages.some(m => !Number.isFinite(Date.parse(m.received_at || "")))) throw new Error("Feishu message timestamp missing; intake cursor was not advanced");
        messages = messages.filter(m => Date.parse(m.received_at) >= Date.parse(c.after) && Date.parse(m.received_at) <= Date.parse(before));
      }
      if (cursor && (typeof cursor !== "string" || cursor.length > 4096 || c.pageCursors?.includes(cursor))) throw new Error("mail pagination repeated or exceeded its bounds");
      for (const m of messages) {
        await ensureLease();
        const messageId = String(m.message_id || m.mail_message_id || ""); if (!messageId || messageId.length > 500) throw new Error("provider message ID missing");
        const leaf = hash(`${c.provider}:${messageId}`) + ".json";
        if (!read([c.id, "inbox"], leaf)) {
          const full = c.provider === "tencent"
            ? (await this.run(c.provider, ["message", "+read", "--id", messageId])).data
            : (await this.run(c.provider, c.transport === "imap-smtp" ? [...this.imapArgs("mail-imap-get-message", c.mailbox), "--message-id", messageId] : ["mail-get-message", "--backend", "api", "--mailbox", c.mailbox, "--message-id", messageId])).message;
          if (!full || String(full.message_id || full.mail_message_id) !== messageId) throw new Error("mail body did not match the listed message");
          const safe = (v: unknown, max: number) => redactSensitiveText(String(v || "").slice(0, max)).text;
          const message = { id: messageId, provider: c.provider, mailbox: c.mailbox, subject: safe(full.subject || m.subject || "Mail feedback", 200), from: safe(full.from?.email || full.from?.mail_address || full.from || "", 254), body: safe(full.body || full.body_plain_text || full.body_preview, 19000), receivedAt: full.created_at || full.received_at, state: "pending" };
          save([c.id, "inbox"], leaf, message);
        }
        c = this.connection(c, c.id);
        if (!c.pending.includes(leaf) && read([c.id, "inbox"], leaf)?.state === "pending") {
          if (c.pending.length >= 1000) throw new Error("mail inbox backlog limit reached");
          c.pending.push(leaf); this.update(c, c.revision);
        }
      }
      await drain();
      c = this.connection(c, c.id); c.lastSyncAt = Date.now(); c.pageCursor = cursor; c.windowBefore = cursor ? before : undefined;
      c.pageCursors = cursor ? [...(c.pageCursors || []), cursor] : [];
      if (c.pageCursors.length > 1000) throw new Error("mail catch-up page limit reached; cursor retained for inspection");
      if (!cursor) c.after = new Date(Date.parse(before) - 60_000).toISOString(); this.update(c, c.revision);
      this.states.set(c.id, { phase: "connected", error: undefined });
      await this.bus(c, "POST", `/mail-bindings/${c.id}/status`, { receiverId: this.receiverId, receiverFence: lease!.receiverFence,
        phase: "connected", lastSyncAt: c.lastSyncAt, pendingCount: c.pending.length, checks: c.checks }, true);
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : "mail intake failed").text;
      this.states.set(snapshot.id, { phase: "error", error: message });
      const fence = this.leases.get(snapshot.id);
      if (fence && !this.closed) await this.bus(snapshot, "POST", `/mail-bindings/${snapshot.id}/status`,
        { receiverId: this.receiverId, receiverFence: fence, phase: "error", error: message, pendingCount: snapshot.pending.length,
          lastSyncAt: snapshot.lastSyncAt || 0, checks: snapshot.checks }, true).catch(() => {});
      throw error;
    } finally { this.running.delete(snapshot.id); }
  }
  private async sendQueued(c: MailConnection, ensureLease: () => Promise<void>, lease: () => Data): Promise<void> {
    const messages = (await this.bus(c, "GET", `/mail-outbox?bindingId=${encodeURIComponent(c.id)}`, undefined, true)).messages || [];
    for (const m of messages.slice(0, 10)) {
      if (!/^bm_[a-f0-9]{32}$/.test(m.id)) throw new Error("invalid outgoing mail identity");
      const parts = [c.id, "outbox"], leaf = m.id + ".json";
      let journal = read(parts, leaf);
      if (!journal && m.state === "queued") {
        await ensureLease();
        const claim = await this.bus(c, "POST", `/mail-outbox/${m.id}/claim`, { requestKey: `send:${m.id}`, expectedRevision: m.revision, receiverId: this.receiverId, receiverFence: lease().receiverFence }, true);
        journal = { id: m.id, body: claim.message.body, contentHash: claim.message.contentHash, revision: claim.message.revision, receiverId: this.receiverId,
          receiverFence: lease().receiverFence, outcome: "unknown", evidence: "sending attempt started; no provider receipt was persisted" };
        save(parts, leaf, journal); // A crash after this write never causes another SMTP attempt.
        if (!claim.replayed) {
          try {
            const result = await this.run(c.provider, [...this.imapArgs("mail-smtp-send", c.mailbox), "--message-file", privateFile(parts, leaf).path, "--confirm-hash", journal.contentHash]);
            if (result.ok !== true || result.outcome !== "sent" || result.source_mailbox !== c.mailbox) throw new Error("provider receipt missing");
            journal.outcome = "sent"; journal.evidence = `${result.evidence || "SMTP accepted"}; ${result.message_id || ""}`;
          } catch { journal.evidence = "SMTP attempt ended without a confirmed receipt; verify sent mail before any new send"; }
          save(parts, leaf, journal);
        }
      }
      if (journal && m.state !== "sent" && m.state !== "failed" && m.state !== "cancelled" && m.state !== "draft") {
        await this.bus(c, "POST", `/mail-outbox/${m.id}/receipt`, { requestKey: `receipt:${m.id}`, expectedRevision: journal.revision,
          receiverId: journal.receiverId, receiverFence: journal.receiverFence, outcome: journal.outcome, evidence: journal.evidence }, true);
      }
    }
  }
  close(): void { this.closed = true; if (this.timer) clearTimeout(this.timer); this.auth?.child?.kill("SIGTERM"); if (this.auth?.timer) clearTimeout(this.auth.timer); }
}
