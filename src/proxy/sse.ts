/**
 * Server-Sent Events, both ways: reading an MCP server's event stream as it
 * arrives (to record its messages and to unwrap it for JSON-only callers),
 * and writing the proxy's own `GET /events`.
 */

export interface SseEvent {
  /** The event's type; "message" when the stream didn't name one. */
  event: string;
  data: string;
  /** The last event id the stream set, if any. */
  id?: string;
}

/**
 * Parses a text/event-stream chunk by chunk, following the WHATWG rules that
 * EventSource uses, so an event split across network packets (or a UTF-8
 * character split across chunks) parses exactly as if it arrived whole.
 */
export class SseParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private data: string[] = [];
  private eventType = "";
  private lastId: string | undefined;

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }

  /** The stream is over. An event without its closing blank line is dropped, as EventSource drops it. */
  end(): void {
    this.buffer += this.decoder.decode();
    this.drain(true);
    this.buffer = "";
    this.data = [];
    this.eventType = "";
  }

  private drain(final: boolean): void {
    const terminator = /\r\n|\r|\n/g;
    let start = 0;
    for (let match = terminator.exec(this.buffer); match; match = terminator.exec(this.buffer)) {
      // A lone CR at the very end may be the first half of a CRLF still in flight.
      if (!final && match[0] === "\r" && match.index === this.buffer.length - 1) break;
      this.line(this.buffer.slice(start, match.index));
      start = match.index + match[0].length;
    }
    this.buffer = this.buffer.slice(start);
  }

  private line(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.eventType = value;
    else if (field === "id" && !value.includes("\0")) this.lastId = value;
  }

  private dispatch(): void {
    if (this.data.length) {
      const event: SseEvent = { event: this.eventType || "message", data: this.data.join("\n") };
      if (this.lastId !== undefined) event.id = this.lastId;
      this.onEvent(event);
    }
    this.data = [];
    this.eventType = "";
  }
}

/** One named event for `GET /events`. JSON never contains a raw line break, so the data fits on one `data:` line. */
export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
