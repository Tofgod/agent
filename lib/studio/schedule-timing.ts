import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { Cron } from "./harness/time/cron";
import { RRule } from "./harness/time/rrule";
import { canonicalizeTimeZone, isFourDigitYearInstant, parseLocalCalendar, parseOffsetInstant, resolveLocalInstant } from "./harness/time/instant";
import { AppError } from "./security";

const clock = z.string().regex(/^\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/);
const zone = z.string().max(128);
const wall = { time: clock, time_zone: zone };
const expression = z.string().trim().max(256);
export const scheduleTiming = z.union([
  z.strictObject({ kind: z.literal("after"), after_seconds: z.number().int().positive().safe() }),
  z.strictObject({ kind: z.literal("at"), at: z.union([z.string(), z.strictObject({ date: z.string(), ...wall })]) }),
  z.strictObject({ kind: z.literal("once"), at: z.string() }),
  z.strictObject({ kind: z.literal("every"), every_seconds: z.number().int().min(60).safe() }),
  z.strictObject({ kind: z.literal("daily"), daily: z.strictObject(wall) }),
  z.strictObject({ kind: z.literal("weekly"), weekly: z.strictObject({ ...wall,
    weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).refine((days) => new Set(days).size === days.length) }) }),
  z.strictObject({ kind: z.literal("rrule"), rrule: z.string().trim().max(1024) }),
  z.strictObject({ kind: z.literal("cron"), cron: z.strictObject({ expression, time_zone: zone }) }),
  z.strictObject({ kind: z.literal("cron"), expression, timeZone: zone }),
]);
export type ScheduleTiming = z.output<typeof scheduleTiming>;
export type Occurrence = { scheduledFor: number; nextAt: number | null };

const invalid = (message: string) => new AppError(message, 400, "SCHEDULE_RULE");
export const oneShot = (timing: ScheduleTiming) => timing.kind === "after" || timing.kind === "at" || timing.kind === "once";
const supportedInstant = (epoch: number) => isFourDigitYearInstant(epoch) ? epoch : null;
const instant = (value?: string) => value === undefined ? null : Date.parse(value);
function timeZone(value: string) {
  const resolved = canonicalizeTimeZone(value);
  if (resolved.kind === "rejected") throw invalid("请输入有效的 IANA 时区");
  return resolved.timeZone;
}
function absolute(value: z.output<typeof scheduleTiming> & { kind: "at" | "once" }) {
  if (typeof value.at === "string") {
    const parsed = parseOffsetInstant(value.at);
    if (parsed.kind === "accepted") return parsed.epoch;
  } else {
    const parsed = parseLocalCalendar(value.at.date, value.at.time);
    const zone = timeZone(value.at.time_zone);
    const epoch = parsed.kind === "accepted" ? resolveLocalInstant(parsed.time, zone) : undefined;
    if (epoch !== undefined) return epoch;
  }
  throw invalid("该时间不存在或格式无效");
}
function wallRule(timing: Extract<ScheduleTiming, { kind: "daily" | "weekly" }>) {
  const selector = timing.kind === "daily" ? timing.daily : timing.weekly;
  const zone = timeZone(selector.time_zone);
  let time: Temporal.PlainTime;
  try { time = Temporal.PlainTime.from(selector.time, { overflow: "reject" }); }
  catch { throw invalid("请输入有效的本地时间"); }
  const weekdays = timing.kind === "weekly" ? new Set(timing.weekly.weekdays) : undefined;
  const dateAt = (epoch: number, atZone = zone) => Temporal.Instant.fromEpochMilliseconds(epoch).toZonedDateTimeISO(atZone).toPlainDate();
  const on = (date: Temporal.PlainDate) => weekdays && !weekdays.has(date.dayOfWeek) ? undefined
    : resolveLocalInstant(date.toPlainDateTime(time), zone);
  const next = (after: number, afterDate?: Temporal.PlainDate) => {
    let date = dateAt(after);
    if (afterDate && Temporal.PlainDate.compare(date, afterDate) <= 0) date = afterDate.add({ days: 1 });
    for (; date.year <= 9999; date = date.add({ days: 1 })) {
      const target = on(date);
      if (target !== undefined && target > after) return supportedInstant(target);
    }
    return null;
  };
  return { next, resolve(saved: number, at: number): Occurrence {
    // Begin in UTC + one day to cover zones that repeat a local date on a date-line change.
    let date = dateAt(at, "UTC").add({ days: 1 });
    for (;; date = date.subtract({ days: 1 })) {
      const target = on(date);
      if (target === undefined || target > at) continue;
      const scheduledFor = Math.max(target, saved);
      return { scheduledFor, nextAt: next(at, dateAt(scheduledFor)) };
    }
  }, canonical: { time: time.toString({ fractionalSecondDigits: 3 }), time_zone: zone } };
}

function recurrence(timing: Extract<ScheduleTiming, { kind: "cron" | "rrule" }>) {
  const parsed = timing.kind === "rrule" ? RRule.parse(timing.rrule) : "cron" in timing
    ? Cron.parse(timing.cron.expression, timing.cron.time_zone) : Cron.parse(timing.expression, timing.timeZone);
  if (parsed.kind === "rejected") throw invalid(parsed.detail);
  return parsed.rule;
}

export function normalizedTiming(timing: ScheduleTiming): unknown {
  if (timing.kind === "once" || timing.kind === "at") return { kind: "at", at: absolute(timing) };
  if (timing.kind === "daily") return { kind: "daily", ...wallRule(timing).canonical };
  if (timing.kind === "weekly") return { kind: "weekly", ...wallRule(timing).canonical, days: [...timing.weekly.weekdays].sort() };
  if (timing.kind === "cron" || timing.kind === "rrule") {
    const rule = recurrence(timing);
    return { kind: timing.kind, expression: rule.expression, ...("timeZone" in rule ? { zone: rule.timeZone } : {}) };
  }
  return timing;
}

export function firstOccurrence(timing: ScheduleTiming, at: number, resuming?: number | null) {
  switch (timing.kind) {
    case "once":
    case "at": {
      const target = absolute(timing);
      return target > at ? target : null;
    }
    case "after": {
      const target = resuming === undefined ? supportedInstant(at + timing.after_seconds * 1000) : resuming;
      return target !== null && target > at ? target : null;
    }
    case "every": {
      const interval = timing.every_seconds * 1000;
      if (resuming !== undefined && resuming !== null) return resuming > at ? resuming : fixedRate(resuming, interval, at).nextAt;
      return supportedInstant(at + interval);
    }
    case "daily":
    case "weekly": return wallRule(timing).next(at);
    default: return instant(recurrence(timing).next(at));
  }
}

function fixedRate(saved: number, interval: number, at: number): Occurrence {
  const scheduledFor = saved + Math.floor((at - saved) / interval) * interval;
  return { scheduledFor, nextAt: supportedInstant(scheduledFor + interval) };
}

export function dueOccurrence(timing: ScheduleTiming, saved: number, at: number): Occurrence {
  if (oneShot(timing)) return { scheduledFor: saved, nextAt: null };
  if (timing.kind === "every") return fixedRate(saved, timing.every_seconds * 1000, at);
  if (timing.kind === "daily" || timing.kind === "weekly") return wallRule(timing).resolve(saved, at);
  if (timing.kind === "cron" || timing.kind === "rrule") {
    const occurrence = recurrence(timing).resolve(new Date(saved).toISOString(), at);
    return { scheduledFor: Date.parse(occurrence.occurrenceAt), nextAt: instant(occurrence.nextScheduledAt) };
  }
  throw invalid("任务时间规则无效");
}
