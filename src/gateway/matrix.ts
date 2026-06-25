// Matrix adapter for `hara gateway` — client-server API with a /sync long-poll (built-in fetch, zero new dep;
// no WebSocket). Mirrors the Telegram long-poll model and the Discord download-media/sendFile patterns. Creds
// from HARA_MATRIX_HOMESERVER (e.g. https://matrix.org) + HARA_MATRIX_TOKEN (access token) + HARA_MATRIX_USER_ID
// (the bot's own @user:server, for self-filtering). Same ChatAdapter shape as the others, so all cross-platform
// gateway plumbing (send_file, system context, stuck-guard, image attach/describe) works unchanged.
//
// LIMITATION (v1): NO end-to-end encryption. Encrypted rooms (m.room.encrypted events) are skipped — only
// plaintext rooms work. E2EE would need libolm + a crypto store (see hermes' matrix-nio adapter), which breaks
// the zero-dep constraint. Invite this bot into UNENCRYPTED rooms only.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const isImage = (name: string, mime?: string): boolean =>
  (mime?.startsWith("image/") ?? false) || /\.(png|jpe?g|gif|webp)$/i.test(name);

const mimeFromExt = (name: string): string => {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    mp4: "video/mp4", mp3: "audio/mpeg", ogg: "audio/ogg", pdf: "application/pdf", txt: "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
};

/** Parse `mxc://server/mediaId` → its two parts (pure). null if not an mxc URL. */
export function parseMxc(mxc: string): { server: string; mediaId: string } | null {
  if (typeof mxc !== "string" || !mxc.startsWith("mxc://")) return null;
  const rest = mxc.slice(6); // strip "mxc://"
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const server = rest.slice(0, slash);
  const mediaId = rest.slice(slash + 1);
  if (!server || !mediaId) return null;
  return { server, mediaId };
}

/** Extract an InboundMsg from a single Matrix timeline event (pure). Accepts m.room.message of msgtype m.text
 *  (and friends carrying a body) plus m.image (→ marker text + the mxc url to download in start()). Ignores our
 *  own messages and encrypted events. Returns the InboundMsg + the image's mxc url (null if none). null = skip. */
export function parseMatrixEvent(
  event: any,
  selfUserId: string,
): { msg: InboundMsg; imageMxc: string | null } | null {
  if (!event || event.type !== "m.room.message") return null; // encrypted (m.room.encrypted) / state events → skip
  const sender = typeof event.sender === "string" ? event.sender : "";
  const roomId = typeof event.__roomId === "string" ? event.__roomId : ""; // injected by start() (events carry no room id)
  if (!sender || !roomId) return null;
  if (sender === selfUserId) return null; // ignore our own messages
  const content = event.content ?? {};
  const msgtype = typeof content.msgtype === "string" ? content.msgtype : "";
  const body = typeof content.body === "string" ? content.body : "";
  let imageMxc: string | null = null;
  let text = body;
  if (msgtype === "m.image") {
    imageMxc = typeof content.url === "string" && content.url.startsWith("mxc://") ? content.url : null;
    text = body || "[图片]";
  } else if (!body) {
    return null; // text-less non-image (sticker/location/reaction-as-message/etc.)
  }
  return {
    msg: {
      chatId: roomId,
      userId: sender,
      userName: sender,
      text: text || "[图片]",
    },
    imageMxc,
  };
}

/** Download a Matrix mxc:// media to a local path under ~/.hara/matrix/media (resolves via /_matrix/media/v3/download). */
async function downloadMatrixMedia(homeserver: string, token: string, mxc: string): Promise<string | null> {
  const parts = parseMxc(mxc);
  if (!parts) return null;
  try {
    const url = `${homeserver}/_matrix/media/v3/download/${encodeURIComponent(parts.server)}/${encodeURIComponent(parts.mediaId)}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const dir = join(homedir(), ".hara", "matrix", "media");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `mx_${Date.now()}_${parts.mediaId.slice(-12)}`);
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
    return path;
  } catch {
    return null;
  }
}

export function matrixAdapter(homeserver: string, token: string, selfUserId: string): ChatAdapter {
  const base = homeserver.replace(/\/+$/, ""); // trim trailing slashes
  const auth = { Authorization: `Bearer ${token}` };
  let txnSeq = Date.now(); // monotonically increasing txn id base (survives clock-ish across a process run)
  const nextTxn = (): string => `hara${++txnSeq}`;

  return {
    name: "matrix",
    async send(chatId, text) {
      for (const part of chunkText(text || "(empty)", 4000)) {
        const txn = nextTxn();
        await fetch(`${base}/_matrix/client/v3/rooms/${encodeURIComponent(String(chatId))}/send/m.room.message/${txn}`, {
          method: "PUT",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ msgtype: "m.text", body: part }),
        }).catch(() => {});
      }
    },
    async sendFile(chatId, filePath) {
      const name = basename(filePath);
      const mime = mimeFromExt(name);
      try {
        // 1) upload bytes → content_uri (mxc://)
        const up = await fetch(`${base}/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`, {
          method: "POST",
          headers: { ...auth, "content-type": mime },
          body: readFileSync(filePath),
        });
        if (!up.ok) return;
        const j = (await up.json()) as { content_uri?: string };
        const mxc = j?.content_uri;
        if (!mxc) return;
        // 2) send a referencing m.room.message — m.image for images, m.file otherwise
        const msgtype = isImage(name, mime) ? "m.image" : "m.file";
        const txn = nextTxn();
        await fetch(`${base}/_matrix/client/v3/rooms/${encodeURIComponent(String(chatId))}/send/m.room.message/${txn}`, {
          method: "PUT",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ msgtype, body: name, filename: name, url: mxc, info: { mimetype: mime } }),
        }).catch(() => {});
      } catch {
        /* upload/send failed — surfaced upstream as "no file delivered" */
      }
    },
    async start(onMessage, signal) {
      // Prime the cursor: a since-less, timeout=0 sync skips backlog so we only see messages from now on.
      let since = "";
      try {
        const r = await fetch(`${base}/_matrix/client/v3/sync?timeout=0`, { headers: auth, signal });
        if (r.ok) {
          const j = (await r.json()) as { next_batch?: string };
          if (typeof j.next_batch === "string") since = j.next_batch;
        }
      } catch {
        if (signal.aborted) return;
      }
      while (!signal.aborted) {
        try {
          const q = `timeout=30000${since ? `&since=${encodeURIComponent(since)}` : ""}`;
          const res = await fetch(`${base}/_matrix/client/v3/sync?${q}`, { headers: auth, signal });
          if (!res.ok) {
            await sleep(2000);
            continue;
          }
          const j = (await res.json()) as {
            next_batch?: string;
            rooms?: { join?: Record<string, { timeline?: { events?: any[] } }> };
          };
          if (typeof j.next_batch === "string") since = j.next_batch;
          const join = j.rooms?.join ?? {};
          for (const [roomId, room] of Object.entries(join)) {
            for (const event of room?.timeline?.events ?? []) {
              event.__roomId = roomId; // events carry no room id in /sync — inject it for the pure parser
              const parsed = parseMatrixEvent(event, selfUserId);
              if (!parsed) continue;
              if (parsed.imageMxc) {
                const path = await downloadMatrixMedia(base, token, parsed.imageMxc);
                if (path) parsed.msg.images = [path];
              }
              await onMessage(parsed.msg).catch(() => {});
            }
          }
        } catch {
          if (signal.aborted) break;
          await sleep(2000); // network blip → back off + retry
        }
      }
    },
  };
}
