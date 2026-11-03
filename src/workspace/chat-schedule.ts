import { durationToMs, parseCron, validDateTimestamp, validTz, type Schedule } from "../cron/schedule.js";

/** Fifteen minutes limits accidental repeated model spend and leaves time for a previous turn to drain. */
export const MIN_CHAT_REPEAT_MS = 15 * 60_000;
export const MAX_CHAT_SCHEDULES_PER_AGENT = 32;
export const MAX_CHAT_SCHEDULES_PER_WORKSPACE = 256;
const WEEKDAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export interface ChatScheduleTime { schedule: Schedule; tz: string; repeated: boolean }
export function parseChatScheduleTime(input: { delay_seconds?: unknown; fire_at?: unknown; repeat?: unknown; tz?: unknown }, now = Date.now(), hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone): ChatScheduleTime {
  const selected = [input.delay_seconds, input.fire_at, input.repeat].filter(value => value !== undefined);
  if (selected.length !== 1) throw new Error("Choose exactly one schedule time");
  const tz = input.tz === undefined ? hostTz : input.tz;
  if (typeof tz !== "string" || !validTz(tz)) throw new Error("Invalid IANA time zone");
  if (input.delay_seconds !== undefined) {
    const seconds = input.delay_seconds;
    if (!Number.isSafeInteger(seconds) || Number(seconds) < 1 || Number(seconds) > 365 * 86400 || !validDateTimestamp(now + Number(seconds) * 1000)) throw new Error("Invalid delay_seconds");
    return { schedule: { kind: "once", runAt: now + Number(seconds) * 1000, display: `in ${seconds}s` }, tz, repeated: false };
  }
  if (input.fire_at !== undefined) {
    const iso = input.fire_at;
    if (typeof iso !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?Z$/.test(iso)) throw new Error("fire_at must be ISO UTC");
    const at = Date.parse(iso);
    if (!validDateTimestamp(at) || at <= now || new Date(at).toISOString() !== new Date(iso).toISOString()) throw new Error("Invalid fire_at");
    return { schedule: { kind: "once", runAt: at, display: `at ${iso}` }, tz, repeated: false };
  }
  const repeat = input.repeat;
  if (typeof repeat !== "string") throw new Error("Invalid repeat");
  const every = /^every:(\d+)([mhd])$/.exec(repeat);
  if (every) {
    const ms = durationToMs(every[1] + every[2]);
    if (!ms || ms < MIN_CHAT_REPEAT_MS) throw new Error("Repeat interval must be at least 15 minutes");
    return { schedule: { kind: "every", everyMs: ms, display: repeat }, tz, repeated: true };
  }
  const daily = /^daily@(\d\d):(\d\d)$/.exec(repeat);
  const weekly = /^weekly:([a-z,]+)@(\d\d):(\d\d)$/.exec(repeat);
  if (!daily && !weekly) throw new Error("Invalid repeat; use every:Nm/h/d, daily@HH:MM, or weekly:days@HH:MM");
  const hour = Number((daily ?? weekly)![daily ? 1 : 2]), minute = Number((daily ?? weekly)![daily ? 2 : 3]);
  if (hour > 23 || minute > 59) throw new Error("Invalid repeat clock time");
  const days = weekly?.[1].split(",");
  if (days && (!days.length || new Set(days).size !== days.length || days.some(day => WEEKDAYS[day] === undefined))) throw new Error("Invalid repeat weekdays");
  const expr = `${minute} ${hour} * * ${days ? days.map(day => WEEKDAYS[day]).join(",") : "*"}`;
  if (!parseCron(expr)) throw new Error("Invalid repeat cron");
  return { schedule: { kind: "cron", expr }, tz, repeated: true };
}
