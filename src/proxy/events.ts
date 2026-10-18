import type { OutgoingHttpHeaders, ServerResponse } from "node:http";
import type { ProxyEvent } from "../shared/contract.ts";
import { formatSseEvent } from "./sse.ts";

/** Often enough that idle-connection timeouts along the way never fire. */
export const KEEPALIVE_MS = 15_000;
/** A subscriber this far behind has stopped reading (a suspended tab, say); dropping it keeps memory bounded. */
const MAX_BACKLOG_BYTES = 16 * 1024 * 1024;

/**
 * The subscribers to `GET /events`. There's no replay: a subscriber that joins
 * late reads `GET /state` to catch up.
 */
export class EventHub {
  private readonly subscribers = new Set<ServerResponse>();
  private keepalive: ReturnType<typeof setInterval> | undefined;

  subscribe(response: ServerResponse, headers: OutgoingHttpHeaders): void {
    response.writeHead(200, {
      ...headers,
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
    });
    // Headers go out now, so the subscriber knows it's connected before the first event.
    response.flushHeaders();
    this.subscribers.add(response);
    response.on("close", () => this.drop(response));
    if (!this.keepalive) {
      this.keepalive = setInterval(() => this.broadcast(": keepalive\n\n"), KEEPALIVE_MS);
      this.keepalive.unref();
    }
  }

  emit(event: ProxyEvent): void {
    if (this.subscribers.size) this.broadcast(formatSseEvent(event.event, event.data));
  }

  close(): void {
    for (const response of this.subscribers) response.end();
    this.subscribers.clear();
    this.stopKeepalive();
  }

  private broadcast(text: string): void {
    for (const response of this.subscribers) {
      if (response.writableLength > MAX_BACKLOG_BYTES) {
        this.drop(response);
        response.destroy();
      } else {
        response.write(text);
      }
    }
  }

  private drop(response: ServerResponse): void {
    this.subscribers.delete(response);
    if (!this.subscribers.size) this.stopKeepalive();
  }

  private stopKeepalive(): void {
    clearInterval(this.keepalive);
    this.keepalive = undefined;
  }
}
