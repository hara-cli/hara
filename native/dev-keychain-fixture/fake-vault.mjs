// Test-only in-memory model. There is no OS-backed implementation in slice 1.
import path from "node:path";
import { createHash } from "node:crypto";
import { FixtureError, OP, NO_UI, validRef, validKey, validateRequest, decodeRequest, encodeReply } from "./protocol.mjs";
export const DEV_SERVICE = "tech.nanhara.hara.workspace.credentials.dev.v1";
export const GROUP_LIMIT = 8 * 1024 * 1024;
const fail = code => { throw new FixtureError(code); };
const account = ref => `vault.${ref.split(":")[0]}`;
// A bare vault.* ref aliases the group account of another scope. The legacy
// schema has no type discriminator, so do not read/write/delete through it.
const unambiguousRef = ref => validRef(ref) && !(ref.startsWith("vault.") && !ref.includes(":"));
export function helperEnvironment() { return { LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }; }
export function validateHelperContext({ identity, env }) {
  if (!identity || !Number.isInteger(identity.uid) || identity.uid <= 0 || identity.euid !== identity.uid
    || typeof identity.pwDir !== "string" || !path.posix.isAbsolute(identity.pwDir)
    || path.posix.normalize(identity.pwDir) !== identity.pwDir || identity.realPwDir !== identity.pwDir) fail("unavailable");
  if (!env || Object.hasOwn(env, "CFFIXED_USER_HOME") || Object.hasOwn(env, "USERPROFILE")
    || (Object.hasOwn(env, "HOME") && env.HOME !== identity.pwDir)) fail("unavailable");
  const devRoot = path.posix.join(identity.pwDir, ".hara-dev-home"), directory = identity.devDirectory;
  if (!directory || directory.isDirectory !== true || directory.symlink || directory.uid !== identity.uid || directory.realpath !== devRoot
    || (directory.mode & 0o777) !== 0o700) fail("unavailable");
  return { devRoot, lockRoot: path.posix.join(devRoot, "dev-credential-locks") };
}
export function fixtureContext() {
  return { env: helperEnvironment(), identity: { uid: 501, euid: 501, pwDir: "/fixture/user", realPwDir: "/fixture/user",
    devDirectory: { isDirectory: true, uid: 501, mode: 0o700, symlink: false, realpath: "/fixture/user/.hara-dev-home" } } };
}
export class FakeLocks {
  #tails = new Map();
  async run(key, operation) {
    const previous = this.#tails.get(key) ?? Promise.resolve(); let release;
    const next = new Promise(resolve => { release = resolve; }); this.#tails.set(key, next);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.#tails.get(key) === next) this.#tails.delete(key); }
  }
}
const sharedLocks = new FakeLocks();
export class FakeSecurity {
  items = []; calls = []; counts = new Map(); faults = []; interactionAllowed = true; sessions = [];
  constructor(items = []) { this.items = structuredClone(items); }
  injectFailure(op, nth = (this.counts.get(op) ?? 0) + 1, code = "unavailable") { this.faults.push({ op, nth, code }); }
  async call(op, details, perform) {
    const nth = (this.counts.get(op) ?? 0) + 1; this.counts.set(op, nth);
    // Metadata only. Never put an item's value in a diagnostic/operation record.
    this.calls.push({ op, ...details });
    await Promise.resolve(); // Let independent fake clients race unless the group lock is held.
    const fault = this.faults.find(value => value.op === op && value.nth === nth);
    if (fault) fail(fault.code);
    return perform();
  }
  session() { const state = { interactionAllowed: this.interactionAllowed }; this.sessions.push(state); return state; }
  getUI(state) { return this.call("getUI", {}, () => state.interactionAllowed); }
  setUI(allowed, state) { return this.call("setUI", { allowed }, () => { state.interactionAllowed = allowed; }); }
  query(service, name) { return this.call("query", { service, account: name, matchLimit: "all" }, () =>
    this.items.filter(item => item.service === service && item.account === name).map(item => ({ ...item }))); }
  add(service, name, data) { return this.call("add", { service, account: name }, () => {
    if (this.items.some(item => item.service === service && item.account === name)) fail("write_unconfirmed");
    this.items.push({ id: String(this.items.length + 1) + ":" + (this.counts.get("add") ?? 0), service, account: name, data });
  }); }
  update(id, service, name, data) { return this.call("update", { id, service, account: name }, () => {
    const item = this.items.find(item => item.id === id && item.service === service && item.account === name);
    if (!item) fail("write_unconfirmed"); item.data = data;
  }); }
  delete(id, service, name) { return this.call("delete", { id, service, account: name }, () => {
    const i = this.items.findIndex(item => item.id === id && item.service === service && item.account === name);
    if (i < 0) fail("cleanup_unconfirmed"); this.items.splice(i, 1);
  }); }
}
export class FakeDevVault {
  constructor(security, { context = fixtureContext(), locks = sharedLocks } = {}) {
    this.security = security; this.context = context; this.locks = locks;
  }
  async exact(name) {
    const items = await this.security.query(DEV_SERVICE, name);
    if (items.length > 1) fail("credential_unreadable");
    return items[0];
  }
  async group(ref) {
    const name = account(ref), item = await this.exact(name);
    if (!item) return { name, values: Object.create(null) };
    try {
      if (typeof item.data !== "string" || Buffer.byteLength(item.data, "utf8") > GROUP_LIMIT) throw new Error();
      const record = JSON.parse(item.data);
      if (!record || Object.keys(record).some(key => !["schemaVersion", "values"].includes(key)) || record.schemaVersion !== 1 || !record.values || typeof record.values !== "object" || Array.isArray(record.values)) throw new Error();
      for (const [key, value] of Object.entries(record.values)) {
        if (!unambiguousRef(key) || account(key) !== name || !validKey(value)) throw new Error();
      }
      return { name, item, values: Object.assign(Object.create(null), record.values) };
    } catch { fail("credential_unreadable"); }
  }
  async operation(request) {
    const { op, entries } = request, ref = entries[0].ref, group = await this.group(ref);
    if (op === OP.GET) {
      if (Object.hasOwn(group.values, ref)) return group.values[ref];
      const legacy = await this.exact(ref);
      if (!legacy) return undefined;
      if (!validKey(legacy.data)) fail("credential_unreadable"); return legacy.data;
    }
    if (op === OP.SET_MANY) {
      for (const entry of entries) group.values[entry.ref] = entry.key;
      const payload = JSON.stringify({ schemaVersion: 1, values: group.values });
      if (Buffer.byteLength(payload, "utf8") > GROUP_LIMIT) fail("invalid_request");
      try {
        if (group.item) await this.security.update(group.item.id, DEV_SERVICE, group.name, payload);
        else await this.security.add(DEV_SERVICE, group.name, payload);
        const saved = await this.group(ref);
        if (JSON.stringify(saved.values) !== JSON.stringify(group.values)) fail("write_unconfirmed");
      } catch { fail("write_unconfirmed"); }
      return undefined;
    }
    // Group and legacy removal deliberately are not represented as a multi-item transaction.
    try {
      if (Object.hasOwn(group.values, ref)) {
        delete group.values[ref];
        if (Object.keys(group.values).length) {
          await this.security.update(group.item.id, DEV_SERVICE, group.name, JSON.stringify({ schemaVersion: 1, values: group.values }));
        } else await this.security.delete(group.item.id, DEV_SERVICE, group.name);
      }
      const legacy = await this.exact(ref);
      if (legacy) await this.security.delete(legacy.id, DEV_SERVICE, ref);
      if (Object.hasOwn((await this.group(ref)).values, ref) || await this.exact(ref)) fail("cleanup_unconfirmed");
    } catch { fail("cleanup_unconfirmed"); }
    return undefined;
  }
  async execute(request) {
    validateRequest(request);
    if (request.entries.some(({ ref }) => !unambiguousRef(ref))) fail("credential_unreadable");
    const { lockRoot } = validateHelperContext(this.context);
    if ((request.flags & NO_UI) === 0) fail("access_denied"); // No interactive path in slice 1.
    const name = account(request.entries[0].ref), key = path.posix.join(lockRoot, createHash("sha256").update(name).digest("hex"));
    return this.locks.run(key, async () => {
      const session = this.security.session(); let prior, error, value;
      try { prior = await this.security.getUI(session); await this.security.setUI(false, session); value = await this.operation(request); }
      catch (cause) { error = cause instanceof FixtureError ? cause : new FixtureError("unavailable"); }
      finally {
        if (prior !== undefined) {
          try { await this.security.setUI(prior, session); }
          catch { error = new FixtureError(request.op === OP.SET_MANY ? "write_unconfirmed" : request.op === OP.REMOVE ? "cleanup_unconfirmed" : "unavailable"); }
        }
      }
      if (error) throw error; return value;
    });
  }
  async frame(frame) {
    const request = decodeRequest(frame);
    try { return encodeReply({ nonce: request.nonce, value: await this.execute(request) }); }
    catch (error) { return encodeReply({ nonce: request.nonce, code: error instanceof FixtureError ? error.code : "unavailable" }); }
  }
}
