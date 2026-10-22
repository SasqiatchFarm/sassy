// Booking issues collected during the day, emailed once each morning
// to Julie, Will and the front desk. Stored in a small JSON file on the server.
import fs from "node:fs";
import path from "node:path";
import cron from "node-cron";
import { config } from "./config.js";
import { sendEmail } from "./alerts.js";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "booking-issues.json");

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; }
}
function save(items) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(items, null, 2));
}

export function logBookingIssue(entry) {
  const items = load();
  items.push({ ...entry, at: new Date().toISOString() });
  save(items);
  return items.length;
}

export function pendingIssues() {
  return load();
}

function fmt(iso) {
  return new Date(iso).toLocaleString("en-US", { timeZone: config.timezone, weekday: "short", hour: "numeric", minute: "2-digit" });
}

export async function sendDigest() {
  const items = load();
  const to = config.digestEmails.length ? config.digestEmails.join(", ") : config.farmEmail;
  const today = new Date().toLocaleDateString("en-US", { timeZone: config.timezone, weekday: "long", month: "long", day: "numeric" });
  let body;
  if (!items.length) {
    body = `Good morning! No booking items came in overnight. Nothing to follow up on.\n\n- Sassy`;
  } else {
    const lines = items.map((it, i) =>
      `${i + 1}. ${fmt(it.at)} - ${it.callerName || "Unknown"} ${it.callerPhone || ""}\n   ${it.topic ? it.topic + ": " : ""}${it.details}\n   Sassy told them: ${it.sassyTold || "the office will follow up"}`
    );
    body = `Good morning! Here's what came in on the phones that needs the office:\n\n${lines.join("\n\n")}\n\n- Sassy`;
  }
  const res = await sendEmail(to, `Sassy's morning booking notes - ${today}`, body);
  if (res.ok) save([]);
  return { ...res, count: items.length, to };
}

export function scheduleDigest() {
  const [h, m] = config.digestTime.split(":").map(Number);
  cron.schedule(`${m} ${h} * * *`, () => {
    sendDigest().then((r) => console.log("digest", r)).catch((e) => console.error("digest failed", e));
  }, { timezone: config.timezone });
  console.log(`morning digest scheduled for ${config.digestTime} Central`);
}
