# Using the readiness check in CI

`check` is made for pipelines: it prints a summary, writes the report as JSON (and as a page with screenshots, if you like), and its exit code says whether anything failed.

```bash
npx alexa-plus-simulator check https://your-server.example.com/mcp --out readiness-report.json
```

## Exit codes

| Code | When |
|---|---|
| 0 | READY or CONDITIONAL: no rule failed (warnings don't fail a build) |
| 1 | NOT_READY: a rule failed, or the check couldn't run at all |
| 2 | A usage problem: a flag, URL or file it couldn't use |

To fail on warnings too, read the report: `jq -e '.warnCount == 0' readiness-report.json`.

## GitHub Actions

Start your server in the job, wait for it, check it, and keep the report:

```yaml
name: Alexa+ readiness

on: [push, pull_request]

jobs:
  readiness:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      # Your server, in the background, on a loopback address (plain http is fine there).
      - run: npm start &
      - name: Wait for the server
        run: for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8787/ && break; sleep 1; done
      - name: Check it
        run: >
          npx alexa-plus-simulator check http://127.0.0.1:8787/mcp
          --visual --screenshots readiness-screenshots
          --out readiness-report.json --html readiness.html
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: alexa-readiness
          path: |
            readiness-report.json
            readiness.html
            readiness-screenshots/
```

`--visual` needs a browser: GitHub's Ubuntu, Windows and macOS runners have Chrome, which it finds on its own. Elsewhere, install Chrome or Edge, or run `npx playwright install --with-deps chromium` first.

A server that needs sign-in takes a token from the `MCP_TOKEN` environment variable (a repository secret, say), so it never appears in the command. (`link` signs in through a browser, so it's for your machine, not CI.)

Tools that need arguments are called only when you give sample calls: commit a `calls.json` beside your server and add `--calls calls.json`.

## The report

`--out` writes JSON in this shape (TypeScript types in [`src/shared/contract.ts`](../src/shared/contract.ts)):

```jsonc
{
  "tool": "alexa-plus-simulator",
  "version": "0.1.0",
  "serverUrl": "http://127.0.0.1:8787/mcp",
  "checkedAt": "2026-10-20T05:07:07.000Z",
  "verdict": "READY",          // READY, CONDITIONAL or NOT_READY
  "passCount": 12, "failCount": 0, "warnCount": 0, "skipCount": 8,
  "rules": [
    {
      "id": "DL-04",            // DL data layer, AU sign-in, VR screens, PK package
      "category": "mcp-data",   // mcp-data, auth, visual or package
      "title": "Latency under 500 ms",
      "status": "PASS",         // PASS, WARN, FAIL or SKIP (with the reason in notes)
      "notes": "Median 3 ms, slowest 16 ms (initialize), over 7 round trips.",
      "source": {               // the published requirement this rule checks, quoted exactly
        "title": "Create an MCP Add-on (quickstart)",
        "url": "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart",
        "quote": "Your MCP server must meet a round-trip query response latency of less than 500 ms."
      }
    }
  ],
  "artifacts": [                // with --visual: a screenshot of each screen on each device
    { "kind": "screenshot", "tool": "show_tasks", "uri": "ui://tasks/list", "device": "show-15", "path": "readiness-screenshots/show_tasks-show-15.png" }
  ],
  "disclaimer": "Unofficial. Not affiliated with or endorsed by Amazon. ..."
}
```

Rule ids are stable, so a pipeline can single one out: `jq -e '.rules[] | select(.id == "DL-04") | .status != "FAIL"' readiness-report.json`.
