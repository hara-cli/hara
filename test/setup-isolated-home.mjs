// Node's test runner executes this preload in every test-file process. Give each process its own HOME so
// config/profile migrations and private-state hardening tests can never race with another test file or the
// developer's running Hara instance.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// macOS /var aliases and Windows 8.3 TEMP spellings must not become fixture authority aliases.
// Candidate callers already canonicalize their temp root; keep ordinary CI fixtures equivalent.
const canonicalTemp = realpathSync.native(tmpdir());
process.env.TMPDIR = canonicalTemp;
process.env.TMP = canonicalTemp;
process.env.TEMP = canonicalTemp;
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
