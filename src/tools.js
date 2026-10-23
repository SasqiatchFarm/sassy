// What Sassy can do during a call. Each tool has a description Claude reads
// and a handler that does the work. Handlers get the live call (caller number etc).
import { booking } from "./booking.js";
import { sendText, alertTeam } from "./alerts.js";
import { logBookingIssue } from "./digest.js";
import { config } from "./config.js";

export const toolDefinitions = [
  {
    name: "check_availability",
    description: "Check which sites, cabins or the Solaire are open for given dates. After hours, returns only the sites left open for tonight when the stay starts today.",
    input_schema: {
      type: "object",
      properties: {
        check_in: { type: "string", description: "YYYY-MM-DD" },
        check_out: { type: "string", description: "YYYY-MM-DD" },
        unit_type: { type: "string", enum: ["rv", "tent", "cabin", "solaire", "any"], description: "What the caller wants" },
        rv_length_ft: { type: "number", description: "RV length in feet, if an RV" },
      },
      required: ["check_in", "check_out", "unit_type"],
    },
  },
  {
    name: "quote_stay",
    description: "Get the live price for a specific unit and dates, with taxes, extra-guest and pet fees, and the 20% deposit due today. Use before quoting any total.",
    input_schema: {
      type: "object",
      properties: {
        unit_id: { type: "string", description: "The unit id returned by check_availability" },
        check_in: { type: "string" },
        check_out: { type: "string" },
        adults: { type: "integer" },
        children: { type: "integer", description: "Under 12" },
        pets: { type: "integer" },
      },
      required: ["unit_id", "check_in", "check_out", "adults"],
    },
  },
  {
    name: "hold_site",
    description: "Hold a unit for about thirty minutes under the caller's name while they pay. Do this only after the caller said yes to the quoted price.",
    input_schema: {
      type: "object",
      properties: {
        unit_id: { type: "string" },
        check_in: { type: "string" },
        check_out: { type: "string" },
        guest_name: { type: "string" },
        guest_phone: { type: "string", description: "Cell for the payment text; default the caller's number" },
        adults: { type: "integer" },
        children: { type: "integer" },
        pets: { type: "integer" },
        notes: { type: "string", description: "Anything the guest asked for" },
      },
      required: ["unit_id", "check_in", "check_out", "guest_name", "adults"],
    },
  },
  {
    name: "send_payment_link",
    description: "Text the caller the secure link to pay the deposit for a held unit. Needs the hold_id from hold_site.",
    input_schema: {
      type: "object",
      properties: {
        hold_id: { type: "string" },
        guest_phone: { type: "string" },
      },
      required: ["hold_id"],
    },
  },
  {
    name: "lookup_reservation",
    description: "Find an existing reservation by the guest's last name or phone number.",
    input_schema: {
      type: "object",
      properties: {
        last_name: { type: "string" },
        phone: { type: "string" },
      },
    },
  },
  {
    name: "resend_arrival_info",
    description: "Text the guest their arrival information again (directions, map, gate code if they're paid). Only after lookup_reservation found them.",
    input_schema: {
      type: "object",
      properties: { reservation_id: { type: "string" } },
      required: ["reservation_id"],
    },
  },
  {
    name: "send_link",
    description: "Text the caller a link: the booking site, or Mountain Mobile Massage.",
    input_schema: {
      type: "object",
      properties: {
        which: { type: "string", enum: ["booking", "massage"] },
        phone: { type: "string", description: "Default the caller's number" },
      },
      required: ["which"],
    },
  },
  {
    name: "take_message",
    description: "Take a message for the team. Goes to Julie by text, the booking site inbox, and the farm email.",
    input_schema: {
      type: "object",
      properties: {
        caller_name: { type: "string" },
        caller_phone: { type: "string" },
        message: { type: "string", description: "What they want, in a sentence or two" },
      },
      required: ["caller_name", "message"],
    },
  },
  {
    name: "log_booking_issue",
    description: "Something about a booking that the office needs to handle in the morning: date changes, cancellations, refunds or discounts, monthly stays, special requests, group bookings, callbacks. Goes in the morning email.",
    input_schema: {
      type: "object",
      properties: {
        caller_name: { type: "string" },
        caller_phone: { type: "string" },
        topic: { type: "string", description: "e.g. cancellation, date change, monthly stay, special request" },
        details: { type: "string" },
        sassy_told: { type: "string", description: "What you told the caller to expect" },
      },
      required: ["caller_name", "topic", "details"],
    },
  },
  {
    name: "alert_team",
    description: "Emergency or problem in the park, or a complaint. Texts Julie, Will and Scott and posts to Slack immediately. Use the moment you understand what's wrong.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["park_issue", "complaint", "medical"] },
        caller_name: { type: "string" },
        caller_phone: { type: "string" },
        site: { type: "string", description: "Site or cabin, if known" },
        details: { type: "string" },
        sassy_told: { type: "string", description: "What you promised the caller" },
      },
      required: ["kind", "details"],
    },
  },
  {
    name: "transfer_to_desk",
    description: "Transfer the call to the front desk phones. Only during office hours and only when the caller asks for a person or it's something only the desk can do.",
    input_schema: { type: "object", properties: { reason: { type: "string" } } },
  },
  {
    name: "end_call",
    description: "Hang up politely after you've said the closing line.",
    input_schema: { type: "object", properties: { summary: { type: "string", description: "One line: who called, what they wanted, what you did" } }, required: ["summary"] },
  },
];

