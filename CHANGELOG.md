# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/).

## [0.1.0-beta.2] - 2026-10-05

- Root `index.js` entry (points at `dist/index.js`); source moved under `src/`.

## [0.1.0-beta.1] - 2026-10-04

**Beta.** Jev-scored context compression for OpenCode v2. Behaviour and configuration may change
between `0.1.x` releases; support is best-effort with no SLA.

Jev (a small judgment model) decides what is still worth keeping; the plugin does the trimming. Your
stored conversation is never rewritten behind your back — only the request that goes to the model is
slimmed.

### What you get

- **Smaller context, lower cost.** Stale tool calls are dropped and bulky tool results trimmed. It only
  runs when you ask (`/compress`), when the model decides to, or when the context approaches its limit —
  never on every turn.
- **Jev judges, you stay in control.** Four modes; the default keeps anything an answer still references,
  with no model call at all.
- **Compress prose, not just tools.** `/compress` also asks Jev which older messages are no longer
  needed and drops them.
- **The model can tidy up by itself.** A `compress` tool lets the agent compress when it sees the context
  getting large.
- **See what happened.** A `▣ Jev Context Compactor | …` line in chat with a bar showing where it cut,
  a per-session list in the sidebar, and toasts.
- **No surprises.** If Jev can't help — no key, an error, or simply nothing worth cutting — OpenCode
  behaves exactly as before.

### Notes

- Needs `TYPESAFE_API_KEY` (bring your own key). Without it, the plugin does nothing.
