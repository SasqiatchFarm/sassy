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
import { CallBrain, FARM_LINE } from "./brain.js";
import { greetingFor } from "./prompt.js";
import { buildCarpetPrompt, carpetGreeting, carpetOpen } from "./carpet-prompt.js";
import { carpetTools, runCarpetTool } from "./carpet-tools.js";
import { booking } from "./booking.js";
import { scheduleDigest, sendDigest, pendingIssues } from "./digest.js";
import { handleIncomingText, emptyTwiml } from "./sms.js";
import { sendEmail } from "./alerts.js";

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

// Which personality answers: the Event Carpet number gets Max, everything else gets Sassy.
const CARPET_LINE = { name: "Max", buildPrompt: buildCarpetPrompt, tools: carpetTools, runTool: runCarpetTool };
const isCarpetNumber = (to) => !!config.carpet.number && String(to || "").replace(/\D/g, "").endsWith(config.carpet.number.replace(/\D/g, ""));

// Connect the caller to the live speech link. `flags` ride along in the WebSocket URL so the
// brain knows which line it is and whether a transfer just failed.
function relayTwiml({ greeting, voiceId, flags = {}, extraVoices = [] }) {
  const vr = new VoiceResponse();
  const connect = vr.connect({ action: `https://${config.publicHost}/voice/relay-done` });
  const qs = new URLSearchParams(flags).toString();
  const attrs = {
    url: `wss://${config.publicHost}/ws${qs ? "?" + qs : ""}`,
    welcomeGreeting: greeting,
    ttsProvider: config.voice.provider,
    language: config.voice.language,
    transcriptionProvider: "Deepgram",
    speechModel: "nova-3-general",
    interruptible: "any",
    dtmfDetection: "true",
  };
  if (voiceId) attrs.voice = voiceId;
  const relay = connect.conversationRelay(attrs);
  // A second "language" is how the line carries a second voice: same English, different speaker.
  // The brain switches with a {type:"language"} message mid-call (Rafi hands off to Max).
  for (const v of extraVoices) {
    const lang = { code: v.code, ttsProvider: config.voice.provider, transcriptionProvider: "Deepgram", speechModel: v.speechModel || "nova-3-general" };
    if (v.voiceId) lang.voice = v.voiceId;
    relay.language(lang);
  }
  return vr.toString();
}

export const MAX_LANGUAGE_CODE = "en-GB"; // label only; it's still English, just the second voice (Rafi)

function sassyTwiml(officeHours = isOfficeHours()) {
  return relayTwiml({
    greeting: greetingFor(officeHours && !config.alwaysAnswer),
    voiceId: config.voice.voiceId,
    extraVoices: [{ code: "es-US", voiceId: config.voice.voiceId, speechModel: "nova-2-general" }], // Sassy speaks Spanish too
  });
}

function maxTwiml(transferFailed = false) {
  return relayTwiml({
    greeting: carpetGreeting(carpetOpen(), transferFailed),
    // Max answers (MAX_TTS_VOICE); Rafi's voice (CARPET_TTS_VOICE) sits in the en-GB slot for the handoff.
    voiceId: config.carpet.maxVoiceId || config.carpet.voiceId || config.voice.voiceId,
    flags: { line: "carpet", ...(transferFailed ? { transferFailed: String(transferFailed) } : {}) },
    extraVoices: [
      ...(config.carpet.voiceId ? [{ code: MAX_LANGUAGE_CODE, voiceId: config.carpet.voiceId }] : []),
      // Spanish: same voice (the ElevenLabs voices are bilingual), Spanish listening.
      { code: "es-US", voiceId: config.carpet.maxVoiceId || config.carpet.voiceId || config.voice.voiceId, speechModel: "nova-2-general" },
    ],
  });
}

function deskTwiml() {
  const vr = new VoiceResponse();
  const dial = vr.dial({
    timeout: config.twilio.deskRingSeconds,
    action: `https://${config.publicHost}/voice/after-desk`,
    callerId: undefined,
  });
  for (const sip of config.twilio.deskSips) dial.sip(sip); // all desk phones ring at once
  return vr.toString();
}

