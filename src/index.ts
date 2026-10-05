/**
 * Jev Context Compactor — an OpenCode v2 plugin that compresses context with Jev (a typed-judgment
 * model: Jev judges, our code acts).
 *
 * Two levers:
 *  - `context` hook (default): prune the OUTGOING request — Jev-scored stale tool calls/results, plus,
 *    on manual `/compress`, older prose messages Jev judges unnecessary. Non-destructive: stored
 *    history is never touched.
 *  - `compaction` hook: when Jev actually compresses, hand v2 a stats summary instead of letting v2
 *    summarise; otherwise v2's own continuation summary stands.
 *
 * A model-callable `compress` tool (via `ctx.tool.transform`) and the TUI `/compress` command force it.
 * Config precedence: plugin `options` → env → defaults. Fail-open: any error leaves v2 untouched.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "fs"
import { dirname, join } from "path"
import { homedir, tmpdir } from "os"
import { compact, messageChars } from "./vendor/fast-jev-compaction/src/compact.js"
import { collectToolCalls } from "./vendor/fast-jev-compaction/src/state.js"
import { JevClient } from "./vendor/fast-jev-compaction/src/client.js"
import type { CompactOptions } from "./vendor/fast-jev-compaction/src/types.js"
import {
  applyDecisionsToV2,
  renderSummary,
  toLibraryMessages,
  type SummaryOptions,
  type V2Message,
} from "./mapper.js"
import { applyPolicy, totalChars } from "./policy.js"
import { positionBar, proseDrops } from "./prose.js"
import { wrapAsker, type Strategy } from "./facts.js"

const LOG = process.env.FAST_JEV_V2_LOG || join(tmpdir(), "opencode-jev-context-compactor.log")
// durable, stable record of every compaction event — this is what the TUI panel reads
const STATS =
  process.env.FAST_JEV_STATS_FILE ||
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "opencode",
    "jev-context-compactor",
    "stats.jsonl",
  )
// the TUI `/compress` command drops this flag; the next request is pruned unconditionally
const FORCE_FILE = join(dirname(STATS), "force")

/** join a v2 message's text parts */
function v2Text(m: V2Message): string {
  const content = Array.isArray(m?.content) ? m.content : []
  return content
    .filter((p: any) => p?.type === "text")
    .map((p: any) => String(p.text ?? ""))
    .join("\n")
}

/** true if the most recent user message contains a typed `/compress` */
function userTextHasCompress(msgs: readonly V2Message[]): boolean {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role !== "user") continue
    return /(^|\s)[/／]compress\b/i.test(v2Text(msgs[i]))
  }
  return false
}

