// Incoming texts. Twilio posts every text sent to one of our numbers here.
//  - Farm numbers (515-2184, 919-9852): into the booking site's Team page (which also emails the
//    owners) and a copy to Julie's cell.
//  - Event Carpet number (225-238-6303): a copy to Julie's cell, and email to the carpet inbox.
// Nothing is auto-replied; a person answers from the Farm Phone page (coming) or by calling back.
import twilio from "twilio";
import { config } from "./config.js";
import { booking } from "./booking.js";
import { sendText, sendEmail } from "./alerts.js";

const digits = (n) => String(n || "").replace(/\D/g, "");
const isCarpet = (to) => !!config.carpet.number && digits(to).endsWith(digits(config.carpet.number));
const pretty = (n) => { const d = digits(n).slice(-10); return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : n; };

export async function handleIncomingText(body) {
  const from = body.From || "";
  const to = body.To || "";
  const text = (body.Body || "").trim();
  const media = Number(body.NumMedia || 0);
  const content = text || (media ? `(picture/attachment, ${media})` : "(empty)");
  const stamp = new Date().toLocaleString("en-US", { timeZone: config.timezone, hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });

  if (isCarpet(to)) {
    const note = `Text to Event Carpet line (${pretty(to)}) ${stamp}\nFrom ${pretty(from)}:\n${content}`;
    await Promise.all([
      config.julieCell ? sendText(config.julieCell, note, config.carpet.fromNumber) : null,
      sendEmail(config.carpet.email, `Text from ${pretty(from)}`, note, "Max at USA Event Carpet"),
    ]);
    console.log(`text to carpet line from ${from}: ${content.slice(0, 80)}`);
    return;
  }

  const note = `Text to ${pretty(to)} ${stamp}\nFrom ${pretty(from)}:\n${content}`;
  await Promise.all([
    booking.inboxMessage({ callerName: `Text from ${pretty(from)}`, callerPhone: from, message: `(texted to ${pretty(to)}) ${content}` }),
    config.julieCell ? sendText(config.julieCell, note) : null,
  ]);
  console.log(`text to farm line ${to} from ${from}: ${content.slice(0, 80)}`);
}

// Twilio expects TwiML back; an empty response means "no auto-reply".
export const emptyTwiml = () => new twilio.twiml.MessagingResponse().toString();
