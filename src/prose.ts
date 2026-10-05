/**
 * prose.ts — pure helpers for prose compression and the position bar. Dependency-free so they can be
 * unit-tested without the plugin runtime.
 */

export interface ProseCandidate {
  role?: string
  text?: string
  toolUses?: readonly unknown[]
  toolResults?: readonly unknown[]
}

/** Anything that can answer Jev questions: `JevClient`, or a test double. */
export interface JevAskerLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ask(state: unknown, questions: unknown): Promise<any>
}

/**
 * Ask Jev which older PROSE messages are unnecessary; returns their indices (manual compress only).
 * Candidates are user/assistant messages with real text and no tool parts, older than the protected
 * tail. A message is dropped when Jev's `noul` probability is >= `threshold`.
 */
export async function proseDrops(
  base: JevAskerLike,
  lib: readonly ProseCandidate[],
  preserve: number,
  threshold = 0.7,
): Promise<Set<number>> {
  const drops = new Set<number>()
  const keepFrom = lib.length - Math.max(preserve, 2)
  const idxs: number[] = []
  for (let i = 0; i < keepFrom; i++) {
    const m = lib[i]
    if (m?.role !== "user" && m?.role !== "assistant") continue
    if (!m.text || String(m.text).length < 300) continue
    if ((m.toolUses?.length ?? 0) > 0 || (m.toolResults?.length ?? 0) > 0) continue
    idxs.push(i)
  }
  if (idxs.length === 0) return drops
  const state = idxs.map((i) => `[${i}] ${lib[i].role}: ${String(lib[i].text).slice(0, 2000)}`).join("\n\n")
  const questions: Record<string, unknown> = {}
  for (const i of idxs) {
    questions[`drop_m${i}`] = {
      type: "noul",
      instructions: `Message [${i}] is unnecessary context: it can be removed without losing information needed to continue the conversation.`,
      criteria: { true: "removing it loses nothing important", false: "it is still needed" },
    }
  }
  const res = await base.ask(state, questions)
  for (const i of idxs) {
    const p = res?.answers?.[`drop_m${i}`]?.noul
    if (typeof p === "number" && p >= threshold) drops.add(i)
  }
  return drops
}

/** a DCP-style position bar: where content was compressed (▓) vs kept (░) */
export function positionBar(total: number, spans: ReadonlyArray<readonly [number, number]>, width = 20): string {
  if (total <= 0 || width <= 0) return ""
  const cells = new Array<string>(width).fill("░")
  for (const [a, b] of spans) {
    const s = Math.max(0, Math.min(width - 1, Math.floor((a / total) * width)))
    const e = Math.max(s, Math.min(width - 1, Math.ceil((b / total) * width) - 1))
    for (let i = s; i <= e; i++) cells[i] = "▓"
  }
  return cells.join("")
}
