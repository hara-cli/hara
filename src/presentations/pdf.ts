import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  openSync,
  closeSync,
  readSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { terminateSubprocessTree, toolSubprocessEnv } from "../security/subprocess-env.js";
import { findHeadlessBrowser } from "../tools/headless-web.js";

const PDF_RENDER_TIMEOUT_MS = 60_000;
const MAX_PRESENTATION_PDF_BYTES = 256 * 1024 * 1024;

export interface PresentationPdfResult {
  bytes: Uint8Array;
  mediaType: "application/pdf";
  fidelity: "visual-fidelity";
  pageCount: number;
}

function checkedBrowserPath(value: string | undefined): string {
  if (!value) {
    const error = new Error(
      "No installed Chromium-family browser is available for direct PDF export. Install Chrome, Chromium, or Edge and retry.",
    );
    (error as any).code = "PRESENTATION_PDF_BROWSER_UNAVAILABLE";
    throw error;
  }
  if (!isAbsolute(value)) throw new Error("Presentation PDF browser path must be absolute.");
  const canonical = realpathSync.native(value);
  const info = lstatSync(canonical);
  if (!info.isFile()) throw new Error("Presentation PDF browser is not a regular executable file.");
  if (platform() !== "win32") accessSync(canonical, constants.X_OK);
  return canonical;
}

/** Validate the concrete PDF bytes before the Artifact store is allowed to publish them. Chromium keeps
 * page dictionaries uncompressed, so `/Type /Page` is an exact, dependency-free page-count boundary for
 * this renderer. A mismatch is a failed export, never a receipt for a partial deck. */
export function inspectPresentationPdf(
  bytes: Uint8Array,
  expectedPages: number,
): { pageCount: number } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 128 || bytes.byteLength > MAX_PRESENTATION_PDF_BYTES) {
    throw new Error("Presentation PDF output size is outside the supported range.");
  }
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, 8).toString("latin1").startsWith("%PDF-")) {
    throw new Error("Presentation PDF output does not have a valid PDF header.");
  }
  if (!buffer.subarray(Math.max(0, buffer.byteLength - 4096)).toString("latin1").includes("%%EOF")) {
    throw new Error("Presentation PDF output is incomplete (missing the PDF end marker).");
  }
  const source = buffer.toString("latin1");
  const pageCount = [...source.matchAll(/\/Type\s*\/Page\b(?!s)/gu)].length;
  if (!Number.isSafeInteger(expectedPages) || expectedPages < 1) {
    throw new Error("Presentation PDF expected page count is invalid.");
  }
  if (pageCount !== expectedPages) {
    throw new Error(
      `Presentation PDF page verification failed: expected ${expectedPages}, rendered ${pageCount}.`,
    );
  }
  return { pageCount };
}

