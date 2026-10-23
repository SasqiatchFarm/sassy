// What Max can do on a USA Event Carpet call: take a message, text the website link,
// transfer to Julie or Greg during office hours, hang up.
import { sendText, sendEmail } from "./alerts.js";
import { config } from "./config.js";

export const carpetTools = [
  {
    name: "take_message",
    description: "Pass the caller's request to the USA Event Carpet team by text and email. Use once you have their name, number, event date, event location and what they need. Mark rush=true if they need it fast.",
    input_schema: {
      type: "object",
      properties: {
        business: { type: "string", enum: ["carpet", "cci"], description: "Which sister company the call is for: USA Event Carpet or CCI Events" },
        caller_name: { type: "string" },
        caller_phone: { type: "string", description: "Default the caller's number" },
        company: { type: "string", description: "The caller's own company, if they mentioned one" },
        event_date: { type: "string", description: "When the event is, as they said it" },
        event_location: { type: "string", description: "City and venue, as they said it" },
        need: { type: "string", description: "What they need: product, size/area, anything else, in a sentence or two" },
        rush: { type: "boolean", description: "True if they need it this week or said urgent/right away" },
      },
      required: ["business", "caller_name", "need"],
    },
  },
  {
    name: "send_link",
    description: "Text the caller a website link: USA Event Carpet (colors, products) or CCI Events (past work, services).",
    input_schema: {
      type: "object",
      properties: {
        which: { type: "string", enum: ["carpet", "cci"] },
        phone: { type: "string", description: "Default the caller's number" },
      },
      required: ["which"],
    },
  },
  {
    name: "transfer_to_person",
    description: "Ring the owner's cell and connect the caller if she presses 1. Only during office hours, and only after you have the caller's name and reason (never for sales calls).",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "One line: who is calling and why, read to her before she accepts" },
      },
      required: ["reason"],
    },
  },
  {
    name: "read_website",
    description: "Look something up live on one of our websites (CCI Events or USA Event Carpet). Give a page name or path like 'services', 'work', 'interiors', 'about', 'resources', 'brochure', 'contact', 'carpet', 'glitter-carpet', 'event-fencing', or a search word. Returns the page text to answer from. Say a short bridge line before using it.",
    input_schema: {
      type: "object",
      properties: {
        site: { type: "string", enum: ["cci", "carpet"] },
        page: { type: "string", description: "Page name, path, or a word to look for" },
      },
      required: ["site", "page"],
    },
  },
  {
    name: "end_call",
    description: "Hang up politely after the closing line.",
    input_schema: { type: "object", properties: { summary: { type: "string", description: "One line: who called, what they wanted" } }, required: ["summary"] },
  },
];

const say = (obj) => JSON.stringify(obj);

