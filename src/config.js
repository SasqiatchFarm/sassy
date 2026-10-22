// All of Sassy's settings come from the server's environment ("Environment" tab on Render).
// Nothing secret lives in the code.

const env = (name, fallback = "") => (process.env[name] ?? fallback).trim();
const list = (name) => env(name).split(",").map((s) => s.trim()).filter(Boolean);

export const config = {
  port: Number(env("PORT", "3000")),
  publicHost: env("PUBLIC_HOST"), // e.g. sassy.onrender.com (no https://)

  anthropicApiKey: env("ANTHROPIC_API_KEY"),
  model: env("CLAUDE_MODEL", "claude-sonnet-5-5"),

  twilio: {
    accountSid: env("TWILIO_ACCOUNT_SID"),
    authToken: env("TWILIO_AUTH_TOKEN"),
    fromNumber: env("TWILIO_FROM_NUMBER"), // the park's texting number, e.g. +14235152184
    deskSip: env("FRONT_DESK_SIP", "sip:frontdesk@sasquatchfarm.sip.us1.twilio.com"),
    deskRingSeconds: Number(env("DESK_RING_SECONDS", "25")), // ~5 rings
  },

  voice: {
    provider: env("TTS_PROVIDER", "ElevenLabs"),
    voiceId: env("TTS_VOICE", ""), // ElevenLabs voice id picked by Julie
    language: env("TTS_LANGUAGE", "en-US"),
  },

  // Who gets what
  teamCells: list("TEAM_CELLS"), // Julie, Will, Scott  e.g. +1423..., +1423..., +1423...
  julieCell: env("JULIE_CELL"),
  slackWebhook: env("SLACK_WEBHOOK_URL"), // incoming webhook for the park-issues channel
  farmEmail: env("FARM_EMAIL", "stay@sasquatchfarmtn.com"),
  digestEmails: list("DIGEST_EMAILS"), // Julie, Will, front desk
  digestTime: env("DIGEST_TIME", "08:30"), // Central time, HH:MM

  smtp: {
    host: env("SMTP_HOST", "smtp.gmail.com"),
    port: Number(env("SMTP_PORT", "465")),
    user: env("SMTP_USER"),
    pass: env("SMTP_PASS"),
  },

  booking: {
    apiUrl: env("BOOKING_API_URL", "https://book.sasquatchfarm.com/sassy.php?do="),
    apiKey: env("BOOKING_API_KEY"),
    bookingLink: env("BOOKING_LINK", "https://book.sasquatchfarm.com"),
    massageLink: env("MASSAGE_LINK", "https://mountainmobilemassage.com"),
  },

  // Testing switches
  alwaysAnswer: env("SASSY_ALWAYS_ANSWER", "0") === "1", // 1 = Sassy picks up every call (test number)
  timezone: "America/Chicago",
};

export function missingSettings() {
  const need = {
    ANTHROPIC_API_KEY: config.anthropicApiKey,
    PUBLIC_HOST: config.publicHost,
    TWILIO_ACCOUNT_SID: config.twilio.accountSid,
    TWILIO_AUTH_TOKEN: config.twilio.authToken,
    TWILIO_FROM_NUMBER: config.twilio.fromNumber,
  };
  return Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
}
