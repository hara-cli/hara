import { gunzipSync, inflateRawSync } from "node:zlib";

const LIMIT = 512 * 1024 * 1024;
function safe(name: string): boolean {
  return /^[A-Za-z0-9_.+/-]{1,200}$/.test(name) && !name.startsWith("/") && !name.split("/").some(part => part === ".." || part === "." || part === "");
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Read only an exact regular-file member into memory. Never unpack paths, links or execute archive code. */
export function runtimeArchiveMember(archive: Buffer, format: "raw" | "tar.gz" | "zip", member: string | null): Buffer {
  if (archive.length < 64 || archive.length > LIMIT) throw new Error("Runtime archive size is invalid");
  if (format === "raw") { if (member !== null) throw new Error("Unexpected raw runtime member"); return archive; }
  if (format !== "tar.gz" && format !== "zip") throw new Error("Unsupported runtime archive format");
  if (!member || !safe(member)) throw new Error("Invalid runtime archive member");
  let found: Buffer | undefined;
  const names = new Set<string>();
  const accept = (name: string, bytes: () => Buffer, regular: boolean) => {
    if (!safe(name) || names.has(name)) throw new Error("Unsafe or duplicate runtime archive entry");
    names.add(name); if (names.size > 256) throw new Error("Runtime archive has too many entries");
    if (name === member) { if (!regular || found) throw new Error("Runtime member is not one regular file"); found = bytes(); }
  };
  if (format === "tar.gz") {
    const bytes = gunzipSync(archive, { maxOutputLength: LIMIT });
    let offset = 0;
    while (offset + 512 <= bytes.length && bytes.subarray(offset, offset + 512).some(byte => byte !== 0)) {
      const header = bytes.subarray(offset, offset + 512), str = (at: number, length: number) => header.subarray(at, at + length).toString("utf8").replace(/\0.*$/s, "");
      const sizeText = str(124, 12).trim(); if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid runtime tar size");
      const size = parseInt(sizeText, 8), type = str(156, 1), prefix = str(345, 155);
      const checksum = str(148, 8).trim();
      if (!/^[0-7]+$/.test(checksum) || header.reduce((n, byte, index) => n + (index >= 148 && index < 156 ? 32 : byte), 0) !== parseInt(checksum, 8)
        || !["", "0", "5"].includes(type) || size > LIMIT || offset + 512 + size > bytes.length) throw new Error("Unsafe runtime tar header/link");
      const name = ((prefix ? `${prefix}/` : "") + str(0, 100)).replace(/^\.\//, "");
      if (type === "5" && size !== 0) throw new Error("Invalid runtime tar directory size");
      if (name !== "" || type !== "5") accept(type === "5" ? name.replace(/\/$/, "") : name, () => Buffer.from(bytes.subarray(offset + 512, offset + 512 + size)), type !== "5");
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (offset + 1024 > bytes.length || bytes.subarray(offset).some(byte => byte !== 0)) throw new Error("Invalid runtime tar termination");
  } else {
    let end = -1;
    for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) if (archive.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    if (end < 0 || archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || end + 22 + archive.readUInt16LE(end + 20) !== archive.length) throw new Error("Unsupported runtime zip");
    const count = archive.readUInt16LE(end + 10), central = archive.readUInt32LE(end + 16), centralSize = archive.readUInt32LE(end + 12);
    let offset = central, total = 0; const ranges: [number, number][] = [];
    if (archive.readUInt16LE(end + 8) !== count || central + centralSize !== end) throw new Error("Invalid runtime zip directory size");
    if (count > 256) throw new Error("Runtime zip entry limit");
    for (let i = 0; i < count; i++) {
      if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("Invalid runtime zip directory");
      const flags = archive.readUInt16LE(offset + 8), method = archive.readUInt16LE(offset + 10), compressed = archive.readUInt32LE(offset + 20), size = archive.readUInt32LE(offset + 24);
      const nameSize = archive.readUInt16LE(offset + 28), extra = archive.readUInt16LE(offset + 30), comment = archive.readUInt16LE(offset + 32), mode = archive.readUInt32LE(offset + 38) >>> 16, local = archive.readUInt32LE(offset + 42);
      if (flags & ~0x0808 || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || (mode & 0xf000) && ![0x8000, 0x4000].includes(mode & 0xf000)
        || archive.readUInt16LE(offset + 34) || (total += size) > LIMIT || offset + 46 + nameSize + extra + comment > end || local + 30 > central || archive.readUInt32LE(local) !== 0x04034b50) throw new Error("Unsafe runtime zip entry/link");
      const name = archive.subarray(offset + 46, offset + 46 + nameSize).toString("utf8"), localNameSize = archive.readUInt16LE(local + 26), localExtra = archive.readUInt16LE(local + 28);
      const start = local + 30 + localNameSize + localExtra;
      if (archive.subarray(local + 30, local + 30 + localNameSize).toString("utf8") !== name || start + compressed > central
        || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method
        || !(flags & 8) && (archive.readUInt32LE(local + 14) !== archive.readUInt32LE(offset + 16) || archive.readUInt32LE(local + 18) !== compressed || archive.readUInt32LE(local + 22) !== size)
        || (mode & 0xf000) === 0x4000 && !name.endsWith("/") || name.endsWith("/") && size !== 0
        || ranges.some(([a, b]) => local < b && start + compressed > a)) throw new Error("Runtime zip entry identity changed");
      ranges.push([local, start + compressed]);
      accept(name.replace(/\/$/, ""), () => {
        const data = archive.subarray(start, start + compressed), bytes = method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: LIMIT });
        if (bytes.length !== size || crc32(bytes) !== archive.readUInt32LE(offset + 16)) throw new Error("Runtime zip length/checksum mismatch"); return bytes;
      }, !name.endsWith("/"));
      offset += 46 + nameSize + extra + comment;
    }
    if (offset !== end) throw new Error("Invalid runtime zip directory termination");
  }
  if (!found || found.length < 64 || found.length > LIMIT) throw new Error("Runtime executable missing or oversized");
  return found;
}
