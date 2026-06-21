// Schedule parsing + matching for `hara cron` — the pure, testable core (no I/O, no Date.now()).
// Three forms, mirroring openclaw/hermes: a 5-field cron expr, a fixed interval ("every 30m"), and a
// one-shot ("in 2h" or an ISO timestamp). Cron matching is hand-rolled (no dependency) at minute
// granularity in LOCAL time — same mental model as a real crontab.

export type Schedule =
  | { kind: "cron"; expr: string }
  | { kind: "every"; everyMs: number; display: string }
  | { kind: "once"; runAt: number; display: string };

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "45s" | "30m" | "2h" | "1d" → milliseconds, or null. */
export function durationToMs(s: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2]];
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
function parseField(f: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of f.split(",")) {
    const [rangeRaw, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo: number;
    let hi: number;
    if (rangeRaw === "*") {
      lo = min;
      hi = max;
    } else if (rangeRaw.includes("-")) {
      const [a, b] = rangeRaw.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = hi = Number(rangeRaw);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
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

/** Does `expr` fire at the given local minute? Uses the Vixie day-of-month/day-of-week OR rule. */
export function cronMatches(expr: string, d: Date): boolean {
  const p = parseCron(expr);
  if (!p) return false;
  if (!p.m.has(d.getMinutes()) || !p.h.has(d.getHours()) || !p.mon.has(d.getMonth() + 1)) return false;
  const domOk = p.dom.has(d.getDate());
  const dowOk = p.dow.has(d.getDay());
  if (p.domStar && p.dowStar) return true; // both unrestricted → any day
  if (!p.domStar && !p.dowStar) return domOk || dowOk; // both restricted → OR
  return p.domStar ? dowOk : domOk; // one restricted → that one
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
    return { kind: "once", runAt: nowMs + ms, display: `once, in ${m[1].replace(/\s+/g, "")}` };
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s)) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return { error: `bad timestamp: ${s}` };
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
  lastRunAt?: number;
}

/** Is this job due to run at `nowMs`? Cron jobs fire once per matching minute (deduped via lastRunAt);
 *  intervals fire when `everyMs` has elapsed since the last run; one-shots fire once when their time passes. */
export function isDue(job: JobTiming, nowMs: number): boolean {
  const s = job.schedule;
  if (s.kind === "cron") {
    if (!cronMatches(s.expr, new Date(nowMs))) return false;
    return job.lastRunAt === undefined || Math.floor(job.lastRunAt / 60_000) < Math.floor(nowMs / 60_000);
  }
  if (s.kind === "every") return nowMs >= (job.lastRunAt ?? job.createdAt) + s.everyMs;
  return job.lastRunAt === undefined && nowMs >= s.runAt; // once
}

/** Next fire time at/after `fromMs` (for display). Cron scans minute-by-minute up to a year; null if none
 *  (e.g. a one-shot already past). */
export function nextRun(job: JobTiming, fromMs: number): number | null {
  const s = job.schedule;
  if (s.kind === "every") return (job.lastRunAt ?? job.createdAt) + s.everyMs;
  if (s.kind === "once") return job.lastRunAt === undefined ? s.runAt : null;
  const p = parseCron(s.expr);
  if (!p) return null;
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000; // next minute boundary
  for (let t = start, i = 0; i < 366 * 24 * 60; t += 60_000, i++) {
    if (cronMatches(s.expr, new Date(t))) return t;
  }
  return null;
}
