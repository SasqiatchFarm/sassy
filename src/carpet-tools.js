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
        caller_name: { type: "string" },
        caller_phone: { type: "string", description: "Default the caller's number" },
        company: { type: "string", description: "If they mentioned one" },
        event_date: { type: "string", description: "When the event is, as they said it" },
        event_location: { type: "string", description: "City and venue, as they said it" },
        need: { type: "string", description: "What they need: product, size/area, anything else, in a sentence or two" },
        rush: { type: "boolean", description: "True if they need it this week or said urgent/right away" },
      },
      required: ["caller_name", "need"],
    },
  },
  {
    name: "send_link",
    description: "Text the caller the USA Event Carpet website link for colors and photos.",
    input_schema: {
      type: "object",
      properties: { phone: { type: "string", description: "Default the caller's number" } },
    },
  },
  {
    name: "transfer_to_person",
    description: "Ring the team's cells and connect the caller to whoever picks up. Only during office hours. who='greg' if the caller asked for Greg; otherwise 'team'.",
    input_schema: {
      type: "object",
      properties: {
        who: { type: "string", enum: ["team", "greg", "julie"] },
        reason: { type: "string", description: "One line on why, read to the person who picks up" },
      },
      required: ["who"],
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
      const lines = [
        `${input.rush ? "RUSH - " : ""}Event Carpet message ${stamp}`,
        `${input.caller_name}${input.company ? ` (${input.company})` : ""} ${phone(input.caller_phone)}`,
        input.event_date ? `When: ${input.event_date}` : null,
        input.event_location ? `Where: ${input.event_location}` : null,
        `Need: ${input.need}`,
      ].filter(Boolean);
      const text = lines.join("\n");
      const results = await Promise.all([
        config.julieCell ? sendText(config.julieCell, text, config.carpet.fromNumber) : { ok: false },
        sendEmail(config.carpet.email, `${input.rush ? "RUSH: " : ""}Phone message from ${input.caller_name}`, text + "\n\n- Max", "Max at USA Event Carpet"),
      ]);
      call.summary = `${input.caller_name}: ${input.need}`;
      return say({ delivered: results.some((r) => r.ok), texted: results[0].ok, emailed: results[1].ok });
    }
    case "send_link": {
      const to = phone(input.phone);
      const t = await sendText(to, `USA Event Carpet: colors, photos and product details are here. ${config.carpet.website}\nQuestions? Call ${config.carpet.number}.`, config.carpet.fromNumber);
      return say({ sent: t.ok, to, error: t.error });
    }
    case "transfer_to_person": {
      if (!call.officeHours) return say({ transferring: false, note: "The office is closed. Take a message instead." });
      if (!config.carpet.transferCells.length) return say({ transferring: false, note: "No transfer numbers are set up. Take a message instead." });
      call.handoff = { action: "transfer", who: input.who || "team", reason: input.reason || "" };
      return say({ transferring: true, say_first: "Sure, let me see if someone's free. One moment." });
    }
    case "end_call": {
      call.handoff = { action: "hangup", summary: input.summary };
      call.summary = input.summary;
      return say({ ending: true });
    }
    default:
      return say({ error: `unknown tool ${name}` });
  }
}
