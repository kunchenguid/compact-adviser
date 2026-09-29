---
description: Register compact-adviser hooks and print the status-line block
allowed-tools: run_terminal_command
---

Run exactly this command and show the person its output verbatim. Extra words after this slash
command are ignored; do not pass them to the CLI.

```
node "$(node -e 'const l=JSON.parse(require("child_process").execFileSync("grok",["plugin","list","--json"],{encoding:"utf8"})); const p=(Array.isArray(l)?l:[]).find(x=>x&&x.name==="compact-adviser"); if(!p||typeof p.path!=="string") throw new Error("compact-adviser is not installed"); process.stdout.write(p.path)')/bin/adviser.ts" install
```

This is the one-time setup: it registers the hooks in the person's own Grok home and prints
the `[ui.status_line]` block they must paste into the config.toml path it named. Only they can
do that second step; a plugin cannot, and neither can you.

Rules for this command:

- Run that CLI command only. Do not edit files under `${GROK_HOME:-~/.grok}` or any other file
  yourself, and do not guess at a setting the CLI did not report.
- Print what the CLI printed. It never prints an API key, only where the key in effect
  came from, so there is nothing to redact - and nothing to paraphrase either.
- Never pass an API key to the CLI. Save the key from a shell outside this session, or set
  `TYPESAFE_API_KEY` (`AI_GATEWAY_API_KEY` when the judge is Vercel's AI Gateway) or a cwd
  `.env`. Do not type secrets after this slash command; Grok appends extra words to the model.
