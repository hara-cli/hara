// TypeScript writes new outputs with the process umask and preserves an existing output's mode, so a clean
// release checkout and a developer tree can otherwise pack different permissions. Keep the dependency-free
// npm bootstrap executable and ordinary imported modules non-executable. npm also repairs bin links on
// install, but the archive should be correct for pnpm/Bun/direct extraction as well.
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const dist = new URL("../dist/", import.meta.url);
  await Promise.all([
    chmod(fileURLToPath(new URL("../runtime-bootstrap.cjs", import.meta.url)), 0o755),
    chmod(fileURLToPath(new URL("cli.js", dist)), 0o644),
    chmod(fileURLToPath(new URL("index.js", dist)), 0o644),
  ]);
}
