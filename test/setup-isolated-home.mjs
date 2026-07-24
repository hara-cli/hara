// Node's test runner executes this preload in every test-file process. Give each process its own HOME so
// config/profile migrations and private-state hardening tests can never race with another test file or the
// developer's running Hara instance.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// macOS exposes /var as a symlink to /private/var. Store the canonical spelling so security checks that
// compare verified symlink targets do not mistake the OS alias for a foreign path.
const isolatedHome = realpathSync.native(mkdtempSync(join(tmpdir(), "hara-test-home-")));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;

process.once("exit", () => {
  try {
    rmSync(isolatedHome, { recursive: true, force: true });
  } catch {
    // The OS temp cleaner is the final fallback; test results must retain their original exit status.
  }
});
