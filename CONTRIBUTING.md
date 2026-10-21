# Contributing

Thanks for helping. Issues and pull requests are welcome: bugs, servers it gets wrong, rules that read Amazon's documentation differently than you do, and features.

## Setup

Node 22 or later and pnpm 9.

```bash
pnpm install
pnpm check      # build, typecheck and every unit test
pnpm test:e2e   # the page in a browser (see the README's Development section)
```

`pnpm example` starts a small MCP server with a screen to try changes against, and `node dist/server/cli.js <url>` runs your build.

## Rules

A readiness rule has to check something Amazon has published. Quote the requirement exactly in [docs/alexa-requirements.md](docs/alexa-requirements.md), with a link, and cite that quote in the rule's `source`; a test holds every quote to the doc. If Amazon's wording is ambiguous, say how the rule reads it in its notes, and prefer WARN to FAIL. Don't invent requirements: a good practice that isn't published belongs in the docs, not in a rule.

## Pull requests

- Keep each one to one change, with tests that fail without it.
- `pnpm check` must pass, and `pnpm test:e2e` for anything that touches the page.
- Write the way the code already reads: plain names, comments that say why, user-facing text in plain words.
- Update the README or docs when behavior changes, and add a line to CHANGELOG.md.
- After adding, removing or upgrading a dependency that ends up in `dist`, run `pnpm notices` to rewrite THIRD-PARTY-NOTICES.md.

## Reporting a bug

Say what you ran, what you expected and what happened. A readiness report (`check --out report.json`) or the Traffic tab's request and response for the exchange that went wrong helps a lot. Leave out tokens and anything private.
