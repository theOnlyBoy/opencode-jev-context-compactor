# AGENTS.md — opencode-jev-context-compactor

Onboarding for a fresh session (human or agent) on this repo. Read `README.md` for the user story and
`CHANGELOG.md` for what changed. This file is the source of truth for how to work **here**.

## What this is

Jev-scored **context compression** for **OpenCode v2**. Jev (a small judgment model) decides; our code
acts. Two levers:

- **`context` hook (default) — request pruning, non-destructive.** Prunes the **outgoing request only**:
  stale tool calls/results, plus — on a manual `/compress` — older prose messages Jev judges unnecessary.
  Stored history is never touched. Runs **only when forced**: a manual `/compress` / `compress` tool call,
  or when the request reaches `autoAtPercent` of `contextLimitTokens`.
- **`compaction` hook — stats checkpoint.** When Jev actually compresses during OpenCode's own
  compaction, hand v2 a stats summary; otherwise v2's own continuation summary stands.

Triggers: a model-callable **`compress` tool** (`ctx.tool.transform`) and the TUI **`/compress`** command.

## File map

| file | role |
|---|---|
| `index.ts` | adapter/setup: config, logging, stats records; the `context` hook (prune → prose → visible stats + manual compaction trigger); the `compaction` hook; registers the `compress` tool |
| `mapper.ts` | v2 `Message[]` ⇄ engine shape: `toLibraryMessages`, `applyDecisionsToV2`, `renderSummary` |
| `policy.ts` | deletion policy: only deterministic evidence may delete; a model answer may only truncate |
| `facts.ts` | `factsFirst` reference detection + `wrapAsker` |
| `prose.ts` | `proseDrops` + `positionBar` — pure, unit-tested |
| `tui.tsx` | sidebar list, `/compress` command, toasts (entry via package `./tui`) |
| `vendor/fast-jev-compaction/` | the engine (byte-identical, MIT) |
| `test/` | `policy · mapper · facts · cache · prose · manual · config` suites (`npm test`) |
| `examples/` | `run.mjs`, `bench.mjs`, 6 synthetic `scenarios/` |

## Voice

- Reader is capable and busy. **Result first.** Short. No essays.
- Human verbs: install / check / why did it fail.
- **Honesty over smoothness:** never write "works" unless verified against a running v2 service.
- British understatement welcome; hype is not.

## Hard rules

1. **OpenCode v2 only.** Uses `ctx.session.hook("context" | "compaction")`. Do not pretend it runs on v1.
2. **Never import `@opencode/plugin` at runtime** — it isn't installed in the config dir and the import
   kills the plugin. Type-only at most. Runtime shape is a plain object:
   `export default { id, async setup(ctx) { … } }`.
3. **Config precedence: explicit `options` > env > defaults.** Keep it that way.
4. **Fail open.** Missing key, API error, malformed answer, sub-threshold reduction → leave v2 untouched.
   Never throw into the host.
5. **No secrets** in code, logs, docs, or chat. `TYPESAFE_API_KEY` is read from the environment only.
6. **Don't edit the vendored engine**; changes belong in our adapter. `vendor/` stays byte-identical.
7. **Manual `/compress` must actually cut.** It uses `judgement` (no reference pinning) and
   `preserveRecentMessages: 0`; auto keeps the defaults.

## The v2 plugin API (proven on 2.0.21 / 2.0.22)

The shipped `.d.ts` is **incomplete** — the runtime has more than the types. Verified:

- `ctx` domains: `app options session tool shell command event storage mcp model provider integration
  permission plugin reference rpc skill vcs websearch worktree …`.
- Hooks are async: `ctx.session.hook("context" | "compaction", cb)`, `ctx.tool.hook("execute.before" |
  "execute.after", cb)`, `ctx.shell.hook("create.before", cb)`. Callbacks receive **one mutable event**
  (not input/output). `ctx.session.hook("compaction")` → set `input.result = { summary }`.
- **Custom tools** — `ctx.tool.transform((editor) => editor.add({ name, description, input, execute }))`.
  `input` **must be a plain JSON Schema object**; a function (e.g. `() => ({…})`) is **silently rejected**
  and the tool never surfaces. `execute(input, tool)` returns `{ content }`. `editor` also has
  `namespace / list / get / update / remove`.
- **`ctx.session` (in-process) is NOT the SDK shape.** It takes a **flat** `{ sessionID, text }` for
  `prompt` / `synthetic`, and `{ sessionID }` for `compact`. Passing `noReply` / `ignored` is **ignored** —
  it always creates a real model turn. So there is **no silent injected chat message**.
- **The TUI plugin client cannot resolve session ids** — `ctx.client.session.prompt/compact` return
  `InvalidRequestError: Invalid session ID` for every shape. Trigger compaction **server-side**
  (`ctx.session.compact`) instead.
- **TUI**: sidebar slot via `ctx.ui.slot("sidebar.content")`; its render receives only `{ sessionID }`
  (no theme prop). Theme is `ctx.theme` — **structured**, e.g. `ctx.theme.text.muted`, an RGBA wrapper
  `{ buffer: { 0:r, 1:g, 2:b, 3:a } }` (**no `theme.current`**). Keymap layers must be created **inside a
  slot render** (`ctx.keymap.layer(...)` throws elsewhere). Toasts: `ctx.ui.toast.show({…})`.
- Messages are `{ id, role, content: Part[], metadata }`; parts: `text`, `reasoning`,
  `tool-call {id,name,input}`, `tool-result {id,name,result}`. Calls and results are **separate messages**,
  paired by `id`.
- Plugin loading is **per-location** and **async**: `active` ≠ firing — always do one functional test.

## How to work

```sh
npm install
npm run build          # tsc → dist/ (the published artifact)
npm test               # 7 suites: policy · mapper · facts · cache · prose · manual · config
npm run demo           # offline, deterministic
npm run demo:live      # real Jev (needs TYPESAFE_API_KEY)
node examples/bench.mjs --mock   # 6-topic bench, free
```

- **Reload the running plugin:** `/Volumes/Work/opencode-v1-to-v2-migration/bin/v2ctl restart`.
- **Logs:** `$TMPDIR/opencode-jev-context-compactor.log` (server) and `…-tui.log` (TUI). Stats:
  `~/.local/share-v2/opencode/jev-context-compactor/stats.jsonl`; the `/compress` flag lives at
  `dirname(STATS)/force`.
- **Verify against a running v2:** `opencode-v2 api GET /api/plugin` and a real `/compress`.

## Publishing

- Bump `package.json` + `CHANGELOG.md`. `npm pack --dry-run` must show only `dist/` (+ docs + the vendored
  `LICENSE`). `prepublishOnly` runs build + test.
- Repo: `github.com/theOnlyBoy/opencode-jev-context-compactor`. **Ask before publishing or pushing.**

## Related

- Migration project (context): `/Volumes/Work/opencode-v1-to-v2-migration`.
- Template for future plugins: `/Volumes/Work/opencode-plugin-template`.