/** strip a typed `/compress` token from the newest user message (request view only) */
function stripCompressToken(msgs: readonly V2Message[]): V2Message[] {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m?.role !== "user") continue
    const content = (Array.isArray(m.content) ? m.content : []).map((p: any) =>
      p?.type === "text" && typeof p.text === "string"
        ? { ...p, text: p.text.replace(/(^|\s)[/／]compress\b/gi, "$1").trim() }
        : p,
    )
    return [...msgs.slice(0, i), { ...m, content }, ...msgs.slice(i + 1)]
  }
  return [...msgs]
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`
}

function log(fields: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n")
  } catch {
    /* never break the host */
  }
}

type CallAnswers = { keepCall: number; keepResult: number }
type CacheByUse = Map<string, CallAnswers>

/**
 * Wrap an asker with a per-`tool_use_id` decision cache: a call judged once keeps its verdict for the
 * session, so requests with no new tool calls make no Jev request at all.
 */
export function wrapCache(
  base: { ask: (state: any, questions: any) => Promise<any> },
  calls: readonly { id: string; tool_use_id: string }[],
  idToUse: Map<string, string>,
  cache: CacheByUse,
) {
  return {
    async ask(state: any, questions: any) {
      const local: Record<string, { noul: number }> = {}
      const rest: Record<string, any> = {}
      for (const [key, q] of Object.entries(questions as Record<string, any>)) {
        const m = /^(call|result)_(t\d+)$/.exec(key)
        const use = m ? idToUse.get(m[2]!) : undefined
        const hit = use ? cache.get(use) : undefined
        if ((q as any).type === "noul" && m && hit) {
          local[key] = { noul: m[1] === "call" ? hit.keepCall : hit.keepResult }
        } else {
          rest[key] = q
        }
      }
      const answers: Record<string, any> = { ...local }
      if (Object.keys(rest).length > 0) {
        const res = await base.ask(state, rest)
        Object.assign(answers, res.answers)
      }
      for (const call of calls) {
        const ca = answers[`call_${call.id}`]?.noul
        const ra = answers[`result_${call.id}`]?.noul
        if (typeof ca === "number" || typeof ra === "number") {
          const prev = cache.get(call.tool_use_id) ?? { keepCall: 0, keepResult: 0 }
          cache.set(call.tool_use_id, {
            keepCall: typeof ca === "number" ? ca : prev.keepCall,
            keepResult: typeof ra === "number" ? ra : prev.keepResult,
          })
        }
      }
      return { answers }
    },
  }
}

/** fetch with an abort timeout — fail-open covers errors, not a hung request */
function record(fields: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(STATS), { recursive: true })
    appendFileSync(STATS, JSON.stringify({ ts: new Date().toISOString(), ...fields }) + "\n")
  } catch {
    /* never break the host */
  }
}

function timeoutFetch(ms: number): typeof fetch {
  return ((input: any, init: any = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
  }) as typeof fetch
}

type Options = Record<string, unknown>

function pick(name: string, opts: Options, envName: string, fallback: number): number {
  const fromOpts = opts[name]
  if (typeof fromOpts === "number" && Number.isFinite(fromOpts)) return fromOpts
  const raw = process.env[envName]
  if (raw !== undefined && raw !== "") {
    const v = Number(raw)
    if (Number.isFinite(v)) return v
  }
  return fallback
}

const STRATEGIES = ["judgement", "factsFirst", "deterministic", "auto"] as const

function resolveStrategyOption(fromOpts: unknown, fromEnv: string | undefined): Strategy {
  if (typeof fromOpts === "string" && (STRATEGIES as readonly string[]).includes(fromOpts)) {
    return fromOpts as Strategy
  }
  if (fromEnv && (STRATEGIES as readonly string[]).includes(fromEnv)) return fromEnv as Strategy
  return "factsFirst"
}

function listOption(name: string, opts: Options, envName: string): string[] {
  const fromOpts = opts[name]
  if (Array.isArray(fromOpts)) return fromOpts.filter((v): v is string => typeof v === "string")
  const raw = process.env[envName]
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : []
}

const SUMMARY_STYLES = ["minimal", "stats", "outline", "verbatim"] as const
type SummaryStyle = (typeof SUMMARY_STYLES)[number]

function resolveSummaryStyle(fromOpts: unknown, fromEnv: string | undefined): SummaryStyle {
  if (typeof fromOpts === "string" && (SUMMARY_STYLES as readonly string[]).includes(fromOpts)) {
    return fromOpts as SummaryStyle
  }
  if (fromEnv && (SUMMARY_STYLES as readonly string[]).includes(fromEnv)) return fromEnv as SummaryStyle
  return "minimal"
}

type Config = CompactOptions & {
  model: string
  minReductionRatio: number
  strategy: Strategy
  minResultChars: number
  smallResultChars: number
  protectedTools: string[]
  protectedFiles: string[]
  timeoutMs: number
  summaryStyle: SummaryStyle
  prune: boolean
  autoAtPercent: number
  contextLimitTokens: number
}

export function resolveConfig(opts: Options = {}): Config {
  const cfg: Config = {
    model:
      (typeof opts.model === "string" && opts.model) || process.env.FAST_JEV_MODEL || "jev-1.13.0",
    // 0.15 (not 0.5): stale calls measure keepCall 0.1-0.2, so 0.5 would *delete* nearly every unpinned
    // call. At 0.15 the normal outcome is drop_result — keep the call, truncate the bulky result.
    keepThreshold: pick("keepThreshold", opts, "FAST_JEV_KEEP_THRESHOLD", 0.15),
    preserveRecentMessages: pick("preserveRecentMessages", opts, "FAST_JEV_PRESERVE_RECENT", 10),
    minResultChars: pick("minResultChars", opts, "FAST_JEV_MIN_RESULT_CHARS", 4000),
    // results below this are never touched (0 = off)
    smallResultChars: pick("smallResultChars", opts, "FAST_JEV_SMALL_RESULT_CHARS", 0),
    protectedTools: listOption("protectedTools", opts, "FAST_JEV_PROTECTED_TOOLS"),
    protectedFiles: listOption("protectedFiles", opts, "FAST_JEV_PROTECTED_FILES"),
    timeoutMs: pick("timeoutMs", opts, "FAST_JEV_TIMEOUT_MS", 30_000),
    summaryStyle: resolveSummaryStyle(opts.summaryStyle, process.env.FAST_JEV_SUMMARY_STYLE),
    // request-view pruning (default on). explicit option wins over env (options > env > defaults)
    prune: typeof opts.prune === "boolean" ? opts.prune : process.env.FAST_JEV_PRUNE !== "0",
    // auto-compress when the request fills this share of the model's context (DCP's "at the limit")
    autoAtPercent: pick("autoAtPercent", opts, "FAST_JEV_AUTO_AT_PERCENT", 60),
    contextLimitTokens: pick("contextLimitTokens", opts, "FAST_JEV_CONTEXT_LIMIT", 128_000),
    // 0.10 (not 0.25): the alternative when we decline is v2's *lossy* summariser, so a modest but
    // real reduction is worth taking verbatim. 0 would apply no-op "compactions" — hence a floor.
    minReductionRatio: pick("minReductionRatio", opts, "FAST_JEV_MIN_REDUCTION", 0.1),
    maxStateTokens: pick("maxStateTokens", opts, "FAST_JEV_MAX_STATE_TOKENS", 25_000),
    maxRequestTokens: pick("maxRequestTokens", opts, "FAST_JEV_MAX_REQUEST_TOKENS", 30_000),
    truncateHeadChars: pick("truncateHeadChars", opts, "FAST_JEV_TRUNCATE_HEAD_CHARS", 300),
    strategy: resolveStrategyOption(opts.strategy, process.env.FAST_JEV_STRATEGY),
  }
  const goal = (typeof opts.goal === "string" && opts.goal) || process.env.FAST_JEV_GOAL
  if (goal) cfg.goal = goal
  return cfg
}

export default {
  id: "jev-context-compactor",
  async setup(ctx: any) {
    const opts: Options = (ctx?.options as Options) ?? {}
    const cfg = resolveConfig(opts)
    // explicit option wins; otherwise env, defaulting to on
    const apply = typeof opts.apply === "boolean" ? opts.apply : process.env.FAST_JEV_V2_APPLY !== "0"
    const hasHook = typeof ctx?.session?.hook === "function"
    log({ event: "setup", hasHook, model: cfg.model, apply, strategy: cfg.strategy, minReductionRatio: cfg.minReductionRatio, preserveRecentMessages: cfg.preserveRecentMessages })
    if (!hasHook) return

    // DCP parity: a model-callable `compress` tool. v2 API (official docs): `ctx.tool.transform(editor)`
    // with `editor.add({ name, description, input: <JSON Schema object>, execute })`. `input` MUST be a
    // plain JSON Schema object — a function is silently rejected and the tool never surfaces.
    try {
      const t: any = ctx.tool
      if (t && typeof t.transform === "function") {
        await t.transform((draft: any) => {
          try {
            const before = (draft.list?.() ?? []).map((x: any) => x?.name)
            if (!before.includes("compress")) {
              draft.add({
                name: "compress",
                description:
                  "Compress the conversation context with Jev. Stale or superseded tool calls and results are pruned, keeping the conversation coherent while freeing context. Use when the context is large and earlier tool output is no longer needed.",
                input: {
                  type: "object",
                  properties: {
                    focus: { type: "string", description: "Optional: anything to keep in mind while compressing." },
                  },
                  additionalProperties: false,
                },
                options: { codemode: false },
                execute: async (_input: any, tool: any) => {
                  const sid = typeof tool?.sessionID === "string" ? tool.sessionID : ""
                  try {
                    mkdirSync(dirname(FORCE_FILE), { recursive: true })
                    appendFileSync(FORCE_FILE, JSON.stringify({ session: sid, ts: Date.now() }))
                    log({ event: "tool.compress.execute", session: sid })
                  } catch (e) {
                    log({ event: "tool.compress.error", error: String(e) })
                  }
                  return { content: "Context compression requested — the next model request will be pruned." }
                },
              })
            }
            const after = (draft.list?.() ?? []).map((x: any) => x?.name)
            log({
              event: "tool.transform",
              entered: before.includes("compress"),
              presentAfter: after.includes("compress"),
              total: after.length,
            })
          } catch (e) {
            log({ event: "tool.compress.registration.error", error: String(e) })
          }
        })
      }
    } catch (e) {
      log({ event: "tool.compress.setup.error", error: String(e) })
    }

    // per-session decision cache keyed by tool_use_id (context-pruner's economy trick)
    const caches = new Map<string, CacheByUse>()
    function cacheFor(sid: string): CacheByUse {
      let c = sid ? caches.get(sid) : undefined
      if (!c) {
        c = new Map()
        if (sid) caches.set(sid, c)
      }
      return c
    }

    // One compaction at a time per session — a retry/overlap shouldn't double the Jev call.
    // (The v1 adapter also cached results, but only because it ran on *every* request; we run per
    // compaction, so there is nothing recurring to cache.)
    const inFlight = new Set<string>()
    // guards a server-side compaction trigger so one manual request can't start two compactions
    const compacting = new Set<string>()
    // sessions whose next compaction was explicitly requested (manual /compress) — never skip those
    const manualCompacts = new Set<string>()

    await ctx.session.hook("compaction", async (input: any) => {
      const t0 = Date.now()
      const sid = typeof input?.sessionID === "string" ? input.sessionID : ""
      if (sid && inFlight.has(sid)) {
        log({ event: "compaction.skip", reason: "already in flight", session: sid })
        record({ sessionID: sid, outcome: "skip", reason: "already-in-flight" })
        return
      }
      if (sid) inFlight.add(sid)
      try {
        const key = process.env.TYPESAFE_API_KEY
        if (!key) {
          log({ event: "compaction.skip", reason: "no TYPESAFE_API_KEY" })
          record({ sessionID: sid, outcome: "skip", reason: "no-key" })
          return
        }
        const lib = toLibraryMessages((input?.messages ?? []) as V2Message[])
        const resultChars = lib.reduce(
          (n, m) => n + (m.toolResults?.reduce((k, r) => k + r.text.length, 0) ?? 0),
          0,
        )
        const forcedManual = !!sid && manualCompacts.has(sid)
        // a manual `/compress` shrinks the protected window and judges harder so it can actually cut
        const cmpPreserve = forcedManual ? 0 : (cfg.preserveRecentMessages ?? 10)
        const cmpStrat = forcedManual ? "judgement" : cfg.strategy
        const cmpCfg = { ...cfg, preserveRecentMessages: cmpPreserve, strategy: cmpStrat, ...(forcedManual ? { keepThreshold: 0.75 } : {}) }
        if (!forcedManual && resultChars < cfg.minResultChars) {
          log({ event: "compaction.skip", reason: "below minResultChars", resultChars })
          record({ sessionID: sid, outcome: "skip", reason: "below-min-result-chars", resultChars })
          return
        }
        if (process.env.FAST_JEV_V2_DEBUG === "1") {
          log({
            event: "compaction.input",
            msgs: lib.length,
            toolUses: lib.reduce((n, m) => n + m.toolUses.length, 0),
            toolResults: lib.reduce((n, m) => n + (m.toolResults?.length ?? 0), 0),
          })
        }
        const cmpCalls = collectToolCalls(lib, cmpPreserve)
        const cmpIdToUse = new Map(cmpCalls.map((c) => [c.id, c.tool_use_id]))
        const prepared = wrapAsker(
          wrapCache(
            new JevClient({
              apiKey: key,
              model: cfg.model,
              baseUrl: process.env.FAST_JEV_BASE_URL,
              fetch: timeoutFetch(cfg.timeoutMs),
            }),
            cmpCalls,
            cmpIdToUse,
            cacheFor(sid),
          ) as any,
          { strategy: cmpStrat, messages: lib, preserveRecentMessages: cmpPreserve },
        )
        log({
          event: "compaction.strategy",
          requested: cfg.strategy,
          effective: prepared.effective,
          pinnedByReference: prepared.pinned,
        })
        const engineResult = await compact(lib, prepared.asker, cmpCfg)
        const policy = applyPolicy(lib, engineResult.decisions, {
          preserveRecentMessages: cmpPreserve,
          truncateHeadChars: cfg.truncateHeadChars ?? 300,
          smallResultChars: cfg.smallResultChars,
          protectedTools: cfg.protectedTools,
          protectedFiles: cfg.protectedFiles,
        })
        log({ event: "compaction.policy", ...policy.stats })
        const before = totalChars(lib)
        const after = totalChars(policy.messages)
        const reduction = before > 0 ? (before - after) / before : 0
        if (reduction < cfg.minReductionRatio) {
          log({
            event: "compaction.skip",
            reason: "below minReductionRatio",
            reduction: +reduction.toFixed(4),
            chars: `${before}->${after}`,
            candidates: engineResult.stats.calls,
            kept: engineResult.stats.kept,
            pinnedByReference: prepared.pinned,
            minReductionRatio: cfg.minReductionRatio,
          })
          record({
            sessionID: sid,
            outcome: "skip",
            reason: "below-min-reduction",
            reduction: +reduction.toFixed(4),
            charsBefore: before,
            charsAfter: after,
            candidates: engineResult.stats.calls,
            kept: engineResult.stats.kept,
            superseded: policy.stats.superseded,
            errorResolved: policy.stats.errorResolved,
            downgraded: policy.stats.downgraded,
            hardDrops: policy.stats.hardDrops,
            pinned: prepared.pinned,
          })
          return
        }
        // The summary IS the checkpoint v2 shows after compaction. Default `stats`: a small stats line
        // plus call lines, no result bodies. `outline` keeps bounded bodies; `verbatim` is discouraged.
        const keptCount = policy.decisions.filter((d) => d.action === "keep").length
        const cutCount = policy.decisions.filter((d) => d.action === "drop_result").length
        const dropCount = policy.decisions.filter((d) => d.action === "drop_call").length
        const header =
          `Jev Context Compactor -${Math.round(reduction * 100)}% · kept ${keptCount} · ` +
          `cut ${cutCount} · drop ${dropCount} · ${Date.now() - t0}ms`
        const styleOpts: SummaryOptions =
          cfg.summaryStyle === "verbatim"
            ? {}
            : cfg.summaryStyle === "outline"
              ? { header, results: "head", resultChars: cfg.truncateHeadChars ?? 300 }
              : cfg.summaryStyle === "stats"
                ? { header, results: "size" }
                : { header, results: "none", calls: false, text: false } // minimal: the model forgets
        const summary = renderSummary(policy.messages, styleOpts)
        // never replace history with nothing (e.g. no prose and every call superseded)
        if (!summary.trim()) {
          log({ event: "compaction.skip", reason: "empty summary", candidates: engineResult.stats.calls })
          record({ sessionID: sid, outcome: "skip", reason: "empty-summary" })
          return
        }
        const stats = {
          sessionID: sid,
          reduction: +reduction.toFixed(4),
          charsBefore: before,
          charsAfter: after,
          candidates: engineResult.stats.calls,
          kept: engineResult.stats.kept,
          superseded: policy.stats.superseded,
          errorResolved: policy.stats.errorResolved,
          downgraded: policy.stats.downgraded,
          hardDrops: policy.stats.hardDrops,
          truncated: policy.stats.downgraded,
          pinned: prepared.pinned,
          summaryChars: summary.length,
          ms: Date.now() - t0,
          strategy: prepared.effective,
        }
        if (!apply) {
          log({ event: "compaction.dryrun", reduction, summaryChars: summary.length, ms: Date.now() - t0 })
          record({ ...stats, outcome: "dryrun" })
          return
        }
        input.result = { summary }
        if (sid) manualCompacts.delete(sid)
        log({ event: "compaction.applied", reduction, summaryChars: summary.length, ms: Date.now() - t0 })
        record({ ...stats, outcome: "applied" })
      } catch (e) {
        log({ event: "compaction.error", error: String(e) })
      } finally {
        if (sid) inFlight.delete(sid)
      }
    })

    // The workhorse: prune the OUTGOING REQUEST (DCP-style). Stored history is never touched, so the
    // model keeps seeing the conversation minus the stale parts — no checkpoint, no chat content.
    if (cfg.prune) {
      await ctx.session.hook("context", async (input: any) => {
        const t0 = Date.now()
        try {
          const key = process.env.TYPESAFE_API_KEY
          if (!key) return
          let v2 = (input?.messages ?? []) as V2Message[]
          // a typed `/compress` can arrive as plain text (the composer may pass the slash through as a
          // message). Honour it, and strip the token so the model isn't asked to answer it.
          const typedCompress = userTextHasCompress(v2)
          if (typedCompress) {
            v2 = stripCompressToken(v2)
            input.messages = v2
          }
          // `/compress` flag is scoped to the session that requested it — never consumed by another
          let requested = false
          try {
            if (existsSync(FORCE_FILE)) {
              const raw = readFileSync(FORCE_FILE, "utf8")
              let want = ""
              try {
                want = String((JSON.parse(raw) as { session?: string })?.session ?? "")
              } catch {
                want = ""
              }
              const sidNow = typeof input?.sessionID === "string" ? input.sessionID : ""
              if (!want || want === sidNow) {
                unlinkSync(FORCE_FILE)
                requested = true
              }
            }
          } catch {
            /* ignore */
          }
          const manual = requested || typedCompress
          let lib = toLibraryMessages(v2)
          // manual `/compress`: ask Jev which older PROSE messages are unnecessary, and drop them
          // (deletion — Jev judges, code acts). This is what compresses prose, not just tool output.
          if (manual) {
            try {
              const base = new JevClient({
                apiKey: key,
                model: cfg.model,
                baseUrl: process.env.FAST_JEV_BASE_URL,
                fetch: timeoutFetch(cfg.timeoutMs),
              })
              const drops = await proseDrops(base, lib, 2)
              if (drops.size > 0) {
                v2 = v2.filter((_, i) => !drops.has(i))
                input.messages = v2
                lib = toLibraryMessages(v2)
                log({ event: "context.prose", dropped: drops.size, msgs: lib.length })
              }
            } catch (e) {
              log({ event: "context.prose.error", error: String(e) })
            }
          }
          const resultChars = lib.reduce(
            (n, m) => n + (m.toolResults?.reduce((k, r) => k + r.text.length, 0) ?? 0),
            0,
          )
          const tokens = Math.round(lib.reduce((n, m) => n + messageChars(m), 0) / 4)
          const usagePct = cfg.contextLimitTokens > 0 ? (tokens / cfg.contextLimitTokens) * 100 : 0
          const force = manual || usagePct >= cfg.autoAtPercent
          log({
            event: "context.enter",
            msgs: lib.length,
            tokens,
            usagePct: +usagePct.toFixed(1),
            resultChars,
            force,
            manual,
          })
          if (!force) {
            // prune only when forced: manual (`/compress`, compress tool) or at the auto threshold.
            // Pruning on every bulky turn re-counts the same history and reads as a loop.
            log({ event: "context.skip", reason: "not-forced", resultChars, usagePct: +usagePct.toFixed(1) })
            return
          }

          // when auto-forced at the context limit, shrink the protected window so recent bulky
          // results become eligible (otherwise a big recent result is untouchable)
          const sid = typeof input?.sessionID === "string" ? input.sessionID : ""
          const preserve = force ? (manual ? 0 : Math.min(cfg.preserveRecentMessages ?? 10, 2)) : (cfg.preserveRecentMessages ?? 10)
          // manual compress ignores reference-pinning (factsFirst) — the user asked, so Jev decides
          const strat = manual ? "judgement" : cfg.strategy
          // a manual `/compress` must actually cut: bypass the cache and judge more aggressively
          const runCfg = {
            ...cfg,
            preserveRecentMessages: preserve,
            ...(manual ? { keepThreshold: 0.75, strategy: strat } : {}),
          }
          const calls = collectToolCalls(lib, preserve)
          const idToUse = new Map(calls.map((c) => [c.id, c.tool_use_id]))
          const prepared = wrapAsker(
            wrapCache(
              new JevClient({
                apiKey: key,
                model: cfg.model,
                baseUrl: process.env.FAST_JEV_BASE_URL,
                fetch: timeoutFetch(cfg.timeoutMs),
              }),
              calls,
              idToUse,
              manual ? new Map() : cacheFor(sid),
            ) as any,
            { strategy: strat, messages: lib, preserveRecentMessages: preserve },
          )
          const engineResult = await compact(lib, prepared.asker, runCfg)
          const policy = applyPolicy(lib, engineResult.decisions, {
            preserveRecentMessages: preserve,
            truncateHeadChars: cfg.truncateHeadChars ?? 300,
            smallResultChars: cfg.smallResultChars,
            protectedTools: cfg.protectedTools,
            protectedFiles: cfg.protectedFiles,
          })
          const before = totalChars(lib)
          const after = totalChars(policy.messages)
          if (after >= before) {
            log({ event: "context.skip", reason: "no-gain", before, after, force })
            if (manual) record({ sessionID: sid, outcome: "skip", reason: "nothing-to-compress", origin: "manual" })
            return
          }

          // manual → real, persistent compaction: v2's own compaction flow, which runs our
          // `compaction` hook and writes the Jev stats block into chat. Only when there IS a gain, so a
          // tool-less session never triggers v2's default summary.
          if (manual && sid && !compacting.has(sid)) {
            compacting.add(sid)
            manualCompacts.add(sid)
            const sess: any = ctx.session
            if (typeof sess?.compact === "function") {
              Promise.resolve(sess.compact({ sessionID: sid }))
                .then(() => log({ event: "context.compact.triggered", session: sid }))
                .catch((e: unknown) => log({ event: "context.compact.error", error: String(e) }))
                .finally(() => compacting.delete(sid))
            } else {
              compacting.delete(sid)
            }
          }

          const reduction = (before - after) / before
          const pruned = applyDecisionsToV2(v2, policy.decisions, calls, cfg.truncateHeadChars ?? 300)
          if (!pruned.length) return
          input.messages = pruned // request view only — stored history untouched

          const ms = Date.now() - t0
          log({
            event: "context.pruned",
            reduction: +reduction.toFixed(4),
            chars: `${before}->${after}`,
            tokens,
            usagePct: +usagePct.toFixed(1),
            force,
            ms,
          })
          record({
            sessionID: sid,
            outcome: "pruned",
            forced: force,
            origin: manual ? "manual" : "auto",
            tokens,
            usagePct: +usagePct.toFixed(1),
            reduction: +reduction.toFixed(4),
            charsBefore: before,
            charsAfter: after,
            kept: policy.decisions.filter((d) => d.action === "keep").length,
            downgraded: policy.decisions.filter((d) => d.action === "drop_result").length,
            hardDrops: policy.decisions.filter((d) => d.action === "drop_call").length,
            ms,
            strategy: prepared.effective,
          })

          // VISIBLE chat stats. v2 has no silent chat surface, so this is an injected (model-visible)
          // message — the model may briefly acknowledge it. That is the cost of visible chat stats.
          if (manual && sid) {
            const keptN = policy.decisions.filter((d) => d.action === "keep").length
            const cutN = policy.decisions.filter((d) => d.action === "drop_result").length
            const callById = new Map(calls.map((c) => [c.id, c]))
            const spans: Array<[number, number]> = []
            for (const d of policy.decisions) {
              if (d.action === "keep") continue
              const c = callById.get(d.id) as { callIndex?: number; resultIndex?: number } | undefined
              if (c) spans.push([c.callIndex ?? 0, c.resultIndex ?? c.callIndex ?? 0])
            }
            const bar = positionBar(lib.length, spans)
            const statsText = `▣ Jev Context Compactor | -${Math.round(reduction * 100)}% · -${fmtK(before - after)} removed, ${fmtK(after)} left\n→ kept ${keptN} calls, truncated ${cutN} results\n→ ${bar}  ${ms}ms · ${prepared.effective}`
            try {
              const sess: any = ctx.session
              Promise.resolve(sess?.prompt?.({ sessionID: sid, text: statsText })).catch((e: unknown) =>
                log({ event: "context.stats.error", error: String(e) }),
              )
            } catch (e) {
              log({ event: "context.stats.error", error: String(e) })
            }
          }
        } catch (e) {
          log({ event: "context.error", error: String(e) })
        }
      })
    }
  },
}
