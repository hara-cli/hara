import { registerTool } from "./registry.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function localPreviewUrl(input: unknown): URL | null {
  if (typeof input !== "string" || input.length < 1 || input.length > 4_096) return null;
  try {
    const parsed = new URL(input);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      parsed.protocol !== "http:"
      || parsed.username
      || parsed.password
      || !parsed.port
      || !LOOPBACK_HOSTS.has(hostname)
    ) return null;
    const port = Number(parsed.port);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
    return parsed;
  } catch {
    return null;
  }
}

registerTool({
  name: "visual_preview",
  description:
    "Offer an already-running local web development server to Hara Desktop's right Visual Dock. "
    + "Use this after starting a Node/Vite/Next/static server on an explicit localhost port. "
    + "Only loopback HTTP URLs without credentials are accepted; remote websites and shell commands are rejected. "
    + "The tool can prove only that an offer was emitted, not that a Desktop loaded or displayed it.",
  input_schema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Loopback HTTP URL with an explicit port, for example http://127.0.0.1:5173/",
      },
      title: {
        type: "string",
        description: "Short tab title, for example Product preview",
      },
    },
    required: ["url"],
  },
  kind: "edit",
  requiresProjectWorkspace: true,
  classify() {
    return { effect: "state", concurrencySafe: false };
  },
  async run(input, ctx) {
    const parsed = localPreviewUrl(input.url);
    if (!parsed) {
      return "Error: visual_preview requires an http://localhost, http://127.0.0.1, or http://[::1] URL with an explicit port and no credentials.";
    }
    const title = typeof input.title === "string"
      ? input.title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200)
      : "Web preview";
    const safeTitle = title || "Web preview";
    const surfaceOfferEmitted = typeof ctx.ui?.surface === "function";
    ctx.ui?.surface?.({
      kind: "browser",
      title: safeTitle,
      resource: { type: "url", url: parsed.toString() },
    });
    return JSON.stringify({
      surfaceOfferEmitted,
      openedInDesktop: false,
      origin: parsed.origin,
      title: safeTitle,
      meaning: surfaceOfferEmitted
        ? "The host was notified about this loopback preview; this does not prove that it loaded, became visible, or is the active tab."
        : "No persistent visual host was attached, so no Desktop surface was offered.",
      next: "Keep the Hara background job running for live reload; stop it with the job tool when the preview is no longer needed.",
    }, null, 2);
  },
});
