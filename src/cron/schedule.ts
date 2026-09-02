// Schedule parsing + matching for `hara cron` — the pure, testable core (no I/O, no Date.now()).
// Three forms, mirroring openclaw/hermes: a 5-field cron expr, a fixed interval ("every 30m"), and a
// one-shot ("in 2h" or an ISO timestamp). Cron matching is hand-rolled (no dependency) at minute
// granularity in LOCAL time — same mental model as a real crontab.

export type Schedule =
  | { kind: "cron"; expr: string }
  | { kind: "every"; everyMs: number; display: string }
  | { kind: "once"; runAt: number; display: string };

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
/** Inclusive editable ISO range. Four-digit years round-trip through both Serve and Desktop controls. */
export const MIN_DATE_TIMESTAMP_MS = -62_167_219_200_000; // 0000-01-01T00:00:00.000Z
export const MAX_DATE_TIMESTAMP_MS = 253_402_300_799_999; // 9999-12-31T23:59:59.999Z

export function validDateTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= MIN_DATE_TIMESTAMP_MS
    && value <= MAX_DATE_TIMESTAMP_MS;
}

/** "45s" | "30m" | "2h" | "1d" → milliseconds, or null. */
export function durationToMs(s: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) return null;
  const milliseconds = Number(m[1]) * UNIT_MS[m[2]];
  return Number.isSafeInteger(milliseconds) && milliseconds <= MAX_DATE_TIMESTAMP_MS
    ? milliseconds
    : null;
}

interface CronFields {
  m: Set<number>;
  h: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domStar: boolean;
  dowStar: boolean;
}