// 1. A call comes in.
app.post("/voice/incoming", twilioOnly, (req, res) => {
  res.type("text/xml");
  // ?line=carpet on the webhook URL forces Max (handy for test-calling him on another number).
  if (isCarpetNumber(req.body.To) || req.query.line === "carpet") {
    console.log(`carpet call ${req.body.CallSid} from ${req.body.From}; office ${carpetOpen() ? "open" : "closed"}`);
    return res.send(maxTwiml());
  }
  const office = isOfficeHours();
  console.log(`call ${req.body.CallSid} from ${req.body.From}; office ${office ? "open" : "closed"}; always=${config.alwaysAnswer}`);
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
  if (handoff.action === "transfer" && isCarpetNumber(req.body.To)) {
    // Ring the one person they asked for: Julie (first cell) or Greg (second). They press 1 to
    // take it, so a cell's voicemail can't grab the call. Caller ID shows the office line.
    const who = handoff.who === "greg" ? "greg" : "julie";
    const cell = config.carpet.transferCells[who === "greg" ? 1 : 0] || config.carpet.transferCells[0];
    const dial = vr.dial({ timeout: 25, action: `https://${config.publicHost}/voice/carpet-transfer-done?${new URLSearchParams({ who })}`, callerId: config.carpet.number });
    const whisper = `https://${config.publicHost}/voice/whisper?${new URLSearchParams({ reason: handoff.reason || "" })}`;
    if (cell) dial.number({ url: whisper }, cell);
  } else if (handoff.action === "transfer") {
    const dial = vr.dial({ timeout: config.twilio.deskRingSeconds, action: `https://${config.publicHost}/voice/transfer-done` });
    for (const sip of config.twilio.deskSips) dial.sip(sip);
  } else {
    vr.hangup();
  }
  res.type("text/xml").send(vr.toString());
});

// Played to Julie or Greg before the caller is connected. Pressing 1 accepts; anything else
// (including a cell's voicemail) lets the leg drop so Max can take a message instead.
app.post("/voice/whisper", twilioOnly, (req, res) => {
  const vr = new VoiceResponse();
  const g = vr.gather({ numDigits: 1, timeout: 6, action: `https://${config.publicHost}/voice/whisper-accept` });
  g.say(`Call for you from the office line. ${req.query.reason || ""} Press 1 to take it.`);
  vr.hangup();
  res.type("text/xml").send(vr.toString());
});
app.post("/voice/whisper-accept", twilioOnly, (req, res) => {
  const vr = new VoiceResponse();
  if (req.body.Digits !== "1") vr.hangup();
  res.type("text/xml").send(vr.toString()); // empty = connect the call
});

// Nobody took Max's transfer: go back to Max, who takes a message.
app.post("/voice/carpet-transfer-done", twilioOnly, (req, res) => {
  res.type("text/xml");
  const status = req.body.DialCallStatus;
  if (status === "completed" || status === "answered") return res.send(new VoiceResponse().toString());
  console.log(`carpet transfer to ${req.query.who || "julie"} ${status} (leg ${req.body.DialCallSid || "none"}, ${req.body.DialCallDuration || 0}s); taking a message on ${req.body.CallSid}`);
  return res.send(maxTwiml(req.query.who === "greg" ? "greg" : "julie"));
});

app.post("/voice/transfer-done", twilioOnly, (req, res) => {
  const vr = new VoiceResponse();
  if (req.body.DialCallStatus !== "completed") {
    vr.say("Sorry, nobody could pick up just now. Please call back during office hours, or text us at this number. Goodbye.");
  }
  vr.hangup();
  res.type("text/xml").send(vr.toString());
});

// Texts to any of our numbers.
app.post("/sms/incoming", twilioOnly, (req, res) => {
  res.type("text/xml").send(emptyTwiml());
  handleIncomingText(req.body).catch((e) => console.error("text forwarding failed", e));
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

wss.on("connection", (ws, req) => {
  let brain = null;
  let speaking = false;
  const flags = new URL(req.url, "http://x").searchParams;
  const carpet = flags.get("line") === "carpet";

  const sendToken = (token, last) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "text", token, last }));
  };

  const finishCall = async () => {
    if (!brain) return;
    const summary = brain.summary || "Call ended by caller.";
    if (brain.line !== FARM_LINE) {
      // CCI / carpet line: email the whole conversation to the office so nothing is lost.
      const transcript = brain.transcriptText();
      if (!transcript.trim()) return;
      const stamp = new Date().toLocaleString("en-US", { timeZone: config.carpet.timezone, hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
      const who = brain.persona === "rafi" ? "Rafi" : "Max";
      sendEmail(
        config.carpet.cciEmail,
        `Call ${stamp} from ${brain.from || "unknown"}: ${summary.slice(0, 80)}`,
        `Caller: ${brain.from || "unknown"}\nLine: 225-238-6303\nAnswered by: ${who}\nSummary: ${summary}\n\n--- Conversation ---\n${transcript}`,
        `${who} at CCI Events`,
        "cci",
      ).catch(() => {});
      return;
    }
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
        brain = carpet
          ? new CallBrain({ callSid: msg.callSid, from: msg.from, to: msg.to, officeHours: carpetOpen(), line: CARPET_LINE, promptExtra: { transferFailed: !!flags.get("transferFailed") } })
          : new CallBrain({ callSid: msg.callSid, from: msg.from, to: msg.to, officeHours: isOfficeHours() });
        // Lets a tool change the voice mid-call (Rafi -> Max) by sending a control message.
        brain.sendControl = (obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
        console.log(`[${msg.callSid}] ${brain.line.name} on the line with ${msg.from}`);
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
