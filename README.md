# Sassy - Sasquatch Farm phone receptionist

Sassy answers the Sasquatch Farm line after hours, and during office hours when the front desk
doesn't pick up in about 5 rings. She talks with callers, quotes live prices, holds a site and
texts a secure pay link, resends arrival info, takes messages, and alerts the team about park issues.

## How a call moves
1. Twilio sends the call to `/voice/incoming`.
2. Office hours: the front desk Yealink rings (25 s). No answer → Sassy picks up.
   After hours: Sassy picks up right away.
3. Sassy's voice link runs over `/ws` (Twilio ConversationRelay: speech in, voice out).
4. When Sassy says goodbye or transfers, Twilio calls `/voice/relay-done`.

## Settings (Render → sassy → Environment)
| Setting | What to type |
|---|---|
| PUBLIC_HOST | The server's address without https://, e.g. `sassy.onrender.com` |
| ANTHROPIC_API_KEY | The "Sassy" key from platform.claude.com (starts with sk-ant-) |
| TWILIO_ACCOUNT_SID | From the Twilio console home page (starts with AC) |
| TWILIO_AUTH_TOKEN | From the same page (click the eye to reveal) |
| TWILIO_FROM_NUMBER | `+14235152184` (the park's texting number) |
| TTS_VOICE | The ElevenLabs voice ID Julie chose |
| TEAM_CELLS | Julie, Will and Scott's cells, comma-separated, like `+14235550001,+14235550002,+14235550003` |
| JULIE_CELL | Julie's cell, `+1...` |
| SLACK_WEBHOOK_URL | The incoming-webhook address for the park-issues Slack channel |
| DIGEST_EMAILS | Who gets the 8:30 AM booking email, comma-separated |
| SMTP_USER / SMTP_PASS | The Gmail address Sassy sends from and its App Password |
| BOOKING_API_KEY | The shared key for the Sassy add-on on book.sasquatchfarm.com |
| SASSY_ALWAYS_ANSWER | `1` while testing on the test number; `0` once live |

Phone numbers are always typed as +1 followed by the 10 digits, no spaces or dashes.

## Checking it's alive
Open `https://<PUBLIC_HOST>/health` in a browser. It shows office-hours status and any settings
still missing.
