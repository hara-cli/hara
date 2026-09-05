import { rpcNotify } from "./protocol.js";

/** A reconnect only needs the recent control/status tail. Large transcripts and terminal screens already
 * have authoritative snapshot APIs, so this process-local buffer stays strictly bounded. */
export const DEFAULT_EVENT_REPLAY_MAX_EVENTS = 10_000;
export const DEFAULT_EVENT_REPLAY_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_EVENT_REPLAY_PAGE = 1_000;

export interface EventDeliveryCursor {
  streamId: string;
  sequence: number;
}

interface RetainedEvent {
  sequence: number;
  frame: string;
  bytes: number;
}

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
  resetReason?: "stream_changed" | "cursor_expired";
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

/**
 * Process-local ordered delivery log for broadcast notifications.
 *
 * The `streamId` changes on every Serve start. A client may replay only a contiguous tail from the same
 * stream; an old/evicted cursor is rejected with `snapshotRequired` rather than silently skipping state.
 * Every stored frame is the exact live frame, including its original cursor, so replay is deterministic.
 */
export class ServeEventReplayBuffer {
  readonly streamId: string;
  readonly maxEvents: number;
  readonly maxBytes: number;

  #events: RetainedEvent[] = [];
  #retainedBytes = 0;
  #currentSequence = 0;

  constructor(
    streamId: string,
    options: { maxEvents?: number; maxBytes?: number } = {},
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
    this.streamId = normalizedStreamId;
    this.maxEvents = maxEvents;
    this.maxBytes = maxBytes;
  }

  get currentSequence(): number {
    return this.#currentSequence;
  }

  get earliestSequence(): number {
    return this.#events[0]?.sequence ?? this.#currentSequence + 1;
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
    const bytes = Buffer.byteLength(frame, "utf8");

    // One unretainable event breaks continuity. Forget the older prefix as well: returning a later tail
    // without first requiring a fresh snapshot would make a reconnect appear complete when it is not.
    if (bytes > this.maxBytes) {
      this.#events = [];
      this.#retainedBytes = 0;
      return { cursor, frame, retained: false };
    }

    this.#events.push({ sequence, frame, bytes });
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
      throw new Error("event replay cursor is ahead of the current stream");
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
}
