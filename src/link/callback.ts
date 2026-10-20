import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { clip } from "../check/rpc.ts";
import { LinkError } from "./oauth.ts";

/**
 * Where the browser comes back after sign-in: a one-shot server on
 * 127.0.0.1 that takes the first /callback, checks its state against this
 * sign-in's, and hands over the code (or what went wrong), then closes.
 */

export interface Callback {
  /** http://127.0.0.1:<port>/callback: the redirect URI to register and send. */
  redirectUri: string;
  /** Resolves with the authorization code once the browser comes back; rejects with a LinkError saying what went wrong. */
  wait(timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

type Outcome = { code: string } | { problem: string };

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(response: ServerResponse, status: number, title: string, text: string): void {
  // The text can carry the authorization server's own words, so it's escaped, and the page runs no script at all.
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body style="font: 16px system-ui, sans-serif; margin: 3rem auto; max-width: 36rem; padding: 0 1rem"><h1 style="font-size: 1.25rem">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    connection: "close",
  });
  response.end(html);
}

export function duration(ms: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (ms >= 60_000 && ms % 60_000 === 0) return unit(ms / 60_000, "minute");
  if (ms >= 1000) return unit(Math.round(ms / 1000), "second");
  return `${ms} ms`;
}

function judgeReturn(params: URLSearchParams, state: string): Outcome {
  // State first: until it matches, nothing else on the request can be trusted to be this sign-in's.
  if (params.get("state") !== state) {
    return {
      problem: "The sign-in came back with a state that isn't this sign-in's (from an earlier attempt, or a request that didn't start here), so its code wasn't used. Run link again.",
    };
  }
  const error = params.get("error");
  if (error) {
    const description = params.get("error_description");
    return { problem: `The authorization server answered ${clip(error, 60)}${description ? ` (${clip(description, 200)})` : ""}, so nothing was saved.` };
  }
  const code = params.get("code");
  return code ? { code } : { problem: "The sign-in came back without a code, so nothing was saved." };
}

export async function startCallback(port: number, state: string): Promise<Callback> {
  let settle!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => (settle = resolve));
  let answered = false;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", connection: "close" }).end("Not found.");
      return;
    }
    if (answered) {
      page(response, 410, "This sign-in is already over", "Go back to the terminal to see how it went.");
      return;
    }
    answered = true;
    const result = judgeReturn(url.searchParams, state);
    if ("code" in result) page(response, 200, "Signed in", "You can close this tab and go back to the terminal.");
    else page(response, 400, "Sign-in didn't finish", result.problem);
    // Settled once the page is on its way, so closing the server can't cut it off.
    response.on("finish", () => settle(result));
  });

  const actualPort = await listen(server, port);
  return {
    redirectUri: `http://127.0.0.1:${actualPort}/callback`,
    async wait(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<Outcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ problem: `No sign-in came back within ${duration(timeoutMs)}, so nothing was saved. Run link again, and finish signing in within that time.` }),
          timeoutMs,
        );
      });
      try {
        const result = await Promise.race([outcome, timeout]);
        if ("problem" in result) throw new LinkError(result.problem);
        return result.code;
      } finally {
        clearTimeout(timer);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new LinkError(
          error.code === "EADDRINUSE"
            ? `Port ${port} on 127.0.0.1 is in use, so the sign-in can't come back there. Choose another with --callback-port, and register http://127.0.0.1:<that port>/callback as a redirect URI.`
            : `Couldn't listen on 127.0.0.1:${port} for the sign-in to come back: ${error.message}`,
        ),
      );
    });
    server.listen(port, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}
