import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
  type PrivateStateFileBinding,
} from "../security/private-state.js";
import { redactSensitiveValue } from "../security/secrets.js";
import { rpcNotify } from "./protocol.js";

/** A reconnect only needs the recent control/status tail. Large transcripts and terminal screens already
 * have authoritative snapshot APIs, so both the live buffer and optional restart checkpoint stay bounded. */
export const DEFAULT_EVENT_REPLAY_MAX_EVENTS = 10_000;
export const DEFAULT_EVENT_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_EVENT_REPLAY_PAGE = 1_000;
export const MAX_EVENT_REPLAY_FRAME_BYTES = 4 * 1024 * 1024;

export interface EventDeliveryCursor {
  streamId: string;
  sequence: number;
}

interface RetainedEvent {
  sequence: number;
  frame: string;
  /** Restart-safe copy, credential-redacted before it can reach disk. */
  persistedFrame: string;
  bytes: number;
}

interface PersistedReplayEvent {
  sequence: number;
  frame: string;
}

interface PersistedReplaySnapshot {
  version: 1;
  streamId: string;
  currentSequence: number;
  updatedAt: string;
  events: PersistedReplayEvent[];
}

export interface EventReplayPersistenceOptions {
  /** User home containing Hara's private `.hara/serve` state. */
  home: string;
  /** Tests may isolate several buffers without changing the production filename. */
  filename?: string;
}

const PERSISTED_REPLAY_VERSION = 1 as const;
const DEFAULT_PERSISTED_FILENAME = "event-replay.json";
const CHECKPOINT_EVENT_INTERVAL = 64;
const CHECKPOINT_TIME_INTERVAL_MS = 2_000;

export interface PublishedEvent {
  cursor: EventDeliveryCursor;
  frame: string;
  retained: boolean;
}

export interface EventReplayPage {
  streamId: string;
  currentSequence: number;
  earliestSequence: number;
  snapshotRequired: boolean;
  resetReason?: "stream_changed" | "cursor_expired" | "cursor_ahead";
  frames: string[];
  throughSequence: number;
  hasMore: boolean;
}

export interface EventReplayState {
  streamId: string;
  currentSequence: number;
  earliestSequence: number;
  retainedEvents: number;
  retainedBytes: number;
}

function validStreamId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length >= 1
    && value.length <= 128;
}

function validIso(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 40
    && Number.isFinite(Date.parse(value));
}

function parsePersistedFrame(frame: unknown, streamId: string, sequence: number): string | null {
  if (
    typeof frame !== "string"
    || !frame
    || Buffer.byteLength(frame, "utf8") > MAX_EVENT_REPLAY_FRAME_BYTES
  ) return null;
  try {
    const parsed = JSON.parse(frame) as {
      jsonrpc?: unknown;
      method?: unknown;
      params?: { deliveryCursor?: { streamId?: unknown; sequence?: unknown } };
    };
    return parsed.jsonrpc === "2.0"
      && typeof parsed.method === "string"
      && parsed.method.trim().length > 0
      && parsed.params?.deliveryCursor?.streamId === streamId
      && parsed.params.deliveryCursor.sequence === sequence
      ? frame
      : null;
  } catch {
    return null;
  }
}

function parsePersistedSnapshot(
  text: string,
  maxEvents: number,
  maxBytes: number,
): PersistedReplaySnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<PersistedReplaySnapshot>;
  if (
    snapshot.version !== PERSISTED_REPLAY_VERSION
    || !validStreamId(snapshot.streamId)
    || !Number.isSafeInteger(snapshot.currentSequence)
    || Number(snapshot.currentSequence) < 0
    || !validIso(snapshot.updatedAt)
    || !Array.isArray(snapshot.events)
    || snapshot.events.length > maxEvents
  ) return null;

  const events: PersistedReplayEvent[] = [];
  let retainedBytes = 0;
  let previous = 0;
  for (const candidate of snapshot.events) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const sequence = Number((candidate as PersistedReplayEvent).sequence);
    if (
      !Number.isSafeInteger(sequence)
      || sequence < 1
      || (previous > 0 && sequence !== previous + 1)
    ) return null;
    const frame = parsePersistedFrame(
      (candidate as PersistedReplayEvent).frame,
      snapshot.streamId,
      sequence,
    );
    if (!frame) return null;
    retainedBytes += Buffer.byteLength(frame, "utf8");
    if (retainedBytes > maxBytes) return null;
    events.push({ sequence, frame });
    previous = sequence;
  }
  if (events.length > 0 && events.at(-1)!.sequence !== snapshot.currentSequence) return null;
  return {
    version: PERSISTED_REPLAY_VERSION,
    streamId: snapshot.streamId,
    currentSequence: Number(snapshot.currentSequence),
    updatedAt: snapshot.updatedAt,
    events,
  };
}

