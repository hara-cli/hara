// A local, per-occurrence READ-ONLY compatibility bridge. No global CLI/8790/Home fallback.
import net from "node:net";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { canonical, deepFreeze, exact, plain } from "./local-state.js";
import { redactToolSubprocessOutput } from "../security/subprocess-env.js";
import type { LegacyCliLease, LegacyCommandReview } from "./legacy-command.js";


/** AF_UNIX endpoint budget kept by LegacyScopedCli (≤100 bytes including "legacy-cli.sock"). */
export const LEGACY_CLI_SOCKET_ENDPOINT_MAX_BYTES = 100;
const LEGACY_CLI_SOCKET_NAME = "legacy-cli.sock";

/**
 * Host prepareCli / test harness contract: allocate an owner-only socket directory whose
 * `legacy-cli.sock` endpoint stays ≤ {@link LEGACY_CLI_SOCKET_ENDPOINT_MAX_BYTES}.
 * Never place sockets under evidence `HOME` / `TMPDIR` / `TEMP` / `HARA_HOME` — those paths
 * are intentionally long for isolation and blow the AF_UNIX budget.
 * Prefer `HARA_PRIVATE_SOCKET_DIR` when set (must already be a short, owned, mode-0700 dir);
 * otherwise use a short sticky parent under `/tmp` (realpath on Darwin → `/private/tmp`).
 */
export function allocatePrivateSocketRoot(env: NodeJS.ProcessEnv = process.env): string {
  const parent = resolvePrivateSocketParent(env);
  const root = realpathSync(mkdtempSync(join(parent, "h")));
  chmodSync(root, 0o700);
  const info = lstatSync(root);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Private owner socket directory required");
  const endpoint = join(root, LEGACY_CLI_SOCKET_NAME);
  if (Buffer.byteLength(endpoint) > LEGACY_CLI_SOCKET_ENDPOINT_MAX_BYTES)
    throw new Error("Explicit shorter private socket directory required");
  return root;
}

function resolvePrivateSocketParent(env: NodeJS.ProcessEnv): string {
  const configured = env.HARA_PRIVATE_SOCKET_DIR?.trim();
  if (configured) {
    const parent = realpathSync(configured);
    const info = lstatSync(parent);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error("Private owner socket directory required");
    // parent + /hXXXXXX + /legacy-cli.sock must stay ≤100 (mkdtemp suffix length 6).
    const probe = join(parent, "hXXXXXX", LEGACY_CLI_SOCKET_NAME);
    if (Buffer.byteLength(probe) > LEGACY_CLI_SOCKET_ENDPOINT_MAX_BYTES)
      throw new Error("Explicit shorter private socket directory required");
    return parent;
  }
  // Short sticky tmp — independent of evidence TMPDIR / os.tmpdir().
  const sticky = realpathSync("/tmp");
  const probe = join(sticky, "hXXXXXX", LEGACY_CLI_SOCKET_NAME);
  if (Buffer.byteLength(probe) > LEGACY_CLI_SOCKET_ENDPOINT_MAX_BYTES)
    throw new Error("Explicit shorter private socket directory required");
  return sticky;
}

