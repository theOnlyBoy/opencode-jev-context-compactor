/** @jsxImportSource @opentui/solid */
/**
 * tui.tsx — the OpenCode v2 TUI entrypoint (loaded via `<package>/tui`).
 *
 * Sidebar list of compression events + a `/compress` command that forces compression.
 * Preview API (@opencode/plugin/tui + @opentui/core); everything is guarded.
 */
import { createSignal } from "solid-js"
import { appendFileSync, mkdirSync, readFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { dirname, join } from "path"

const STATS =
  process.env.FAST_JEV_STATS_FILE ||
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "jev-context-compactor",
    "stats.jsonl",
  )
const FORCE_FILE = join(dirname(STATS), "force")

const TLOG = join(tmpdir(), "opencode-jev-context-compactor-tui.log")
function tlog(fields: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(TLOG), { recursive: true })
    appendFileSync(TLOG, JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n")
  } catch {
    /* ignore */
  }
}

type Row = {
  ts?: string
  outcome?: string
  reason?: string
  origin?: string
  sessionID?: string
  reduction?: number
  charsBefore?: number
  charsAfter?: number
  ms?: number
  kept?: number
  downgraded?: number
  strategy?: string
}

function read(limit = 80): Row[] {
  try {
    return readFileSync(STATS, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((l) => JSON.parse(l) as Row)
  } catch {
    return []
  }
}

const EXPANDED = 10

const REASON: Record<string, string> = {
  "below-min-reduction": "below min",
  "below-min-result-chars": "small",
  "no-key": "no key",
  "already-in-flight": "busy",
  "empty-summary": "empty",
}

function label(r: Row): string {
  if (r.reduction != null) {
    const removed = Math.max(0, (r.charsBefore ?? 0) - (r.charsAfter ?? 0))
    return `• -${Math.round(r.reduction * 100)}% ${fmtK(removed)}→${fmtK(r.charsAfter ?? 0)}`
  }
  return `• ${REASON[r.reason ?? ""] ?? r.reason ?? "skip"}`
}

function when(r: Row): string {
  return (r.ts ?? "").slice(11, 19) || "--:--:--"
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`
}

/** theme colours may be RGBA objects or strings — normalise to something `<text fg>` accepts */
function color(c: any): string {
  if (!c) return "#8a8a8a"
  if (typeof c === "string") return c
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")
  // opencode theme colours are RGBA wrappers: { buffer: { 0:r, 1:g, 2:b, 3:a } }
  const buf = c.buffer ?? c
  if (buf && typeof buf === "object" && typeof buf[0] === "number") {
    return `#${h(buf[0])}${h(buf[1])}${h(buf[2])}`
  }
  if (typeof c.toHex === "function") return c.toHex()
  if (typeof c.r === "number" && typeof c.g === "number" && typeof c.b === "number") {
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`
  }
  return "#8a8a8a"
}

function tuiSetup(ctx: any): () => void {
  tlog({ event: "tui.setup", keys: Object.keys(ctx ?? {}), stats: STATS })
  const initial = read()
  const [rows, setRows] = createSignal<Row[]>(initial)
  const [expanded, setExpanded] = createSignal(true)
  let lastSeen = initial[initial.length - 1]?.ts ?? ""
  let slotSessionID = ""

  function postReport(r: Row): void {
    const removed = Math.max(0, (r.charsBefore ?? 0) - (r.charsAfter ?? 0))
    const header = `▣ Jev Context Compactor | -${Math.round((r.reduction ?? 0) * 100)}% · -${fmtK(removed)} removed, ${fmtK(r.charsAfter ?? 0)} left`
    const body = [
      header,
      `→ kept ${r.kept ?? 0} calls, truncated ${r.downgraded ?? 0} results`,
      `→ ${r.ms ?? 0}ms · ${r.strategy ?? "?"}`,
    ].join("\n")
    try {
      ctx?.ui?.toast?.show?.({ title: "Jev Context Compactor", message: header, variant: "success", duration: 8000 })
    } catch {
      /* ignore */
    }
    // the persistent chat report is posted from here via the real SDK client (honors noReply+ignored)
    const sid = slotSessionID || r.sessionID || currentSession()
    if (!sid || !sid.startsWith("ses_")) {
      tlog({ event: "tui.report.skip", reason: "no-session" })
      return
    }
    // NOTE: a silent injected chat message is NOT possible via the in-process session API — it always
    // creates a real user turn (the model answers it). The silent chat artifact is the compaction
    // checkpoint produced by `session.compact` (see requestForce). So we only toast here.
  }

  const refresh = () => {
    const next = read()
    setRows(next)
    const newest = next[next.length - 1]
    if (newest?.ts && newest.ts !== lastSeen) {
      lastSeen = newest.ts
      if (newest.origin === "manual" && newest.reduction != null && (!newest.sessionID || newest.sessionID === (slotSessionID || currentSession()))) {
        postReport(newest)
      } else if (
        newest.origin === "manual" &&
        newest.outcome === "skip" &&
        (!newest.sessionID || newest.sessionID === (slotSessionID || currentSession()))
      ) {
        try {
          ctx?.ui?.toast?.show?.({ title: "Jev Context Compactor", message: "nothing to compress", variant: "info", duration: 4000 })
        } catch {
          /* ignore */
        }
      }
    }
  }

  try {
    ctx?.data?.on?.("session.idle", refresh)
  } catch {
    /* ignore */
  }
  const timer = setInterval(refresh, 3000)

  const currentSession = (): string => {
    const cands: unknown[] = []
    try { cands.push(ctx?.ui?.router?.current?.()?.sessionID) } catch { /* ignore */ }
    try { cands.push(ctx?.ui?.router?.current?.()?.session?.id) } catch { /* ignore */ }
    try { cands.push(ctx?.data?.session?.current?.()?.id) } catch { /* ignore */ }
    try { cands.push(ctx?.data?.session?.current?.()) } catch { /* ignore */ }
    try { cands.push(ctx?.data?.session?.id) } catch { /* ignore */ }
    return (cands.find((x) => typeof x === "string" && x) as string) ?? ""
  }

  const requestForce = () => {
    const sid = slotSessionID || currentSession()
    tlog({ event: "tui.compress.requested", session: sid, file: FORCE_FILE })
    try {
      ctx?.ui?.toast?.show?.({ title: "Jev Context Compactor", message: "compressing context…", variant: "info", duration: 3000 })
    } catch {
      /* ignore */
    }
    if (!sid) return
    const forceFlag = () => {
      try {
        mkdirSync(dirname(FORCE_FILE), { recursive: true })
        appendFileSync(FORCE_FILE, JSON.stringify({ session: sid, ts: Date.now() }))
      } catch {
        /* ignore */
      }
    }
    // The TUI plugin client cannot resolve session ids for the session API (always "Invalid session
    // ID"), so we don't call it. We only arm the session-scoped force flag; the SERVER consumes it on
    // the next request — it prunes the request view and triggers the real compaction (ctx.session.compact).
    forceFlag()
  }

  // sidebar panel
  try {
    ctx?.ui?.slot?.({
      append: "sidebar.content",
      render: (slotProps: any) => {
        const theme = slotProps?.theme ?? ctx?.theme
        const dimRaw = theme?.text?.muted ?? theme?.text?.base
        const dim = dimRaw ? color(dimRaw) : undefined
        const sid = typeof slotProps?.sessionID === "string" ? slotProps.sessionID : ""
        if (sid && sid !== slotSessionID) {
          slotSessionID = sid
          tlog({ event: "tui.slot.session", sid })
        }
        const all = sid ? rows().filter((r) => r.sessionID === sid) : rows()
        if (all.length === 0) return null
        const shown = expanded() ? all.slice(-EXPANDED).reverse() : []
        const hidden = all.length - shown.length
        return (
          <box flexDirection="column">
            <box flexDirection="row" onMouseDown={() => setExpanded((v) => !v)}>
              <text>
                {expanded() ? "▼ " : "▶ "}
                <b>Jev Context Compactor</b>
              </text>
            </box>
            {shown.map((r) => (
              <box flexDirection="row" justifyContent="space-between" width="100%">
                <text>{label(r)}</text>
                <text fg={dim}>{when(r)}</text>
              </box>
            ))}
            {expanded() && hidden > 0 ? <text fg={dim}>… {hidden} more</text> : null}
          </box>
        )
      },
    })
    tlog({ event: "tui.slot", claimed: true })
  } catch (e) {
    tlog({ event: "tui.slot.error", error: String(e) })
  }

  // commands (keymap layers must be created inside a slot render)
  try {
    ctx?.ui?.slot?.({
      append: "app",
      render() {
        try {
          ctx.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "jev-context-compactor.compress",
                title: "Compress context (Jev)",
                description: "Prune the next request with Jev",
                group: "Jev",
                palette: true,
                slash: { name: "compress", arguments: true },
                run: () => requestForce(),
              },
              {
                id: "jev-context-compactor.toggle",
                title: "Toggle Jev Context Compactor list",
                description: "Expand or collapse the context timeline",
                group: "Jev",
                bind: "ctrl+e",
                palette: true,
                run: () => setExpanded((v) => !v),
              },
            ],
          }))
          tlog({ event: "tui.command", names: "compress,toggle" })
        } catch (e) {
          tlog({ event: "tui.command.error", error: String(e) })
        }
        return <box />
      },
    })
  } catch (e) {
    tlog({ event: "tui.command.error", error: String(e) })
  }

  return () => clearInterval(timer)
}

export default { id: "jev-context-compactor", setup: tuiSetup, tui: tuiSetup }
