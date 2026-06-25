// Mattermost adapter for `hara gateway` — connects to a self-hosted (or cloud) Mattermost over the v4
// WebSocket (Node's native global WebSocket, zero new dep on Node ≥ 22) for inbound events, and the v4 REST
// API for outbound. Server from HARA_MATTERMOST_URL, token (bot or personal-access) from HARA_MATTERMOST_TOKEN;
// allow users via HARA_GATEWAY_ALLOWED (Mattermost user ids). Same ChatAdapter shape as Telegram/Discord, so all
// the cross-platform gateway plumbing (send_file, in-chat system context, stuck-guard, image attach/describe)
// works unchanged. Auth is a WS "authentication_challenge" rather than an HTTP header.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { chunkText, type ChatAdapter, type InboundMsg } from "./telegram.js";

const WSImpl: any = (globalThis as any).WebSocket;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((r) => {
    if (signal?.aborted) return r();
    const t = setTimeout(r, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true });
  });

const isImage = (name: string, mime?: string): boolean => (mime?.startsWith("image/") ?? false) || /\.(png|jpe?g|gif|webp)$/i.test(name);

/** Strip a trailing slash and any `/api/v4` suffix so we can rebuild paths cleanly (pure). */
function normalizeBase(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/api\/v4$/i, "");
}

/** http(s):// base → wss(s):// websocket endpoint (pure). */
function wsUrlFromBase(base: string): string {
  return normalizeBase(base).replace(/^http/i, "ws") + "/api/v4/websocket";
}

async function downloadMattermostFile(base: string, token: string, fileId: string, name: string): Promise<string | null> {
  try {
    const r = await fetch(`${normalizeBase(base)}/api/v4/files/${encodeURIComponent(fileId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const dir = join(homedir(), ".hara", "mattermost", "media");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `mm_${Date.now()}_${basename(name) || "file.bin"}`);
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
    return path;
  } catch {
    return null;
  }
}

/** Parse a Mattermost "posted" event's post → InboundMsg + its image file ids (pure; download happens in
 *  start()). The post is the already-parsed object (the event's data.post is a JSON string the caller decodes).
 *  null = ignore (own post / system post / empty). */
export function parseMattermostPost(post: any, selfUserId: string): { msg: InboundMsg; imageFileIds: string[] } | null {
  if (!post?.channel_id || !post?.user_id) return null;
  if (post.user_id === selfUserId) return null; // ignore our own posts
  if (post.type) return null; // system post (join/leave/etc.) — type "" is a normal user post
  const fileIds = Array.isArray(post.file_ids) ? post.file_ids.map((f: any) => String(f)) : [];
  // file_ids alone don't tell us the mime; the caller resolves per-file. Here we surface them all and let the
  // download step filter to images. To stay pure we pass them through as candidate image ids.
  const imageFileIds = fileIds;
  const text = String(post.message ?? "");
  if (!text && !imageFileIds.length) return null;
  return {
    msg: {
      chatId: String(post.channel_id),
      userId: String(post.user_id),
      userName: String(post.user_id), // enriched by start() from the event's sender_name when available
      text: text || "[图片]",
    },
    imageFileIds,
  };
}

export function mattermostAdapter(serverUrl: string, token: string): ChatAdapter {
  const base = normalizeBase(serverUrl);
  const api = `${base}/api/v4`;
  const auth = { Authorization: `Bearer ${token}` };
  return {
    name: "mattermost",
    async send(chatId, text) {
      for (const part of chunkText(text || "(empty)", 4000)) {
        await fetch(`${api}/posts`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ channel_id: chatId, message: part }),
        }).catch(() => {});
      }
    },
    async sendFile(chatId, filePath) {
      // upload the file (multipart) → get a file_id, then create a post referencing it
      const form = new FormData();
      form.append("channel_id", String(chatId));
      form.append("files", new Blob([readFileSync(filePath)]), basename(filePath));
      const up = await fetch(`${api}/files`, { method: "POST", headers: auth, body: form }).catch(() => null);
      if (!up || !up.ok) return;
      const j = (await up.json().catch(() => null)) as { file_infos?: { id?: string }[] } | null;
      const fileId = j?.file_infos?.[0]?.id;
      if (!fileId) return;
      await fetch(`${api}/posts`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ channel_id: chatId, message: "", file_ids: [fileId] }),
      }).catch(() => {});
    },
    async start(onMessage, signal) {
      if (!WSImpl) {
        console.error("hara gateway: Mattermost needs Node ≥ 22 (global WebSocket). Upgrade Node.");
        return;
      }
      while (!signal.aborted) {
        await connectOnce(base, token, onMessage, signal);
        if (!signal.aborted) await sleep(3000, signal); // reconnect backoff
      }
    },
  };
}

/** One WS connection: send authentication_challenge, then dispatch "posted" events. Resolves on close/abort;
 *  the caller reconnects. v1 keeps it simple — fresh auth each time, no resume. The bot's own user id is
 *  resolved via GET /users/me so we can drop our own echoes. */
function connectOnce(base: string, token: string, onMessage: (m: InboundMsg) => Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WSImpl(wsUrlFromBase(base));
    let seq = 1;
    let selfId = "";
    const stop = (): void => {
      signal.removeEventListener("abort", stop);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
    ws.addEventListener("close", () => {
      signal.removeEventListener("abort", stop);
      resolve();
    });
    ws.addEventListener("error", () => {});
    ws.addEventListener("open", async () => {
      // resolve our own user id first so parseMattermostPost can ignore our echoes
      try {
        const me = await fetch(`${base}/api/v4/users/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (me.ok) selfId = String((((await me.json()) as any)?.id) ?? "");
      } catch {
        /* best-effort; without it we just won't filter our own posts */
      }
      try {
        ws.send(JSON.stringify({ seq: seq++, action: "authentication_challenge", data: { token } }));
      } catch {
        /* socket gone */
      }
    });
    ws.addEventListener("message", async (ev: any) => {
      let p: any;
      try {
        p = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (p.event !== "posted") return;
      let post: any;
      try {
        post = JSON.parse(String(p.data?.post ?? ""));
      } catch {
        return;
      }
      const parsed = parseMattermostPost(post, selfId);
      if (!parsed) return;
      // enrich the display name from the event payload when the server includes it
      const senderName = String(p.data?.sender_name ?? "").replace(/^@/, "");
      if (senderName) parsed.msg.userName = senderName;
      for (const fid of parsed.imageFileIds) {
        // resolve the file's mime/name, then download only images so the agent can SEE them
        let name = "image";
        let mime = "";
        try {
          const info = await fetch(`${base}/api/v4/files/${encodeURIComponent(fid)}/info`, { headers: { Authorization: `Bearer ${token}` } });
          if (info.ok) {
            const ij = (await info.json()) as { name?: string; mime_type?: string };
            name = String(ij?.name ?? name);
            mime = String(ij?.mime_type ?? "");
          }
        } catch {
          /* fall back to extension sniff below */
        }
        if (!isImage(name, mime)) continue;
        const path = await downloadMattermostFile(base, token, fid, name);
        if (path) (parsed.msg.images ??= []).push(path);
      }
      await onMessage(parsed.msg).catch(() => {});
    });
  });
}
