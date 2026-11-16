// K1 slice 1: test-only wire contract. Never imported by the production CLI.
import { timingSafeEqual } from "node:crypto";
export const MAX_REQUEST = 8_500_000, MAX_REPLY = 65_600, MAX_KEY_UNITS = 16_384;
export const NO_UI = 1;
export const OP = Object.freeze({ GET: 1, SET_MANY: 2, REMOVE: 3 });
export const CODES = Object.freeze(["ok", "invalid_request", "unavailable", "access_denied", "credential_unreadable", "write_unconfirmed", "cleanup_unconfirmed"]);
export class FixtureError extends Error {
  constructor(code = "invalid_request") {
    if (!CODES.includes(code) || code === "ok") code = "unavailable";
    super(`Dev credential fixture: ${code}`); this.code = code;
  }
}
export function invalid() { throw new FixtureError(); }
export const validRef = ref => typeof ref === "string" && /^[a-zA-Z0-9_.:-]{1,240}$/.test(ref);
export const validKey = key => typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_UNITS
  && key.isWellFormed() && !/[\s\u0000-\u001f\u007f]/u.test(key);
function ownKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).some(k => !allowed.includes(k))) invalid();
}
export function validateRequest(request) {
  ownKeys(request, ["op", "flags", "nonce", "entries"]);
  const { op, flags, nonce, entries } = request;
  if (![1, 2, 3].includes(op) || !Number.isInteger(flags) || flags < 0 || flags > NO_UI
    || !Buffer.isBuffer(nonce) || nonce.length !== 16 || !Array.isArray(entries)
    || !entries.length || entries.length > 256 || (op !== OP.SET_MANY && entries.length !== 1)) invalid();
  const seen = new Set(); let scope;
  for (const entry of entries) {
    ownKeys(entry, ["ref", "key"]);
    if (!validRef(entry.ref) || seen.has(entry.ref) || (op === OP.SET_MANY ? !validKey(entry.key) : entry.key !== "")) invalid();
    const prefix = entry.ref.split(":")[0];
    if (scope !== undefined && scope !== prefix) invalid();
    scope = prefix; seen.add(entry.ref);
  }
  return request;
}
export function encodeRequest(request) {
  validateRequest(request);
  const size = 28 + request.entries.reduce((n, e) => n + 2 + e.ref.length + 4 + e.key.length * 2, 0);
  if (size > MAX_REQUEST) invalid();
  const frame = Buffer.alloc(size); frame.writeUInt32LE(size - 4); frame.write("HDQ1", 4, "ascii");
  frame[8] = request.op; frame[9] = request.flags; request.nonce.copy(frame, 10); frame.writeUInt16LE(request.entries.length, 26);
  let offset = 28;
  for (const { ref, key } of request.entries) {
    frame.writeUInt16LE(ref.length, offset); offset += 2; offset += frame.write(ref, offset, "ascii");
    frame.writeUInt32LE(key.length, offset); offset += 4; offset += frame.write(key, offset, "utf16le");
  }
  return frame;
}
export function decodeRequest(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 28 || frame.length > MAX_REQUEST
    || frame.readUInt32LE() !== frame.length - 4 || !frame.subarray(4, 8).equals(Buffer.from("HDQ1"))) invalid();
  const count = frame.readUInt16LE(26), entries = []; let offset = 28;
  if (!count || count > 256) invalid();
  const take = count => { if (count > frame.length - offset) invalid(); const b = frame.subarray(offset, offset + count); offset += count; return b; };
  for (let i = 0; i < count; i++) {
    const units = take(2).readUInt16LE(); if (!units || units > 240) invalid();
    const refBytes = take(units); if (refBytes.some(c => c > 0x7f)) invalid();
    const ref = refBytes.toString("ascii"), keyUnits = take(4).readUInt32LE(); if (keyUnits > MAX_KEY_UNITS) invalid();
    entries.push({ ref, key: take(keyUnits * 2).toString("utf16le") });
  }
  if (offset !== frame.length) invalid();
  return validateRequest({ op: frame[8], flags: frame[9], nonce: Buffer.from(frame.subarray(10, 26)), entries });
}
export async function requestAfterEOF(chunks) {
  const frame = Buffer.alloc(MAX_REQUEST); let size = 0;
  try {
    for await (const chunk of chunks) {
      if (!Buffer.isBuffer(chunk) || chunk.length > MAX_REQUEST - size) invalid();
      chunk.copy(frame, size); size += chunk.length;
      if (size >= 4 && (frame.readUInt32LE() > MAX_REQUEST - 4 || size > frame.readUInt32LE() + 4)) invalid();
    }
    return decodeRequest(frame.subarray(0, size));
  } finally { frame.fill(0); }
}
export function encodeReply({ nonce, code = "ok", value }) {
  const index = CODES.indexOf(code);
  if (!Buffer.isBuffer(nonce) || nonce.length !== 16 || index < 0 || (value !== undefined && (index !== 0 || !validKey(value)))) invalid();
  const size = 30 + (value?.length ?? 0) * 2; if (size > MAX_REPLY) invalid();
  const b = Buffer.alloc(size); b.writeUInt32LE(size - 4); b.write("HDR1", 4, "ascii"); nonce.copy(b, 8);
  b[24] = index; b[25] = value === undefined ? 0 : 1; b.writeUInt32LE(value?.length ?? 0, 26);
  if (value !== undefined) b.write(value, 30, "utf16le");
  return b;
}
export function decodeReply(frame, nonce, op) {
  if (!Buffer.isBuffer(frame) || frame.length < 30 || frame.length > MAX_REPLY
    || !Buffer.isBuffer(nonce) || nonce.length !== 16 || ![1, 2, 3].includes(op)
    || frame.readUInt32LE() !== frame.length - 4 || !frame.subarray(4, 8).equals(Buffer.from("HDR1"))
    || !timingSafeEqual(frame.subarray(8, 24), nonce)) invalid();
  const code = frame[24], found = frame[25], units = frame.readUInt32LE(26);
  if (code >= CODES.length || found > 1 || units > MAX_KEY_UNITS || frame.length !== 30 + units * 2
    || (found ? op !== OP.GET || code !== 0 || !units : units !== 0) || (code !== 0 && found)) invalid();
  const value = found ? frame.toString("utf16le", 30) : undefined;
  if (value !== undefined && !validKey(value)) invalid();
  return { code: CODES[code], ...(value === undefined ? {} : { value }) };
}