function renderWithBrowser(
  browser: string,
  htmlPath: string,
  pdfPath: string,
  profilePath: string,
): Promise<void> {
  const args = [
    "--headless=new",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--disable-quic",
    "--disable-dev-shm-usage",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "--password-store=basic",
    "--use-mock-keychain",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=5000",
    "--no-pdf-header-footer",
    `--user-data-dir=${profilePath}`,
    `--disk-cache-dir=${join(profilePath, "cache")}`,
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
  const processGroup = platform() !== "win32";
  const child = spawn(browser, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: processGroup,
    windowsHide: true,
    env: toolSubprocessEnv(process.env, {
      HARA_BROWSER_PATH: undefined,
      HARA_WEB_PROXY: undefined,
      HTTPS_PROXY: undefined,
      HTTP_PROXY: undefined,
      https_proxy: undefined,
      http_proxy: undefined,
    }),
  });
  // Browser diagnostics can contain machine-specific paths. Drain them, but never include them in a
  // renderer error or model-visible receipt.
  child.stderr?.resume();
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastSize = -1;
    let stablePolls = 0;
    let cancelTree: (() => void) | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(outputPoll);
      // Chromium may finish printing while its helper processes remain alive. The verified file is the
      // success boundary; once it is stable, explicitly reap the isolated browser process group. Cleanup
      // below has its own bounded retry for the kernel's asynchronous process/file teardown window.
      if (!error && child.exitCode === null && !cancelTree) {
        cancelTree = terminateSubprocessTree(child, { processGroup, force: true });
      }
      if (error) reject(error);
      else resolve();
    };
    const outputLooksComplete = (requireStable = true): boolean => {
      let fd = -1;
      try {
        const info = lstatSync(pdfPath);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 128) return false;
        if (info.size === lastSize) stablePolls += 1;
        else stablePolls = 0;
        lastSize = info.size;
        if (requireStable && stablePolls < 2) return false;
        const tailSize = Math.min(4096, info.size);
        const tail = Buffer.allocUnsafe(tailSize);
        fd = openSync(pdfPath, constants.O_RDONLY);
        const read = readSync(fd, tail, 0, tailSize, info.size - tailSize);
        return tail.subarray(0, read).toString("latin1").includes("%%EOF");
      } catch {
        return false;
      } finally {
        if (fd >= 0) closeSync(fd);
      }
    };
    const outputPoll = setInterval(() => {
      if (outputLooksComplete()) finish();
    }, 100);
    const timer = setTimeout(() => {
      if (!cancelTree) cancelTree = terminateSubprocessTree(child, { processGroup, force: true });
      finish(new Error("Presentation PDF rendering timed out safely."));
    }, PDF_RENDER_TIMEOUT_MS);
    child.once("error", () => finish(new Error("Presentation PDF browser could not start.")));
    child.once("close", (code) => {
      // A browser that exits normally has already closed the output descriptor; the EOF marker is then
      // sufficient. Long-lived Chromium builds use the stricter two-stable-poll success path above.
      if (outputLooksComplete(false)) return finish();
      if (code !== 0) return finish(new Error("Presentation PDF browser exited before producing a verified file."));
      finish(new Error("Presentation PDF browser exited without a complete output file."));
    });
  });
}

async function removePresentationPdfTemporary(path: string): Promise<void> {
  // A stable PDF can be observed just before Chromium's forcibly-terminated helper processes finish
  // closing their profile files. APFS can return ENOTEMPTY during that short teardown window too, so the
  // bounded retry is cross-platform rather than a Windows-only exception.
  const deadline = Date.now() + 10_000;
  do {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error: any) {
      if (Date.now() >= deadline || !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error?.code ?? ""))) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } while (true);
}

/** Render the exact self-contained Hara presenter to a PDF in a private temporary directory. No remote
 * URL is opened, browser networking is disabled, and the generated bytes are checked before returning. */
export async function renderPresentationPdf(
  html: string,
  expectedPages: number,
  options: { browserPath?: string } = {},
): Promise<PresentationPdfResult> {
  if (typeof html !== "string" || html.length < 1 || Buffer.byteLength(html, "utf8") > 64 * 1024 * 1024) {
    throw new Error("Presentation HTML for PDF rendering is outside the supported range.");
  }
  const browser = checkedBrowserPath(options.browserPath ?? findHeadlessBrowser());
  const temporary = mkdtempSync(join(tmpdir(), "hara-presentation-pdf-"));
  const htmlPath = join(temporary, "presentation.html");
  const pdfPath = join(temporary, "presentation.pdf");
  const profilePath = join(temporary, "browser-profile");
  try {
    writeFileSync(htmlPath, html, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await renderWithBrowser(browser, htmlPath, pdfPath, profilePath);
    const info = lstatSync(pdfPath);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error("Presentation PDF renderer produced an unsafe output file.");
    }
    if (info.size < 128 || info.size > MAX_PRESENTATION_PDF_BYTES) {
      throw new Error("Presentation PDF renderer produced an invalid output size.");
    }
    const bytes = readFileSync(pdfPath);
    const { pageCount } = inspectPresentationPdf(bytes, expectedPages);
    return {
      bytes,
      mediaType: "application/pdf",
      fidelity: "visual-fidelity",
      pageCount,
    };
  } finally {
    await removePresentationPdfTemporary(temporary);
  }
}
