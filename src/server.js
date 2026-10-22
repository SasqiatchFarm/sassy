// Sassy's phone server.
//  - Twilio sends each incoming call to /voice/incoming
//  - During office hours the front desk rings first (about 5 rings); Sassy picks up if nobody does
//  - After hours Sassy answers right away
//  - /ws is the live speech link (Twilio ConversationRelay) that feeds Sassy's brain
import express from "express";
import { WebSocketServer } from "ws";
import http from "node:http";
import twilio from "twilio";
import { config, missingSettings } from "./config.js";
import { isOfficeHours } from "./hours.js";
import { CallBrain } from "./brain.js";
import { greetingFor } from "./prompt.js";
import { booking } from "./booking.js";
import { scheduleDigest, sendDigest, pendingIssues } from "./digest.js";

const { VoiceResponse } = twilio.twiml;
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const missing = missingSettings();
if (missing.length) console.warn("Missing settings:", missing.join(", "));

// Twilio signs every request; reject anything that isn't really from Twilio.
function twilioOnly(req, res, next) {
  if (!config.twilio.authToken) return next();
  const url = `https://${config.publicHost}${req.originalUrl}`;
  const ok = twilio.validateRequest(config.twilio.authToken, req.headers["x-twilio-signature"] || "", url, req.body || {});
  if (!ok) return res.status(403).send("forbidden");
  next();
}

function sassyTwiml(officeHours = isOfficeHours()) {
  const vr = new VoiceResponse();
  const connect = vr.connect({ action: `https://${config.publicHost}/voice/relay-done` });
  const attrs = {
    url: `wss://${config.publicHost}/ws`,
    welcomeGreeting: greetingFor(officeHours && !config.alwaysAnswer),
    ttsProvider: config.voice.provider,
    language: config.voice.language,
    transcriptionProvider: "Deepgram",
    speechModel: "nova-3-general",
    interruptible: "any",
    dtmfDetection: "true",
  };
  if (config.voice.voiceId) attrs.voice = config.voice.voiceId;
  connect.conversationRelay(attrs);
  return vr.toString();
}

function deskTwiml() {
  const vr = new VoiceResponse();
  const dial = vr.dial({
    timeout: config.twilio.deskRingSeconds,
    action: `https://${config.publicHost}/voice/after-desk`,
    callerId: undefined,
  });
  dial.sip(config.twilio.deskSip);
  return vr.toString();
}

// 1. A call comes in.
app.post("/voice/incoming", twilioOnly, (req, res) => {
  const office = isOfficeHours();
  console.log(`call ${req.body.CallSid} from ${req.body.From}; office ${office ? "open" : "closed"}; always=${config.alwaysAnswer}`);
  res.type("text/xml");
  if (config.alwaysAnswer || !office) return res.send(sassyTwiml());
  return res.send(deskTwiml());
});

// 2. The desk didn't pick up (or was busy) during office hours.
app.post("/voice/after-desk", twilioOnly, (req, res) => {
  const status = req.body.DialCallStatus;
  res.type("text/xml");
  if (status === "completed" || status === "answered") {
    return res.send(new VoiceResponse().toString()); // the desk handled it
  }
  console.log(`desk ${status}; Sassy answering ${req.body.CallSid}`);
  return res.send(sassyTwiml());
});

// 3. Sassy finished (hang up or transfer).
app.post("/voice/relay-done", twilioOnly, (req, res) => {
  let handoff = {};
  try { handoff = JSON.parse(req.body.HandoffData || "{}"); } catch {}
  const vr = new VoiceResponse();
  if (handoff.action === "transfer") {
    const dial = vr.dial({ timeout: config.twilio.deskRingSeconds, action: `https://${config.publicHost}/voice/transfer-done` });
    dial.sip(config.twilio.deskSip);
  } else {
    vr.hangup();
  }
  res.type("text/xml").send(vr.toString());
});

app.post("/voice/transfer-done", twilioOnly, (req, res) => {
  const vr = new VoiceResponse();
  if (req.body.DialCallStatus !== "completed") {
    vr.say("Sorry, nobody could pick up just now. Please call back during office hours, or text us at this number. Goodbye.");
  }
  vr.hangup();
  res.type("text/xml").send(vr.toString());
});

// Health and admin
app.get("/", (_req, res) => res.send("Sassy is up."));
app.get("/health", (_req, res) => res.json({ ok: true, officeHours: isOfficeHours(), missing, pendingIssues: pendingIssues().length }));
app.post("/admin/send-digest", (req, res) => {
  if (req.headers["x-admin-key"] !== process.env.ADMIN_KEY) return res.status(403).end();
  sendDigest().then((r) => res.json(r));
});

// Live speech link
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  let brain = null;
  let speaking = false;

  const sendToken = (token, last) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "text", token, last }));
  };

  const finishCall = async () => {
    if (!brain) return;
    const summary = brain.summary || "Call ended by caller.";
    booking.callSummary({
      call_sid: brain.callSid,
      from: brain.from,
      summary,
      transcript: brain.transcriptText(),
      held: brain.heldSite || null,
    }).catch(() => {});
  };

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case "setup": {
        brain = new CallBrain({ callSid: msg.callSid, from: msg.from, to: msg.to, officeHours: isOfficeHours() });
        console.log(`[${msg.callSid}] Sassy on the line with ${msg.from}`);
        break;
      }
      case "prompt": {
        if (!brain || !msg.last) break; // only act on the finished utterance
        const text = (msg.voicePrompt || "").trim();
        if (!text) break;
        console.log(`[${brain.callSid}] caller: ${text}`);
        speaking = true;
        const result = await brain.respond(text, sendToken);
        speaking = false;
        if (brain.handoff && !result.interrupted) {
          // Give the voice a moment to finish the last sentence before hanging up / transferring.
          const lastWords = brain.transcript.at(-1)?.text || "";
          const waitMs = Math.min(8000, 600 + lastWords.length * 55);
          setTimeout(() => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify(brain.handoff) }));
            }
          }, waitMs);
        }
        break;
      }
      case "interrupt": {
        if (brain && speaking) brain.interrupt(msg.utteranceUntilInterrupt || "");
        break;
      }
      case "dtmf": {
        if (brain && msg.digit === "0") {
          // Pressing 0 is a quiet way to ask for a person.
          brain.messages.push({ role: "user", content: "[caller pressed 0 to ask for a person]" });
          const r = await brain.respond("I'd like to talk to a person please.", sendToken);
          if (brain.handoff) ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify(brain.handoff) }));
        }
        break;
      }
      case "error": {
        console.error(`[${brain?.callSid}] relay error`, msg.description);
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => {
    if (brain) console.log(`[${brain.callSid}] call over`);
    finishCall();
  });
});

server.listen(config.port, () => {
  console.log(`Sassy listening on ${config.port}; public host ${config.publicHost || "(not set)"}`);
  scheduleDigest();
});