export async function runCarpetTool(name, input, call) {
  const phone = (p) => (p && p.trim()) || call.from;
  switch (name) {
    case "take_message": {
      call.messages_taken = (call.messages_taken || 0) + 1;
      if (call.messages_taken > 2) return say({ delivered: false, note: "Already passed along twice on this call. Don't send more; tell the caller it's all been noted." });
      const stamp = new Date().toLocaleString("en-US", { timeZone: config.carpet.timezone, hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
      const cci = input.business === "cci";
      const lines = [
        `${input.rush ? "RUSH - " : ""}${cci ? "CCI Events" : "Event Carpet"} message ${stamp}`,
        `${input.caller_name}${input.company ? ` (${input.company})` : ""} ${phone(input.caller_phone)}`,
        input.event_date ? `When: ${input.event_date}` : null,
        input.event_location ? `Where: ${input.event_location}` : null,
        `Need: ${input.need}`,
      ].filter(Boolean);
      const text = lines.join("\n");
      const results = await Promise.all([
        config.julieCell ? sendText(config.julieCell, text, config.carpet.fromNumber) : { ok: false },
        sendEmail(cci ? config.carpet.cciEmail : config.carpet.email, `${input.rush ? "RUSH: " : ""}Phone message from ${input.caller_name}`, text + (cci ? "\n\n- Rafi" : "\n\n- Max"), cci ? "Rafi at CCI Events" : "Max at USA Event Carpet"),
      ]);
      call.summary = `${input.caller_name}: ${input.need}`;
      return say({ delivered: results.some((r) => r.ok), texted: results[0].ok, emailed: results[1].ok });
    }
    case "send_link": {
      const to = phone(input.phone);
      const body = input.which === "cci"
        ? `CCI Events: our work, services and contact page are here. ${config.carpet.cciWebsite}\nQuestions? Call ${config.carpet.number}.`
        : `USA Event Carpet: colors, photos and product details are here. ${config.carpet.website}\nQuestions? Call ${config.carpet.number}.`;
      const t = await sendText(to, body, config.carpet.fromNumber);
      return say({ sent: t.ok, to, error: t.error });
    }
    case "transfer_to_person": {
      if (!call.officeHours) return say({ transferring: false, note: "The office is closed. Take a message instead." });
      if (!config.carpet.transferCells.length) return say({ transferring: false, note: "No transfer numbers are set up. Take a message instead." });
      call.handoff = { action: "transfer", who: "julie", reason: input.reason || "" };
      return say({ transferring: true, say_first: "Sure, hold on a minute, I'll get her." });
    }
    case "read_website": {
      const r = await readWebsite(input.site, input.page || "");
      return say(r);
    }
    case "end_call": {
      if (call.handoff?.action === "transfer") return say({ ending: false, note: "A transfer is already in progress. Do nothing else; do not say goodbye." });
      call.handoff = { action: "hangup", summary: input.summary };
      call.summary = input.summary;
      return say({ ending: true });
    }
    default:
      return say({ error: `unknown tool ${name}` });
  }
}

// --- Live website lookup -------------------------------------------------------
// Pulls a page from ccievents.com or usaeventcarpet.com, strips it to plain text, and
// returns the part that matches what the caller asked about. Cached for an hour.
const SITE_PAGES = {
  cci: ["", "services", "work", "interiors", "about", "resources", "brochure", "contact"],
  carpet: ["", "carpet", "exposition-carpet", "colorful-recyclable", "glitter-carpet", "recycled-event-carpet", "artificial-turf-grass", "event-turf", "vinyl-plank", "rolled-vinyl", "gym-floor-cover-tiles", "event-fencing", "accessories", "contact"],
};
const pageCache = new Map();
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|br|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
async function fetchPage(site, page) {
  const base = site === "cci" ? config.carpet.cciWebsite : config.carpet.website;
  const url = site === "cci" ? `${base}/${page}${page ? "/" : ""}` : `${base}/${page ? page + ".html" : ""}`;
  const key = url;
  const hit = pageCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.text;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "SassyReceptionist/1.0" } });
    if (!res.ok) return null;
    const text = htmlToText(await res.text()).slice(0, 12000);
    pageCache.set(key, { at: Date.now(), text });
    return text;
  } catch { return null; } finally { clearTimeout(timer); }
}
export async function readWebsite(site, query) {
  const q = String(query || "").toLowerCase().trim().replace(/^\/+|\/+$/g, "").replace(/\.html$/, "");
  const pages = SITE_PAGES[site] || SITE_PAGES.cci;
  // 1) exact page name
  let page = pages.find((p) => p === q) ?? pages.find((p) => p && (p.includes(q) || q.includes(p)));
  if (page !== undefined) {
    const text = await fetchPage(site, page);
    if (text) return { page: page || "home", text: text.slice(0, 3500) };
  }
  // 2) search across the main pages for the word
  const words = q.split(/\s+/).filter((w) => w.length > 2);
  const found = [];
  for (const p of pages) {
    const text = await fetchPage(site, p);
    if (!text) continue;
    const lower = text.toLowerCase();
    const idx = words.map((w) => lower.indexOf(w)).find((i) => i >= 0);
    if (idx !== undefined && idx >= 0) found.push({ page: p || "home", snippet: text.slice(Math.max(0, idx - 300), idx + 900) });
    if (found.length >= 2) break;
  }
  if (found.length) return { matches: found };
  return { note: "Nothing on the site matched that. Answer from what you know, or take a message so the team follows up." };
}