export class LegacyScopedCli {
  private readonly token = randomBytes(32).toString("hex");
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private live = false;
  private ownedSocket?: { dev: number; ino: number };
  private readonly review: Readonly<LegacyCommandReview>;
  readonly endpoint: string;
  constructor(private readonly options: { socketRoot: string; review: Readonly<LegacyCommandReview>; assertCurrent(): void;
    readLogs(id: string, lines: number): string; knownSecrets?: readonly string[] }) {
    const info = lstatSync(options.socketRoot);
    this.review = deepFreeze(structuredClone(options.review));
    if (realpathSync(options.socketRoot) !== options.socketRoot || !info.isDirectory() || info.uid !== process.getuid?.()
      || (info.mode & 0o077) !== 0) throw new Error("Private owner socket directory required");
    this.endpoint = join(options.socketRoot, "legacy-cli.sock");
    if (Buffer.byteLength(this.endpoint) > LEGACY_CLI_SOCKET_ENDPOINT_MAX_BYTES) throw new Error("Explicit shorter private socket directory required");
    try { lstatSync(this.endpoint); throw new Error("CLI socket path already exists"); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
    this.server = net.createServer(socket => {
      this.sockets.add(socket); socket.once("close", () => this.sockets.delete(socket)); socket.on("error", () => {});
      socket.setTimeout(5000, () => socket.destroy()); let body = "";
      socket.setEncoding("utf8"); socket.on("data", chunk => {
        body += chunk; if (body.length > 8192) { socket.destroy(); return; }
        if (!body.includes("\n")) return;
        socket.pause(); let response = { code: 2, output: "Scoped legacy CLI refused; no global fallback\n" };
        try {
          const request = JSON.parse(body);
          if (!this.live || !plain(request) || !exact(request, ["token", "argv"]) || typeof request.token !== "string"
            || !/^[a-f0-9]{64}$/.test(request.token) || !timingSafeEqual(Buffer.from(request.token), Buffer.from(this.token))
            || !Array.isArray(request.argv) || request.argv.length > 6 || request.argv.some(arg => typeof arg !== "string" || arg.length > 256)) throw new Error();
          this.assertCurrent();
          const args = request.argv as string[];
          if (args[0] !== "cron" || args[1] !== "logs" || args[2] !== this.review.scheduleId
            || !(args.length === 3 || args.length === 5 && ["-n", "--lines"].includes(args[3]!) && /^[1-9][0-9]{0,2}$/.test(args[4]!))) throw new Error();
          const logs = this.options.readLogs(args[2]!, args[4] === undefined ? 40 : Number(args[4]));
          if (typeof logs !== "string") throw new Error(); this.assertCurrent();
          const secrets = Object.fromEntries([this.token, ...(this.options.knownSecrets ?? [])].map((value, i) => [`SECRET_${i}`, value]));
          response = { code: 0, output: redactToolSubprocessOutput(logs, {}, secrets).slice(0, 8000) };
        } catch { /* Fixed public error only, never echo argv, tokens, paths or exception bodies. */ }
        socket.end(JSON.stringify(response) + "\n");
      });
    });
  }
  private assertCurrent() {
    if (!this.live) throw new Error("CLI lease unavailable");
    const value: unknown = this.options.assertCurrent(); if (value === undefined) return;
    if (value && typeof (value as { then?: unknown }).then === "function") void Promise.resolve(value).catch(() => {});
    throw new Error("CLI lease fence must be synchronous");
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.endpoint, () => { this.server.removeListener("error", reject); resolve(); }); });
    chmodSync(this.endpoint, 0o600); const info = lstatSync(this.endpoint); this.ownedSocket = { dev: info.dev, ino: info.ino }; this.live = true;
  }
  lease(review: Readonly<LegacyCommandReview>): LegacyCliLease {
    this.assertCurrent(); if (canonical(review) !== canonical(this.review)) throw new Error("CLI occurrence scope changed");
    return { env: { HARA_LEGACY_CLI_SOCKET: this.endpoint, HARA_LEGACY_CLI_TOKEN: this.token }, assertCurrent: () => this.assertCurrent() };
  }
  async close() {
    this.live = false; for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    try { const info = lstatSync(this.endpoint); if (this.ownedSocket && info.isSocket() && info.uid === process.getuid?.()
      && info.dev === this.ownedSocket.dev && info.ino === this.ownedSocket.ino) unlinkSync(this.endpoint); } catch { /* owned socket may already be gone */ }
  }
}

/** Executed before portable/global startup whenever either bridge env field is present. */
export async function mainLegacyScopedCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const endpoint = env.HARA_LEGACY_CLI_SOCKET, token = env.HARA_LEGACY_CLI_TOKEN;
  const fail = () => { process.stderr.write("Scoped legacy CLI unavailable; no global fallback\n"); process.exitCode = 2; };
  if (!endpoint?.startsWith("/") || endpoint.length > 100 || !token || !/^[a-f0-9]{64}$/.test(token) || args.length > 6) { fail(); return; }
  try {
    const reply = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const socket = net.createConnection(endpoint); let body = "", settled = false;
      const stop = (error?: Error) => { if (settled) return; settled = true; socket.destroy(); if (error) reject(error); };
      socket.setEncoding("utf8"); socket.setTimeout(5000, () => stop(new Error())); socket.once("error", () => stop(new Error()));
      socket.once("connect", () => socket.write(JSON.stringify({ token, argv: args }) + "\n"));
      socket.on("data", chunk => {
        body += chunk; if (body.length > 40000) { stop(new Error()); return; }
        if (!body.includes("\n")) return;
        try {
          const response = JSON.parse(body);
          if (!plain(response) || !exact(response, ["code", "output"]) || ![0, 2].includes(response.code as number)
            || typeof response.output !== "string" || response.output.length > 8000) throw new Error();
          if (!settled) { settled = true; socket.destroy(); resolve(response as { code: number; output: string }); }
        } catch { stop(new Error()); }
      });
      socket.once("close", () => { if (!settled) stop(new Error()); });
    });
    process.stdout.write(reply.output); process.exitCode = reply.code;
  } catch { fail(); }
}
