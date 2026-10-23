// Texts, Slack posts and emails. Each one fails quietly and is logged,
// so one broken channel never stops a phone call.
import twilio from "twilio";
import nodemailer from "nodemailer";
import { config } from "./config.js";

let twilioClient = null;
function tw() {
  if (!twilioClient && config.twilio.accountSid && config.twilio.authToken) {
    twilioClient = twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return twilioClient;
}

export async function sendText(to, body, from = config.twilio.fromNumber) {
  const client = tw();
  if (!client || !from) return { ok: false, error: "texting not set up" };
  try {
    const msg = await client.messages.create({ to, from, body });
    return { ok: true, sid: msg.sid };
  } catch (err) {
    console.error("text failed", to, err.message);
    return { ok: false, error: err.message };
  }
}

export async function textTeam(body) {
  const results = await Promise.all(config.teamCells.map((n) => sendText(n, body)));
  return { ok: results.some((r) => r.ok), sent: results.filter((r) => r.ok).length, of: config.teamCells.length };
}

export async function postSlack(text) {
  if (!config.slackWebhook) return { ok: false, error: "Slack not set up" };
  try {
    const res = await fetch(config.slackWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return { ok: res.ok };
  } catch (err) {
    console.error("slack failed", err.message);
    return { ok: false, error: err.message };
  }
}

let mailer = null;
function mail() {
  if (!mailer && config.smtp.user && config.smtp.pass) {
    mailer = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return mailer;
}

export async function sendEmail(to, subject, text, senderName = "Sassy at Sasquatch Farm") {
  const m = mail();
  if (!m) return { ok: false, error: "email not set up" };
  try {
    await m.sendMail({ from: `"${senderName}" <${config.smtp.user}>`, to, subject, text });
    return { ok: true };
  } catch (err) {
    console.error("email failed", err.message);
    return { ok: false, error: err.message };
  }
}

// Park issue: text + Slack to Julie, Will and Scott at the same time.
export async function alertTeam({ kind, callerName, callerPhone, site, details, sassyTold }) {
  const stamp = new Date().toLocaleString("en-US", { timeZone: config.timezone, hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
  const head = kind === "complaint" ? "COMPLAINT" : kind === "medical" ? "MEDICAL EMERGENCY" : "PARK ISSUE";
  const short = `Sassy ${head} ${stamp}\n${callerName || "Unknown caller"} ${callerPhone || ""}${site ? ` - ${site}` : ""}\n${details}\nSassy told them: ${sassyTold || "the team is on it"}`;
  const long = `*Sassy - ${head}* (${stamp})\n*Caller:* ${callerName || "Unknown"} ${callerPhone || ""}\n*Site:* ${site || "not given"}\n*What they reported:* ${details}\n*Sassy told them:* ${sassyTold || "the team is on it"}`;
  const [t, s] = await Promise.all([textTeam(short), postSlack(long)]);
  return { texted: t, slack: s };
}