/**
 * Ordered delivery log for broadcast notifications.
 *
 * Without persistence, `streamId` changes on every Serve start. Production checkpoints a redacted bounded
 * tail so an orderly Desktop/CLI replacement can retain the same stream. A client may replay only a
 * contiguous tail; any old, missing, or ahead cursor requires an authoritative snapshot.
 */
export class ServeEventReplayBuffer {
  readonly streamId: string;
  readonly maxEvents: number;
  readonly maxBytes: number;

  #events: RetainedEvent[] = [];
  #retainedBytes = 0;
  #currentSequence = 0;
  #durableSequence = 0;
  #lastCheckpointAt = 0;
  readonly #persistence?: {
    home: string;
    binding: PrivateStateFileBinding;
    lockResource: string;
  };

  constructor(
    streamId: string,
    options: {
      maxEvents?: number;
      maxBytes?: number;
      persistence?: EventReplayPersistenceOptions;
    } = {},
  ) {
    const normalizedStreamId = streamId.trim();
    if (!normalizedStreamId || normalizedStreamId.length > 128) {
      throw new Error("event replay streamId must contain 1-128 characters");
    }
    const maxEvents = options.maxEvents ?? DEFAULT_EVENT_REPLAY_MAX_EVENTS;
    const maxBytes = options.maxBytes ?? DEFAULT_EVENT_REPLAY_MAX_BYTES;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
      throw new Error("event replay maxEvents must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("event replay maxBytes must be a positive safe integer");
    }
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
    let restoredStreamId: string | undefined;
    if (options.persistence) {
      const filename = options.persistence.filename ?? DEFAULT_PERSISTED_FILENAME;
      const binding = bindPrivateHaraStateFile(options.persistence.home, ["serve"], filename);
      const lockResource = `event-replay-${filename}`;
      this.#persistence = { home: options.persistence.home, binding, lockResource };
      withPrivateStateLockSync(options.persistence.home, ["serve"], lockResource, () => {
        const current = readPrivateStateFileSnapshotSync(
          binding.path,
          Math.min(64 * 1024 * 1024, Math.max(64 * 1024, maxBytes * 2 + 64 * 1024)),
        );
        if (!current) return;
        const restored = parsePersistedSnapshot(current.text, maxEvents, maxBytes);
        if (!restored) {
          // The cache is rebuildable. Remove only the verified private inode. Unsafe links or paths fail
          // earlier and are never followed, repaired, or replaced here.
          removePrivateStateFile(binding.path, current, binding.directory);
          return;
        }
        restoredStreamId = restored.streamId;
        this.#currentSequence = restored.currentSequence;
        this.#durableSequence = restored.currentSequence;
        this.#lastCheckpointAt = Date.parse(restored.updatedAt);
        this.#events = restored.events.map((event) => ({
          sequence: event.sequence,
          frame: event.frame,
          persistedFrame: event.frame,
          bytes: Buffer.byteLength(event.frame, "utf8"),
        }));
        this.#retainedBytes = this.#events.reduce((total, event) => total + event.bytes, 0);
      });
    }
    this.streamId = restoredStreamId ?? normalizedStreamId;
  }

  get currentSequence(): number {
    return this.#currentSequence;
  }

  get earliestSequence(): number {
    return this.#events[0]?.sequence ?? this.#currentSequence + 1;
  }

  /** Highest sequence known to have crossed the private-state fsync/rename boundary. */
  get durableSequence(): number {
    return this.#durableSequence;
  }

  state(): EventReplayState {
    return {
      streamId: this.streamId,
      currentSequence: this.#currentSequence,
      earliestSequence: this.earliestSequence,
      retainedEvents: this.#events.length,
      retainedBytes: this.#retainedBytes,
    };
  }

  publish(method: string, params: Record<string, unknown>): PublishedEvent {
    if (!method.trim()) throw new Error("event method is required");
    const sequence = this.#currentSequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("event replay sequence exhausted");
    this.#currentSequence = sequence;
    const cursor = { streamId: this.streamId, sequence };
    const frame = rpcNotify(method, { ...params, deliveryCursor: cursor });
    const safeParams = redactSensitiveValue(params).value as Record<string, unknown>;
    const persistedFrame = rpcNotify(method, { ...safeParams, deliveryCursor: cursor });
    const bytes = Buffer.byteLength(frame, "utf8");

    // One unretainable event breaks continuity. Forget the older prefix as well: returning a later tail
    // without first requiring a fresh snapshot would make a reconnect appear complete when it is not.
    if (
      bytes > this.maxBytes
      || Buffer.byteLength(persistedFrame, "utf8") > Math.min(this.maxBytes, MAX_EVENT_REPLAY_FRAME_BYTES)
    ) {
      this.#events = [];
      this.#retainedBytes = 0;
      return { cursor, frame, retained: false };
    }

    this.#events.push({ sequence, frame, persistedFrame, bytes });
    this.#retainedBytes += bytes;
    while (this.#events.length > this.maxEvents || this.#retainedBytes > this.maxBytes) {
      const evicted = this.#events.shift();
      if (!evicted) break;
      this.#retainedBytes -= evicted.bytes;
    }
    return { cursor, frame, retained: true };
  }

  replay(streamId: string, afterSequence: number, limit = 256): EventReplayPage {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("event replay cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_REPLAY_PAGE) {
      throw new Error(`event replay limit must be an integer from 1 to ${MAX_EVENT_REPLAY_PAGE}`);
    }
    const state = this.state();
    if (streamId !== this.streamId) {
      return {
        ...state,
        snapshotRequired: true,
        resetReason: "stream_changed",
        frames: [],
        throughSequence: 0,
        hasMore: false,
      };
    }
    if (afterSequence > this.#currentSequence) {
      return {
        ...state,
        snapshotRequired: true,
        resetReason: "cursor_ahead",
        frames: [],
        throughSequence: afterSequence,
        hasMore: false,
      };
    }
    if (afterSequence < this.earliestSequence - 1) {
      return {
        ...state,
        snapshotRequired: true,
        resetReason: "cursor_expired",
        frames: [],
        throughSequence: afterSequence,
        hasMore: false,
      };
    }

    const selected = this.#events
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit);
    const throughSequence = selected.at(-1)?.sequence ?? afterSequence;
    return {
      ...state,
      snapshotRequired: false,
      frames: selected.map((event) => event.frame),
      throughSequence,
      hasMore: throughSequence < this.#currentSequence,
    };
  }

  /**
   * Persist a bounded, redacted restart checkpoint. Normal ACK traffic is coalesced; shutdown and handoff
   * force the boundary so every retained event is durable before the old writer advertises that it stopped.
   */
  checkpoint(force = false, now = Date.now()): number {
    const persistence = this.#persistence;
    if (!persistence || this.#durableSequence === this.#currentSequence) return this.#durableSequence;
    if (
      !force
      && this.#durableSequence > 0
      && this.#currentSequence - this.#durableSequence < CHECKPOINT_EVENT_INTERVAL
      && now - this.#lastCheckpointAt < CHECKPOINT_TIME_INTERVAL_MS
    ) return this.#durableSequence;

    return withPrivateStateLockSync(persistence.home, ["serve"], persistence.lockResource, () => {
      const current = readPrivateStateFileSnapshotSync(
        persistence.binding.path,
        Math.min(64 * 1024 * 1024, Math.max(64 * 1024, this.maxBytes * 2 + 64 * 1024)),
      );
      if (current) {
        const parsed = parsePersistedSnapshot(current.text, this.maxEvents, this.maxBytes);
        if (!parsed) throw new Error("Hara event replay checkpoint is invalid; restart from snapshots");
        if (parsed.streamId !== this.streamId || parsed.currentSequence > this.#currentSequence) {
          throw new Error("another Hara Serve writer changed the durable event stream");
        }
      }

      let persistedEvents = this.#events.map((event): PersistedReplayEvent => ({
        sequence: event.sequence,
        frame: event.persistedFrame,
      }));
      let text = "";
      for (;;) {
        const snapshot: PersistedReplaySnapshot = {
          version: PERSISTED_REPLAY_VERSION,
          streamId: this.streamId,
          currentSequence: this.#currentSequence,
          updatedAt: new Date(now).toISOString(),
          events: persistedEvents,
        };
        text = JSON.stringify(snapshot) + "\n";
        if (Buffer.byteLength(text, "utf8") <= this.maxBytes || persistedEvents.length === 0) break;
        persistedEvents = persistedEvents.slice(1);
      }
      if (Buffer.byteLength(text, "utf8") > this.maxBytes) {
        throw new Error("Hara event replay checkpoint exceeds its durable byte limit");
      }
      writePrivateStateFileSync(
        persistence.binding,
        text,
        current ? { expectedText: current.text } : { expectedMissing: true },
      );
      this.#durableSequence = this.#currentSequence;
      this.#lastCheckpointAt = now;
      return this.#durableSequence;
    });
  }
}