const say = (obj) => JSON.stringify(obj);

export async function runTool(name, input, call) {
  const phone = (p) => (p && p.trim()) || call.from;
  switch (name) {
    case "check_availability": {
      const r = await booking.availability({ ...input, after_hours: !call.officeHours, call_sid: call.callSid });
      if (!r.ok) return say({ error: "The booking site isn't answering right now. Offer to text the booking link or take a message.", detail: r.error });
      return say(r);
    }
    case "quote_stay": {
      const r = await booking.quote(input);
      if (!r.ok) return say({ error: "Live pricing is down. Give the backup rate as 'about' and offer to text the booking link.", detail: r.error });
      return say(r);
    }
    case "hold_site": {
      const r = await booking.hold({ ...input, guest_phone: phone(input.guest_phone), source: "sassy", call_sid: call.callSid });
      if (!r.ok) return say({ error: "Couldn't place the hold. Text them the booking link instead and log a booking issue so the office follows up.", detail: r.error });
      call.heldSite = r;
      return say(r);
    }
    case "send_payment_link": {
      const r = await booking.payLink({ hold_id: input.hold_id });
      if (!r.ok || !r.url) return say({ error: "Couldn't make the payment link. Text the booking link instead.", detail: r.error });
      const to = phone(input.guest_phone);
      const t = await sendText(to, `Sasquatch Farm: here's your secure link to pay the deposit and finish your booking. Please pay within 30 minutes to keep your site. ${r.url}\nQuestions? Call ${config.twilio.fromNumber}.`);
      return say({ sent: t.ok, to, error: t.error });
    }
    case "lookup_reservation": {
      const r = await booking.lookup({ ...input, phone: input.phone || call.from });
      if (!r.ok) return say({ error: "Can't reach reservations right now. Take a message.", detail: r.error });
      return say(r);
    }
    case "resend_arrival_info": {
      const r = await booking.resendArrival(input);
      if (!r.ok) return say({ error: "Couldn't resend. Take a message so the office sends it.", detail: r.error });
      return say(r);
    }
    case "send_link": {
      const to = phone(input.phone);
      const body = input.which === "massage"
        ? `Sasquatch Farm: here's the link for Mountain Mobile Massage, on-site or right in your RV. ${config.booking.massageLink}`
        : `Sasquatch Farm: book your stay here. ${config.booking.bookingLink}\nQuestions? Call ${config.twilio.fromNumber}.`;
      const t = await sendText(to, body);
      return say({ sent: t.ok, to, error: t.error });
    }
    case "take_message": {
      call.messages_taken = (call.messages_taken || 0) + 1;
      if (call.messages_taken > 2) return say({ delivered: false, note: "Two messages were already taken on this call. Don't take more; tell the caller it's all been passed along." });
      const entry = { callerName: input.caller_name, callerPhone: phone(input.caller_phone), message: input.message };
      const stamp = new Date().toLocaleString("en-US", { timeZone: config.timezone, hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
      const text = `Sassy message ${stamp}\n${entry.callerName} ${entry.callerPhone}\n${entry.message}`;
      const results = await Promise.all([
        config.julieCell ? sendText(config.julieCell, text) : { ok: false },
        booking.inboxMessage({ ...entry, call_sid: call.callSid }),
        (await import("./alerts.js")).sendEmail(config.farmEmail, `Phone message from ${entry.callerName}`, text),
      ]);
      return say({ delivered: results.filter((r) => r.ok).length > 0 });
    }
    case "log_booking_issue": {
      const n = logBookingIssue({ callerName: input.caller_name, callerPhone: phone(input.caller_phone), topic: input.topic, details: input.details, sassyTold: input.sassy_told, callSid: call.callSid });
      return say({ logged: true, in_morning_email: true, count: n });
    }
    case "alert_team": {
      // Hard cap: one alert text per call plus one update, whatever the conversation does.
      call.alerts = call.alerts || 0;
      if (call.alerts >= 2) {
        return say({ texted: 0, note: "The team already has two alerts from this call. Do not send more; tell the caller the team has everything and will be in touch." });
      }
      call.alerts += 1;
      const prefix = call.alerts === 2 ? "UPDATE: " : "";
      const r = await alertTeam({ kind: input.kind, callerName: input.caller_name, callerPhone: phone(input.caller_phone), site: input.site, details: prefix + input.details, sassyTold: input.sassy_told });
      return say({ texted: r.texted.sent, slack: r.slack.ok, alerts_sent_this_call: call.alerts, note: call.alerts === 1 ? "Sent. Only send another if something new and important comes up." : "Update sent. No more alerts this call." });
    }
    case "transfer_to_desk": {
      call.handoff = { action: "transfer", reason: input.reason || "" };
      return say({ transferring: true, say_first: "Sure, one moment while I connect you to the front desk." });
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
