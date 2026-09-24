# WeChat Agent scenes

Hara exposes two intentionally separate WeChat paths.

## Owner private-chat remote control

The official iLink connector is for the QR-linked owner's direct chat with Hara. Messages enter the
normal task engine and remain subject to the configured Computer Use and approval policy. It is not a
WeChat group observer, and its reply token must come from a fresh owner message.

## Local WeChat group Agent

The macOS Desktop scene attaches one selected Hara Agent to the group currently visible in the local
WeChat app:

1. In Desktop settings, choose an Agent and a reply mode, then save the scene.
2. Prepare the built-in Jev OCR runtime once.
3. Explicitly request macOS Screen Recording and Accessibility permissions.
4. Open the target group in WeChat, click **Attach current group**, and explicitly confirm that the
   visible conversation is the intended group.
5. In **Assist** mode, click **Ask Agent to draft** when a reply is wanted.
6. Review the draft, click **Fill into WeChat**, then send it manually in WeChat.

**Managed** mode is a separate, explicit lane. Enabling it in settings does not arm sending by itself.
The user must attach the visible group and accept a second managed-send confirmation. Hara treats the
message already visible at attachment time as a baseline and can act only on later incoming messages.
The recommended trigger is an explicit group wake name chosen by the user, such as `@小南`. This is the
name group members actually mention, not the WeChat group title: Hara discovers and binds the visible group
title separately as the safety boundary. Leaving the wake name empty falls back to `@Hara` and the selected
Agent's aliases. Replying to every new incoming message is an additional opt-in.

The scene is deliberately fail-closed:

- screenshots are never returned to Desktop or retained. Window pixels stay in memory when macOS permits;
  an off-Space window may require a `0700` one-shot temporary capture, which is deleted before recognition
  returns;
- one saved Agent and one explicitly confirmed visible group are bound at a time; changing the Agent
  requires saving before another attachment can start;
- in Assist mode, visible group text reaches the selected model only after **Ask Agent to draft**; in an
  armed Managed attachment, only a new message matching the saved trigger starts an automatic draft;
- group text is untrusted data and the drafting turn receives no tools;
- Assist mode never auto-sends. Managed mode never synthesizes Return or uses the clipboard. Before it can
  arm, a read-only preflight must verify an empty readable input route inside the exact bound window. It
  prefers an Accessibility editor and can fall back to Jev's guarded visual writer when a newer WeChat build
  hides that editor. Because WeChat may leave its Send control disabled until text exists, Hara resolves that
  control after the draft is verified, using either the window-scoped Accessibility button or one unambiguous
  OCR-verified Send label inside the input panel;
- Managed mode enforces a ten-second minimum interval, at most six sends in ten minutes, per-observation
  deduplication, and a bounded local audit containing hashes/status only—not message or draft text;
- provider, recognition, window, input, or delivery uncertainty pauses Managed mode. A human must use
  **Confirm and resume Managed mode** (or detach and attach) and confirm the group again to resume it;
- changing the visible conversation or its observed digest invalidates an existing draft;
- OCR confidence is diagnostic only and is excluded from that observed digest, so harmless confidence
  jitter cannot masquerade as a group switch;
- if the visual fallback writes a draft but cannot verify the pixels, Hara consumes that one-shot draft and
  asks the user to inspect WeChat instead of allowing a duplicate retry;
- immediately before pressing Send, Hara rechecks both the bound title and stable observation digest. After
  the one allowed press it verifies either a matching outgoing bubble or a cleared input, and never retries an
  uncertain delivery. Desktop exposes whether the latest new message was ignored for a missing wake mention,
  is being processed, was sent, or caused a paused stage-specific failure;
- scans and drafts are memory-only, bounded, and expire after five minutes;
- background status checks never request macOS permissions; only the explicit permission button does.

The embedded Jev subset and its upstream revision are recorded in `THIRD_PARTY_NOTICES.md`.
