# Contributing

Thanks for looking. This project is **beta**: behaviour and config can change between `0.1.x` releases,
and support is **best-effort with no SLA**.

## Before you send code

- **Open an issue first** for anything non-trivial, so we agree on the shape before you build it.
- Keep PRs **small and focused** — one concern per PR.
- `npm test` must be green (seven suites) and `npm run build` must be clean.

## Ground rules

- **OpenCode v2 only.** Uses `ctx.session.hook("context" | "compaction")`.
- **Never import `@opencode/plugin` at runtime** — type-only at most (see `AGENTS.md`).
- **Fail open.** Any error, missing key, or sub-threshold result leaves OpenCode untouched; never throw
  into the host.
- **No secrets** in code, logs, or issues. `TYPESAFE_API_KEY` is read from the environment only.
- **Don't edit `vendor/`.** The vendored engine stays byte-identical; changes belong in the adapter.

`AGENTS.md` has the file map and the proven v2 API notes; `README.md` is the user story.

## Reporting bugs

Use the issue templates and include the plugin version, OpenCode v2 version, and redacted logs
(`$TMPDIR/opencode-jev-context-compactor.log`). Never paste secrets or private conversation content.
