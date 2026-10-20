import type Anthropic from "@anthropic-ai/sdk";
import type { ModelTurnRequest } from "../shared/contract.ts";

/** How an Alexa+ device talks, for any add-on. The add-on's own instructions come after. */
export const VOICE = `You are the voice of a smart device in someone's home: a simulated Alexa+ on an Amazon Echo, with an add-on (an MCP server) whose tools you can call. What you say is spoken aloud and shown as a caption.

- Speak in plain sentences: no markdown, no bullet points, no emoji, no headings.
- Keep it short, the way Alexa talks: one sentence, two at most, unless they ask for more. A screen carries the detail when there is one.
- Lead with the answer or with what you did. No filler like "Okay" or "Sure", and don't repeat back what they asked.
- Before a tool changes anything (creates, books, buys, sends, deletes or switches something), confirm in one short question first, unless they already asked for exactly that.
- Ask at most one question, and make it the very last thing you say.
- When a tool shows a screen, the screen is already in front of them: say one line about it, not everything on it.
- Lines that start "(On the screen" tell you what someone just did by tapping the display.
- When a tool fails, say plainly what didn't work and offer one next step.
- You help with what the add-on's tools can do. For anything else, say briefly what you can help with.`;

function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * The system prompt: what stays the same all session (cached), then what
 * changes each turn. Every provider gets this text; Anthropic also gets the
 * cache marker, and the others cache the unchanging start on their own.
 */
export function systemBlocks(context: ModelTurnRequest["context"] = {}): Anthropic.Beta.BetaTextBlockParam[] {
  const instructions = clip(context.instructions, 8000).trim();
  const device = clip(context.device, 60).trim();
  return [
    {
      type: "text",
      text: instructions ? `${VOICE}\n\nThe add-on's own instructions:\n${instructions}` : VOICE,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: [
        device ? `This device is an ${device}.` : "",
        context.screen === false
          ? "It has no screen: nothing a tool shows appears here. Say what matters in words (two or three short sentences when a screen would have carried the detail), and never mention a screen, a tab or a tap."
          : "",
        `The time zone is ${clip(context.timeZone, 64) || "unknown"}. It's now ${clip(context.now, 80) || "unknown"}.`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}
