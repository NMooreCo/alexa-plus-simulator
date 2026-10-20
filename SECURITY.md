# Security

## Reporting a problem

Please report vulnerabilities privately through GitHub's private vulnerability reporting (the repository's Security tab, "Report a vulnerability"), not in a public issue. You'll get an answer within a few days.

## How it's built to be safe

- **Local only.** The proxy and the page listen on 127.0.0.1. They refuse requests whose Host isn't localhost (against DNS rebinding) and answer cross-origin requests only from the page's own origin, so another site you visit can't drive the proxy or use its token.
- **Your credentials stay put.** A token you give the CLI goes from the proxy to your server and nowhere else; the page never sees it. Model keys stay in the CLI's process (or, hosted, on your server). Tokens from `link` are saved with owner-only permissions where the system supports it.
- **Your server only.** The proxy talks only to the server you named: `https://`, or `http://` on your own machine. It doesn't follow redirects to plain `http://` elsewhere.
- **Screens are contained.** Each screen runs in a sandboxed frame with an opaque origin, under a Content Security Policy built from what its resource declares, so a screen can't reach the page, its cookies or the network beyond what it declared.
- **The check changes nothing it wasn't told to.** It calls only tools marked read-only that need no arguments, a made-up tool name to see how errors come back, and calls you list yourself.

Treat the readiness check like any client of your server: point it at servers you're allowed to test.
