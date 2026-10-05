/**
 * facts.ts — strategy: how much to trust Jev's judgement vs plain facts.
 *
 * The engine asks Jev *judgement* questions ("does this still matter?"). Measurements elsewhere
 * (JLegends/opencode-jev-compaction) found judgement questions unreliable and factual ones reliable.
 * So we compute the reliable facts in code — is a call's target (path/command/id) referenced in later
 * prose? — and let the strategy decide what to do with the rest.
 *
 *   judgement     — ask Jev about every candidate (v1 behaviour)
 *   factsFirst    — pin provably-referenced calls locally, ask Jev about the rest (default)
 *   deterministic — pin referenced, drop the rest, no model at all
 *   auto          — factsFirst if the transcript has exact targets anywhere, else judgement
 */
import { collectToolCalls } from "./vendor/fast-jev-compaction/src/state.js"
import type {
  JevAsker,
  JevQuestions,
  JevResponse,
  Message as LibMessage,
} from "./vendor/fast-jev-compaction/src/types.js"

export type Strategy = "judgement" | "factsFirst" | "deterministic" | "auto"
export type EffectiveStrategy = Exclude<Strategy, "auto">

/** identifier-ish tokens inside an input object: paths, commands, ids, urls */
const STOP = new Set(["https", "http", "json", "true", "false", "null", "return", "const", "function"])
const TOKEN_RE = /[A-Za-z0-9_][A-Za-z0-9_.\-/]{3,}/g

/**
 * Only things that look like a *target*: a path/command/id carries a separator (./_-), or is long
 * enough to be an identifier. A generic word that recurs in prose ("test", "file", "path") is not a
 * reference — matching those over-pinned nearly everything.
 */
function looksLikeTarget(token: string): boolean {
  return /[/.\\_-]/.test(token) || token.length >= 8
}

function targetStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || value == null) return out
  if (typeof value === "string") {
    for (const token of value.match(TOKEN_RE) ?? []) {
      if (
        token.length >= 4 &&
        token.length <= 200 &&
        !STOP.has(token.toLowerCase()) &&
        looksLikeTarget(token)
      ) {
        out.push(token)
      }
    }
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value) targetStrings(v, out, depth + 1)
    return out
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) targetStrings(v, out, depth + 1)
  }
  return out
}

function laterProse(messages: readonly LibMessage[], afterIndex: number): string {
  return messages
    .slice(afterIndex + 1)
    .map((m) => m.text ?? "")
    .join("\n")
}

/** true if any candidate call carries an extractable, checkable target */
export function hasExactTargets(
  messages: readonly LibMessage[],
  preserveRecentMessages: number,
): boolean {
  return collectToolCalls(messages, preserveRecentMessages).some(
    (call) => targetStrings(call.input).length > 0,
  )
}

/** ids (t1, t2, …) of calls whose input target appears in later prose — provable, no model */
export function referencedCallIds(
  messages: readonly LibMessage[],
  preserveRecentMessages: number,
): Set<string> {
  const calls = collectToolCalls(messages, preserveRecentMessages)
  const referenced = new Set<string>()
  for (const call of calls) {
    const targets = targetStrings(call.input)
    if (targets.length === 0) continue
    const prose = laterProse(messages, call.resultIndex)
    if (targets.some((t) => prose.includes(t))) referenced.add(call.id)
  }
  return referenced
}

export function resolveStrategy(
  requested: Strategy,
  messages: readonly LibMessage[],
  preserveRecentMessages: number,
): EffectiveStrategy {
  if (requested !== "auto") return requested
  return hasExactTargets(messages, preserveRecentMessages) ? "factsFirst" : "judgement"
}

/**
 * Wrap the real asker according to the strategy. In every non-judgement mode the provably-referenced
 * calls are answered locally (keep); `deterministic` also answers the *rest* locally (drop), so no
 * request is made at all.
 */
export function wrapAsker(
  base: JevAsker,
  opts: { strategy: Strategy; messages: readonly LibMessage[]; preserveRecentMessages: number },
): { asker: JevAsker; effective: EffectiveStrategy; pinned: number } {
  const effective = resolveStrategy(opts.strategy, opts.messages, opts.preserveRecentMessages)
  if (effective === "judgement") return { asker: base, effective, pinned: 0 }

  const pinned = referencedCallIds(opts.messages, opts.preserveRecentMessages)
  if (effective === "factsFirst" && pinned.size === 0) {
    return { asker: base, effective, pinned: 0 }
  }

  const asker: JevAsker = {
    async ask(state, questions: JevQuestions): Promise<JevResponse> {
      const local: Record<string, { noul: number }> = {}
      const rest: JevQuestions = {}
      for (const [key, q] of Object.entries(questions)) {
        const match = /^(?:call|result)_(t\d+)$/.exec(key)
        const callId = match?.[1]
        if (q.type === "noul" && callId) {
          const keep = pinned.has(callId)
          if (effective === "deterministic") local[key] = { noul: keep ? 1 : 0 }
          else if (keep) local[key] = { noul: 1 }
          else rest[key] = q
        } else {
          rest[key] = q
        }
      }
      const answers: JevResponse["answers"] = { ...local }
      if (Object.keys(rest).length > 0) {
        const res = await base.ask(state, rest)
        Object.assign(answers, res.answers)
      }
      return { answers }
    },
  }
  return { asker, effective, pinned: pinned.size }
}
