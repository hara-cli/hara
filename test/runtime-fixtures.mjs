// Inert native headers and in-memory archives for the approved local-source installer tests.
// These are NOT runnable third-party tools, signatures, or evidence of vendor compatibility.
import { gzipSync, deflateRawSync } from "node:zlib";
export function native(platform = process.platform, arch = process.arch) {
  const bytes = Buffer.alloc(128);
  if (platform === "darwin") { bytes.writeUInt32BE(0xcffaedfe, 0); bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4); }
  else if (platform === "win32") { bytes[0] = 0x4d; bytes[1] = 0x5a; bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 68); }
  else { bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(arch === "arm64" ? 183 : 62, 18); }
  return bytes;
}
export function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); } return (crc ^ 0xffffffff) >>> 0; }
export function tar(entries) {
  return gzipSync(Buffer.concat([...entries.flatMap(({ name, bytes = Buffer.alloc(0), type = "0" }) => {
    const header = Buffer.alloc(512); header.write(name); header.write("0000755\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124); header.write("00000000000\0", 136); header.fill(32, 148, 156); header.write(type, 156);
    header.write(header.reduce((n, byte) => n + byte, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    return [header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)];
  }), Buffer.alloc(1024)]));
}
export function zip(entries) {
  const chunks = [], directory = []; let offset = 0;
  for (const { name, bytes = Buffer.alloc(0), mode = 0x81ed, method = 0 } of entries) {
    const key = Buffer.from(name), data = method === 8 ? deflateRawSync(bytes) : bytes, local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(key.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc32(bytes), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(key.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    chunks.push(local, key, data); directory.push(central, key); offset += local.length + key.length + data.length;
  }
  const end = Buffer.alloc(22), central = Buffer.concat(directory); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, central, end]);
}
