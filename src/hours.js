// Office hours, Central time. Sassy answers outside these hours,
// and during them only if the desk doesn't pick up.
import { config } from "./config.js";

// 0 = Sunday ... 6 = Saturday. Hours are [open, close) in 24h.
const HOURS = {
  0: [10, 16], // Sun 10-4
  1: [9, 17],  // Mon 9-5
  2: [9, 17],  // Tue
  3: [9, 17],  // Wed
  4: [9, 17],  // Thu
  5: [9, 18],  // Fri 9-6
  6: [10, 18], // Sat 10-6
};

export function centralNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { dayIndex, hour, minute, label: `${get("weekday")} ${get("month")} ${get("day")}, ${get("hour")}:${String(minute).padStart(2, "0")} Central` };
}

export function isOfficeHours(date = new Date()) {
  const { dayIndex, hour, minute } = centralNow(date);
  const [open, close] = HOURS[dayIndex];
  const t = hour + minute / 60;
  return t >= open && t < close;
}

export function officeHoursText() {
  return "Monday through Thursday 9 to 5, Friday 9 to 6, Saturday 10 to 6, and Sunday 10 to 4, Central time";
}

export function nextOpening(date = new Date()) {
  // Plain-language "we open again at ..."
  const { dayIndex, hour, minute } = centralNow(date);
  for (let i = 0; i < 7; i++) {
    const d = (dayIndex + i) % 7;
    const [open] = HOURS[d];
    if (i === 0 && hour + minute / 60 >= open) continue;
    const name = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d];
    const when = i === 0 ? "this morning" : i === 1 ? "tomorrow" : name;
    return `${when} at ${open > 12 ? open - 12 : open} AM`;
  }
  return "tomorrow morning";
}

// --- Generic hours for other lines (Max on the Event Carpet number) ---
export function localNow(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "numeric", minute: "numeric", hour12: false, year: "numeric", month: "short", day: "numeric",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { dayIndex, hour, minute, label: `${get("weekday")} ${get("month")} ${get("day")}, ${get("hour")}:${String(minute).padStart(2, "0")}` };
}

// table: { dayIndex: [open, close] }, days missing = closed
export function withinHours(table, timeZone, date = new Date()) {
  const { dayIndex, hour, minute } = localNow(timeZone, date);
  const span = table[dayIndex];
  if (!span) return false;
  const t = hour + minute / 60;
  return t >= span[0] && t < span[1];
}
