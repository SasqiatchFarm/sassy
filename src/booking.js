// Talks to the small Sassy add-on on book.sasquatchfarm.com.
// Every call is a POST with a shared key. If the site is unreachable,
// the tools fall back gracefully so Sassy can still take a message.
import { config } from "./config.js";

async function call(path, body = {}) {
  const url = config.booking.apiUrl + path;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sassy-Key": config.booking.apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` };
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.name === "AbortError" ? "booking site timed out" : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export const booking = {
  availability: (args) => call("availability", args),
  quote: (args) => call("quote", args),
  hold: (args) => call("hold", args),
  payLink: (args) => call("paylink", args),
  lookup: (args) => call("reservation", args),
  resendArrival: (args) => call("resend-arrival", args),
  inboxMessage: (args) => call("message", args),
  callSummary: (args) => call("call-summary", args),
};
