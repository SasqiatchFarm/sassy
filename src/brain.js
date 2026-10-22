// Sassy's brain: one Claude conversation per phone call.
// Speech comes in as text from Twilio, Claude's words stream back out to be spoken.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, runTool } from "./tools.js";

const client = new Anthropic({ apiKey: config.anthropicApiKey });

export class CallBrain {
  constructor({ callSid, from, to, officeHours }) {
    this.callSid = callSid;
    this.from = from;
    this.to = to;
    this.officeHours = officeHours;
    this.messages = [];
    this.transcript = [];
    this.system = buildSystemPrompt({ officeHours, from });
    this.handoff = null;
    this.summary = null;
    this.heldSite = null;
    this.abort = null;
  }

  // Called when the caller starts talking over Sassy.
  interrupt(spokenSoFar) {
    if (this.abort) this.abort.abort();
    this.interruptedAt = spokenSoFar || "";
  }

  // The API needs user and assistant turns to alternate. Make sure the record is well formed
  // before every request, whatever interruptions did to it.
  tidy() {
    const out = [];
    for (const m of this.messages) {
      const prev = out[out.length - 1];
      if (prev && prev.role === m.role) {
        // Two turns in a row from the same side: merge them into one.
        const a = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: String(prev.content) }];
        const b = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content) }];
        prev.content = a.concat(b);
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    if (out.length && out[0].role !== "user") out.shift();
    this.messages = out;
  }

  // userText -> streams reply chunks via onToken(text, isLast). Resolves when the turn is done.
  async respond(userText, onToken) {
    // If a reply is still being produced, stop it first; the caller has moved on.
    if (this.busy) {
      this.interrupt(this.interruptedAt);
      await new Promise((r) => setTimeout(r, 50));
    }
    this.busy = true;
    try {
      return await this._respond(userText, onToken);
    } finally {
      this.busy = false;
    }
  }

  async _respond(userText, onToken) {
    this.transcript.push({ who: "caller", text: userText });
    this.messages.push({ role: "user", content: userText });
    this.tidy();

    for (let round = 0; round < 6; round++) {
      this.abort = new AbortController();
      let spoken = "";
      let toolUses = [];
      let stopReason = null;
      let assistantBlocks = [];

      try {
        const stream = client.messages.stream(
          {
            model: config.model,
            max_tokens: 900,
            system: this.system,
            messages: this.messages,
            tools: toolDefinitions,
          },
          { signal: this.abort.signal },
        );

        stream.on("text", (delta) => {
          spoken += delta;
          onToken(delta, false);
        });

        const final = await stream.finalMessage();
        stopReason = final.stop_reason;
        assistantBlocks = final.content;
        toolUses = final.content.filter((b) => b.type === "tool_use");
      } catch (err) {
        if (err?.name === "AbortError" || this.abort.signal.aborted) {
          const heard = (this.interruptedAt || spoken || "").trim();
          if (heard) this.messages.push({ role: "assistant", content: heard + " [caller interrupted]" });
          this.interruptedAt = "";
          return { interrupted: true };
        }
        console.error("claude error", err?.message || err);
        onToken(" I'm sorry, I had trouble hearing that. Could you say it again?", true);
        this.messages.push({ role: "assistant", content: "I'm sorry, I had trouble hearing that. Could you say it again?" });
        return { error: true };
      }

      if (spoken.trim()) this.transcript.push({ who: "sassy", text: spoken.trim() });

      // Keep only what matters for the record: spoken text and tool calls. Thinking blocks are
      // tied to the exact conversation they came from and break the next request once an
      // interruption has edited the history, so they are never stored.
      const kept = assistantBlocks.filter((b) => b.type === "text" || b.type === "tool_use");

      if (stopReason !== "tool_use" || toolUses.length === 0) {
        this.messages.push({ role: "assistant", content: kept.length ? kept : spoken || "..." });
        onToken("", true);
        return { done: true };
      }

      // Claude wants to use tools. Keep the assistant turn (text + tool_use blocks), run them, feed results back.
      this.messages.push({ role: "assistant", content: kept });
      const results = [];
      for (const tu of toolUses) {
        let out;
        try {
          out = await runTool(tu.name, tu.input || {}, this);
        } catch (err) {
          console.error("tool failed", tu.name, err);
          out = JSON.stringify({ error: "that didn't work; tell the caller you'll have someone follow up" });
        }
        console.log(`[${this.callSid}] tool ${tu.name}`, JSON.stringify(tu.input), "->", out.slice(0, 200));
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      this.messages.push({ role: "user", content: results });

      // Transfer or hangup: finish speaking after this round, then hand off.
      if (this.handoff) {
        // Let Claude say its last line (the loop continues one more round for the goodbye).
      }
      // Loop continues: Claude now speaks based on the tool results.
    }
    onToken("", true);
    return { done: true };
  }

  transcriptText() {
    return this.transcript.map((t) => `${t.who === "sassy" ? "Sassy" : "Caller"}: ${t.text}`).join("\n");
  }
}
