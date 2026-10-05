/**
 * policy.ts — the deletion policy, applied on top of the engine's decisions.
 *
 * Rule (borrowed from JLegends/opencode-jev-compaction): **a model answer may only truncate; only
 * deterministic evidence may delete.** So we:
 *   - delete (drop_call) only for `superseded` / `error-resolved` calls — provable from the transcript;
 *   - downgrade any probabilistic `drop_call` to `drop_result` (keep the call, truncate the result);
 *   - optionally leave small results alone.
 *
 * The engine stays byte-identical; we re-apply its decisions to the original messages.
 */
import { applyDecisions, messageChars } from "./vendor/fast-jev-compaction/src/compact.js"
import { collectToolCalls } from "./vendor/fast-jev-compaction/src/state.js"
import type {
  CallDecision,
  Message as LibMessage,
  ToolCall,
} from "./vendor/fast-jev-compaction/src/types.js"

export interface PolicyOptions {
  preserveRecentMessages: number
  truncateHeadChars: number
  /** results below this many chars are never touched (0 = off) */
  smallResultChars: number
  /** tool names never touched (e.g. ["skill", "task"]) */
  protectedTools?: string[]
  /** glob patterns matched against a call's path/filePath, never touched */
  protectedFiles?: string[]
}

export interface PolicyStats {
  superseded: number
  errorResolved: number
  downgraded: number
  smallKept: number
  protected: number
  hardDrops: number
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/** the call's target: the thing it acts on (path/command/url/id), else its whole input */
function targetOf(call: ToolCall): string {
  const input = (call.input ?? {}) as Record<string, unknown>
  const t = input.path ?? input.filePath ?? input.command ?? input.url ?? input.id
  return typeof t === "string" && t ? `${call.tool}|${t}` : `${call.tool}|${safeJson(input)}`
}

function pathOf(call: ToolCall): string | undefined {
  const input = (call.input ?? {}) as Record<string, unknown>
  const p = input.path ?? input.filePath
  return typeof p === "string" ? p : undefined
}

/** tiny glob → regex: `**` any, `*` within a segment, `?` one char */
function globToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  const re = esc
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${re}$`)
}

function isProtected(call: ToolCall, protectedTools: string[], protectedFiles: string[]): boolean {
  if (protectedTools.includes(call.tool)) return true
  const p = pathOf(call)
  return !!p && protectedFiles.some((g) => globToRe(g).test(p))
}

export function applyPolicy(
  messages: readonly LibMessage[],
  decisions: readonly CallDecision[],
  opts: PolicyOptions,
): { decisions: CallDecision[]; messages: LibMessage[]; stats: PolicyStats } {
  const calls = collectToolCalls(messages, opts.preserveRecentMessages)
  const byId = new Map(calls.map((c) => [c.id, c]))
  const protectedTools = opts.protectedTools ?? []
  const protectedFiles = opts.protectedFiles ?? []
  const protectedIds = new Set(
    calls.filter((c) => isProtected(c, protectedTools, protectedFiles)).map((c) => c.id),
  )

  // group candidate calls by target, ordered by where the call appears
  const groups = new Map<string, ToolCall[]>()
  for (const call of calls) {
    if (call.pinned || protectedIds.has(call.id)) continue
    const key = targetOf(call)
    const list = groups.get(key) ?? []
    list.push(call)
    groups.set(key, list)
  }

  const detReason = new Map<string, "superseded" | "error-resolved">()
  for (const list of groups.values()) {
    const ordered = [...list].sort((a, b) => a.callIndex - b.callIndex)
    // everything but the last call to this target is superseded; an errored one that a later call
    // resolved is recorded as error-resolved instead (same outcome, clearer accounting)
    ordered.slice(0, -1).forEach((call, i) => {
      if (detReason.has(call.id)) return
      const laterOk = call.isError && ordered.slice(i + 1).some((c) => !c.isError)
      detReason.set(call.id, laterOk ? "error-resolved" : "superseded")
    })
  }

  const stats: PolicyStats = {
    superseded: 0,
    errorResolved: 0,
    downgraded: 0,
    smallKept: 0,
    protected: 0,
    hardDrops: 0,
  }

  const next: CallDecision[] = decisions.map((d) => {
    const call = byId.get(d.id)
    // protected: never touch
    if (protectedIds.has(d.id)) {
      if (d.action !== "keep") {
        stats.protected++
        return { ...d, action: "keep", reason: "pinned" }
      }
      return d
    }
    // small results: leave them alone
    if (call && opts.smallResultChars > 0 && call.resultChars < opts.smallResultChars) {
      if (d.action !== "keep") {
        stats.smallKept++
        return { ...d, action: "keep", reason: "kept" }
      }
      return d
    }
    // deterministic deletion only
    const reason = detReason.get(d.id)
    if (reason) {
      stats[reason === "superseded" ? "superseded" : "errorResolved"]++
      return { ...d, action: "drop_call", reason: "call_dropped" }
    }
    // everything else: a model answer may only truncate
    if (d.action === "drop_call") {
      stats.downgraded++
      return { ...d, action: "drop_result", reason: "result_dropped" }
    }
    return d
  })

  stats.hardDrops = next.filter((d) => d.action === "drop_call").length
  const applied = applyDecisions(messages, next, calls, opts.truncateHeadChars)
  return { decisions: next, messages: applied, stats }
}

export function totalChars(messages: readonly LibMessage[]): number {
  return messages.reduce((n, m) => n + messageChars(m), 0)
}