// Parse one cron field — supports `*`, a step `/n`, a single value `a`, a range `a-b`, a list `a,b`,
// and a stepped range `a-b/n` — into the explicit set of matching values.
const isUint = (s: string): boolean => /^\d+$/.test(s); // strict — `Number("")`/`Number(" ")` are 0, so reject non-digits
function parseField(f: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of f.split(",")) {
    if (part === "") return null; // empty list element (e.g. a trailing/leading comma)
    const slash = part.split("/");
    if (slash.length > 2) return null; // more than one step
    const [rangeRaw, stepRaw] = slash;
    if (stepRaw !== undefined && !isUint(stepRaw)) return null; // "5/", "5/x"
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (rangeRaw === "*") {
      lo = min;
      hi = max;
    } else if (rangeRaw.includes("-")) {
      const ab = rangeRaw.split("-");
      if (ab.length !== 2 || !isUint(ab[0]) || !isUint(ab[1])) return null;
      lo = Number(ab[0]);
      hi = Number(ab[1]);
    } else {
      if (!isUint(rangeRaw)) return null;
      lo = Number(rangeRaw);
      hi = stepRaw !== undefined ? max : lo; // Vixie: "N/step" means N..max step (not just {N})
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** Parse a 5-field cron expression (minute hour day-of-month month day-of-week), or null if invalid. */
export function parseCron(expr: string): CronFields | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const m = parseField(f[0], 0, 59);
  const h = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const mon = parseField(f[3], 1, 12);
  const dow = parseField(f[4], 0, 6); // 0 = Sunday
  if (!m || !h || !dom || !mon || !dow) return null;
  return { m, h, dom, mon, dow, domStar: f[2] === "*", dowStar: f[4] === "*" };
}

function sameNumberSet(left: Set<number>, right: Set<number>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function cronDayPredicate(fields: CronFields, dom: number, dow: number): boolean {
  const domOk = fields.dom.has(dom);
  const dowOk = fields.dow.has(dow);
  if (fields.domStar && fields.dowStar) return true;
  if (!fields.domStar && !fields.dowStar) return domOk || dowOk;
  return fields.domStar ? dowOk : domOk;
}

// The largest day-of-month that can exist in each month. February includes 29 because the semantic
// comparison must remain correct in leap years; impossible dates such as February 30/31 must not make
// two schedules look different when they match every real calendar instant.
const MAX_POSSIBLE_DOM_BY_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function sameCronCalendarPredicate(left: CronFields, right: CronFields): boolean {
  // Compare the combined month + Vixie DOM/DOW predicate. A month present only on one side can still be
  // semantically inert (for example February in `31 1,2 *`), so comparing month sets independently would
  // replay an occurrence after a formatting-only edit. Across the Gregorian cycle each real
  // (month, day-of-month) occurs on every weekday, making this truth table exact.
  for (let month = 1; month <= 12; month++) {
    for (let dom = 1; dom <= MAX_POSSIBLE_DOM_BY_MONTH[month]; dom++) {
      for (let dow = 0; dow <= 6; dow++) {
        const leftMatches = left.mon.has(month) && cronDayPredicate(left, dom, dow);
        const rightMatches = right.mon.has(month) && cronDayPredicate(right, dom, dow);
        if (leftMatches !== rightMatches) {
          return false;
        }
      }
    }
  }
  return true;
}

/** Compare the schedule semantics Hara actually executes, rather than the user's formatting. This keeps
 * harmless edits such as `0 9 * * *` → `00 09 * * *` from minting a new schedule occurrence. */
export function cronExpressionsEqual(left: string, right: string): boolean {
  const a = parseCron(left);
  const b = parseCron(right);
  return !!a && !!b
    && sameNumberSet(a.m, b.m)
    && sameNumberSet(a.h, b.h)
    && sameCronCalendarPredicate(a, b);
}

/** Offset (ms) of IANA zone `tz` from UTC at instant `atMs`. Cached per (tz, hour) — offsets only move
 *  at DST transitions, so hour-bucket caching keeps nextRun's minute-by-minute scan fast. */
const offsetCache = new Map<string, number>();
export function zoneOffsetMs(tz: string, atMs: number): number {
  const key = `${tz}:${Math.floor(atMs / 3_600_000)}`;
  const hit = offsetCache.get(key);
  if (hit !== undefined) return hit;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(atMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  const off = asUtc - Math.floor(atMs / 1000) * 1000;
  if (offsetCache.size > 10_000) offsetCache.clear();
  offsetCache.set(key, off);
  return off;
}

/** Is `tz` a valid IANA timezone? (validated at job-add time so a typo fails loudly, not silently-local) */
export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of the instant — in `tz` when given (offset-shifted UTC getters), else local. */
function wallParts(d: Date, tz?: string): { min: number; hour: number; dom: number; mon: number; dow: number } {
  if (!tz) return { min: d.getMinutes(), hour: d.getHours(), dom: d.getDate(), mon: d.getMonth() + 1, dow: d.getDay() };
  const z = new Date(d.getTime() + zoneOffsetMs(tz, d.getTime()));
  return { min: z.getUTCMinutes(), hour: z.getUTCHours(), dom: z.getUTCDate(), mon: z.getUTCMonth() + 1, dow: z.getUTCDay() };
}

function cronFieldsMatch(p: CronFields, d: Date, tz?: string): boolean {
  const w = wallParts(d, tz);
  if (!p.m.has(w.min) || !p.h.has(w.hour) || !p.mon.has(w.mon)) return false;
  const domOk = p.dom.has(w.dom);
  const dowOk = p.dow.has(w.dow);
  if (p.domStar && p.dowStar) return true; // both unrestricted → any day
  if (!p.domStar && !p.dowStar) return domOk || dowOk; // both restricted → OR
  return p.domStar ? dowOk : domOk; // one restricted → that one
}

/** Does `expr` fire at the given minute (in `tz` when set, else local)? Vixie dom/dow OR rule. */
export function cronMatches(expr: string, d: Date, tz?: string): boolean {
  const parsed = parseCron(expr);
  return parsed ? cronFieldsMatch(parsed, d, tz) : false;
}

/** Parse a user schedule string into a Schedule (or an error). `nowMs` anchors relative one-shots. */
export function parseSchedule(input: string, nowMs: number): Schedule | { error: string } {
  const s = input.trim();
  let m = /^every\s+(\d+\s*[smhd])$/i.exec(s);
  if (m) {
    const ms = durationToMs(m[1]);
    if (!ms) return { error: `bad interval: ${m[1]}` };
    return { kind: "every", everyMs: ms, display: `every ${m[1].replace(/\s+/g, "")}` };
  }
  m = /^in\s+(\d+\s*[smhd])$/i.exec(s);
  if (m) {
    const ms = durationToMs(m[1]);
    if (!ms) return { error: `bad delay: ${m[1]}` };
    const runAt = nowMs + ms;
    if (!validDateTimestamp(runAt)) {
      return { error: `delay is outside the supported date range: ${m[1]}` };
    }
    return { kind: "once", runAt, display: `once, in ${m[1].replace(/\s+/g, "")}` };
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return { error: `bad timestamp: ${s}` };
    if (t <= nowMs) return { error: `timestamp is in the past: ${s}` };
    if (!validDateTimestamp(t)) {
      return { error: `timestamp is outside the supported year 0000–9999 range: ${s}` };
    }
    return { kind: "once", runAt: t, display: `once, at ${s}` };
  }
  if (parseCron(s)) return { kind: "cron", expr: s };
  return { error: `unrecognized schedule "${s}" — use a cron expr ("0 9 * * *"), "every 30m", "in 2h", or an ISO timestamp` };
}

export function describeSchedule(sched: Schedule): string {
  return sched.kind === "cron" ? `cron \`${sched.expr}\`` : sched.display;
}

interface JobTiming {
  schedule: Schedule;
  createdAt: number;
  /** Definition change boundary. A run before this instant belongs to the previous schedule and must not
   * suppress the first occurrence of the edited one. */
  scheduleUpdatedAt?: number;
  /** Logical schedule generation. Unlike wall time, this remains ordered across equal timestamps and clock
   * rollback. Legacy jobs omit both revision fields and use scheduleUpdatedAt as a compatibility fallback. */
  scheduleRevision?: number;
  lastRunScheduleRevision?: number;
  lastRunAt?: number;
  /** Explicit one-shot catch-up for a cron job created after this minute's OS tick. */
  pendingDueAt?: number;
  tz?: string;
}

function lastRunBelongsToCurrentSchedule(job: JobTiming): boolean {
  if (job.lastRunAt === undefined) return false;
  if (
    job.scheduleRevision !== undefined
    || job.lastRunScheduleRevision !== undefined
  ) {
    return (job.lastRunScheduleRevision ?? 0) === (job.scheduleRevision ?? 0);
  }
  return job.scheduleUpdatedAt === undefined || job.lastRunAt >= job.scheduleUpdatedAt;
}

/** Is this job due to run at `nowMs`? Cron jobs fire once per matching minute (deduped via lastRunAt);
 *  intervals fire when `everyMs` has elapsed since the last run; one-shots fire once when their time passes. */
export function isDue(job: JobTiming, nowMs: number): boolean {
  const s = job.schedule;
  if (s.kind === "cron") {
    // This marker is persisted only for an enabled job created during a matching minute. It survives the
    // 09:00:00 -> 09:00:37 creation race, but unlike inferring from `createdAt` it can be cleared on disable
    // and therefore cannot make a job execute a months-old occurrence after it is re-enabled.
    if (
      job.pendingDueAt !== undefined
      && job.pendingDueAt <= nowMs
      && (
        !lastRunBelongsToCurrentSchedule(job)
        || job.lastRunAt! < job.pendingDueAt
      )
    ) return true;
    if (cronMatches(s.expr, new Date(nowMs), job.tz)) {
      const lastRunAt = lastRunBelongsToCurrentSchedule(job) ? job.lastRunAt : undefined;
      return lastRunAt === undefined || Math.floor(lastRunAt / 60_000) < Math.floor(nowMs / 60_000);
    }
    return false;
  }
  // interval: fire once per grid slot of width everyMs — a tick landing slightly early still counts the
  // slot (a plain `now >= last+everyMs` deadline loses ~half the fires of `every 1m` at 60s tick granularity).
  if (s.kind === "every") {
    const scheduleAnchor = job.scheduleUpdatedAt ?? job.createdAt;
    const runAnchor = lastRunBelongsToCurrentSchedule(job)
      ? Math.max(scheduleAnchor, job.lastRunAt!)
      : scheduleAnchor;
    return Math.floor(nowMs / s.everyMs) > Math.floor(runAnchor / s.everyMs);
  }
  const completed = lastRunBelongsToCurrentSchedule(job);
  return !completed && nowMs >= s.runAt; // once
}

/** Next actionable fire time at/after `fromMs` (for display). A currently-due cron or overdue persisted
 *  one-shot returns `fromMs` instead of lying with tomorrow/a past timestamp. Cron scans minute-by-minute
 *  up to a year; null means the job has already completed or has no match in the scan window. */
export interface NextRunOptions {
  /** Optional shared wall-clock budget for renderer-facing bulk queries. Core scheduler calls omit it. */
  deadlineMs?: number;
}

export function nextRun(job: JobTiming, fromMs: number, options: NextRunOptions = {}): number | null {
  const s = job.schedule;
  if (s.kind === "every") return (Math.floor(fromMs / s.everyMs) + 1) * s.everyMs; // next grid boundary (always > fromMs)
  if (s.kind === "once") {
    const completed = lastRunBelongsToCurrentSchedule(job);
    if (completed) return null;
    return s.runAt <= fromMs ? fromMs : s.runAt;
  }
  const p = parseCron(s.expr);
  if (!p) return null;
  if (isDue(job, fromMs)) return fromMs;
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000; // next minute boundary
  for (let t = start, i = 0; i < 366 * 24 * 60; t += 60_000, i++) {
    // Inspect the candidate before enforcing the shared UI deadline. A caller can be descheduled after
    // creating a tiny budget; dense schedules must still return their immediately-computable next minute
    // instead of becoming an empty preview solely because the process resumed a few milliseconds late.
    if (cronFieldsMatch(p, new Date(t), job.tz)) return t;
    // A Desktop list can contain thousands of independently valid but extremely sparse schedules. Share
    // one small response budget so an authenticated local query cannot monopolize Serve's event loop. At
    // most one candidate is evaluated after an already-expired deadline, which keeps the bound intact.
    if (
      options.deadlineMs !== undefined
      && (i & 255) === 0
      && Date.now() >= options.deadlineMs
    ) return null;
  }
  return null;
}
