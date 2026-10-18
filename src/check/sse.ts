/**
 * A text/event-stream parser that takes chunks as they arrive. Streamable
 * HTTP servers may answer a POST with an SSE stream instead of JSON, and a
 * chunk can end anywhere, even between the \r and \n of one line ending, so
 * this follows the HTML standard's line rules rather than splitting on "\n".
 */

export interface SseEvent {
  /** The event type; "message" when the stream didn't name one. */
  event: string;
  /** The event's data lines, joined with "\n". */
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private hasData = false;
  private eventType = "";
  private lastId: string | undefined;

  /** Feeds decoded text in and returns the events it completed. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      // A trailing \r may be the first half of \r\n, so it waits for the next chunk to say.
      if (c === "\r" && i === this.buffer.length - 1) break;
      const line = this.buffer.slice(start, i);
      if (c === "\r" && this.buffer[i + 1] === "\n") i++;
      start = i + 1;
      const event = this.line(line);
      if (event) events.push(event);
    }
    this.buffer = this.buffer.slice(start);
    return events;
  }

  /**
   * Ends the stream. The standard drops an event the stream ends in the middle
   * of, but a server that forgets the final blank line still meant to send its
   * answer, and judging its JSON-RPC is this check's job, not judging its framing.
   */
  end(): SseEvent[] {
    const events = this.buffer ? this.push("\n") : [];
    const last = this.line("");
    return last ? [...events, last] : events;
  }

  private line(line: string): SseEvent | undefined {
    if (line === "") {
      if (!this.hasData) {
        this.eventType = "";
        return undefined;
      }
      const event: SseEvent = { event: this.eventType || "message", data: this.dataLines.join("\n") };
      if (this.lastId !== undefined) event.id = this.lastId;
      this.dataLines = [];
      this.hasData = false;
      this.eventType = "";
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      this.dataLines.push(value);
      this.hasData = true;
    } else if (field === "event") {
      this.eventType = value;
    } else if (field === "id" && !value.includes("\0")) {
      this.lastId = value;
    }
    return undefined;
  }
}
