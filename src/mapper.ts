/**
 * mapper.ts — v2 message shape ⇄ the vendored engine's shape, and the compaction summary.
 *
 * v2:  Message = { id, role, content: Part[], metadata }
 *      Part = text | reasoning | tool-call {id,name,input} | tool-result {id,name,result}
 *             | file/media (attachments)
 * lib: Message = { role: "user"|"assistant", text, toolUses[], toolResults? }
 */
import type {
  Message as LibMessage,
  ToolResult,
  ToolUse,
} from "./vendor/fast-jev-compaction/src/types.js"

export type V2Part = Record<string, any>
export type V2Message = { id?: string; role: string; content: V2Part[]; metadata?: unknown }

/** ToolResultValue { type: "text"|"json"|"error"|"content", value } → plain text + isError */
function resultText(result: any): { text: string; isError: boolean } {
  if (result == null || typeof result !== "object") {
    return { text: String(result ?? ""), isError: false }
  }
  const { type, value } = result as { type?: string; value?: any }
  if (type === "error") {
    const msg =
      value && typeof value === "object"
        ? (value.error?.message ?? value.message ?? JSON.stringify(value))
        : String(value)
    return { text: String(msg), isError: true }
  }
  if (type === "text") return { text: typeof value === "string" ? value : String(value ?? ""), isError: false }
  if (type === "content") {
    const parts = Array.isArray(value) ? value : []
    const text = parts
      .map((p: any) =>
        p?.type === "text" ? p.text : p?.type === "file" ? `[file ${p.name ?? p.uri}]` : "",
      )
      .join("\n")
    return { text, isError: false }
  }
  try {
    return { text: JSON.stringify(value), isError: false }
  } catch {
    return { text: String(value), isError: false }
  }
}

/** is this part an attachment (either the ai `media` part or an sdk `file` part)? */
function isAttachment(p: V2Part): boolean {
  return p?.type === "media" || p?.type === "file"
}

export function toLibraryMessages(v2: readonly V2Message[]): LibMessage[] {
  return (v2 ?? []).map((m) => {
    const content = Array.isArray(m.content) ? m.content : []
    const textParts = content
      .filter((p) => p?.type === "text")
      .map((p) => String(p.text ?? ""))
    const attachments = content.filter(isAttachment)
    if (attachments.length > 0) {
      const names = attachments
        .map((p) => p.filename ?? p.name ?? p.url ?? p.media?.source?.url)
        .filter((v): v is string => typeof v === "string" && v.length > 0)
        .slice(0, 3)
      textParts.push(
        `[${attachments.length} attachment${attachments.length > 1 ? "s" : ""} not shown${
          names.length ? `: ${names.join(", ")}` : ""
        }]`,
      )
    }
    const text = textParts.join("\n")
    const toolUses: ToolUse[] = content
      .filter((p) => p?.type === "tool-call")
      .map((p) => ({ tool_use_id: String(p.id ?? ""), tool: String(p.name ?? ""), input: (p.input ?? {}) }))
    const toolResults: ToolResult[] = content
      .filter((p) => p?.type === "tool-result")
      .map((p) => {
        const r = resultText(p.result)
        return { tool_use_id: String(p.id ?? ""), text: r.text, isError: r.isError }
      })
    const msg: LibMessage = { role: m.role === "assistant" ? "assistant" : "user", text, toolUses }
    if (toolResults.length) msg.toolResults = toolResults
    return msg
  })
}

const MAX_INPUT_CHARS = 300

/** NOTE: avoid `[...]` — the chat renders it as markdown and eats the brackets. */
function callLine(u: ToolUse): string {
  let input: string
  try {
    input = JSON.stringify(u.input ?? {})
  } catch {
    input = String(u.input)
  }
  if (input.length > MAX_INPUT_CHARS) input = `${input.slice(0, MAX_INPUT_CHARS)}…(${input.length} chars)`
  return `call ${u.tool_use_id} ${u.tool} ${input}`
}

/**
 * Apply decisions to the **request view** (v2 messages) without touching stored history:
 * drop a call → remove its tool-call part and the paired tool-result part; drop a result → replace the
 * result body with a bounded head. Messages left with no parts are dropped from this request only.
 */
export function applyDecisionsToV2(
  v2: readonly V2Message[],
  decisions: readonly { id: string; action: string }[],
  calls: readonly { id: string; tool_use_id: string }[],
  truncateHeadChars: number,
): V2Message[] {
  const useByCall = new Map(calls.map((c) => [c.id, c.tool_use_id]))
  const actionByUse = new Map<string, string>()
  for (const d of decisions) {
    if (d.action === "keep") continue
    const use = useByCall.get(d.id)
    if (use) actionByUse.set(use, d.action)
  }
  if (actionByUse.size === 0) return v2 as V2Message[]

  const out: V2Message[] = []
  for (const m of v2) {
    const content = Array.isArray(m.content) ? m.content : []
    const kept: V2Part[] = []
    let changed = false
    for (const p of content) {
      const id = typeof p?.id === "string" ? p.id : ""
      const action = actionByUse.get(id)
      if (p?.type === "tool-call" && action === "drop_call") continue
      if (p?.type === "tool-result") {
        if (action === "drop_call") continue
        if (action === "drop_result") {
          const full = resultText(p.result).text
          const head = full.length > truncateHeadChars ? full.slice(0, truncateHeadChars) : full
          const note =
            full.length > truncateHeadChars
              ? `\n…(${full.length} chars truncated by Jev; re-run the tool if needed)`
              : ""
          kept.push({ ...p, result: { type: "text", value: `${head}${note}` } })
          changed = true
          continue
        }
      }
      kept.push(p)
    }
    if (kept.length === 0) continue // this request view loses an empty message; stored history is untouched
    out.push(changed || kept.length !== content.length ? { ...m, content: kept } : m)
  }
  return out
}

export interface SummaryOptions {
  /** leading stats line */
  header?: string
  /** what to do with tool results: none | size | head | full */
  results?: "none" | "size" | "head" | "full"
  /** when results = "head", how many chars to keep */
  resultChars?: number
  /** include tool call lines (name + input) */
  calls?: boolean
  /** include message prose */
  text?: boolean
}

/**
 * The summary becomes v2's conversation checkpoint. `minimal` (header only) is the smallest — remember
 * that this is the model's context, so "no content" means the model forgets the earlier conversation.
 */
export function renderSummary(messages: readonly LibMessage[], opts: SummaryOptions = {}): string {
  const { header, results = "full", resultChars = 300, calls = true, text: includeText = true } = opts
  const lines: string[] = []
  if (header) lines.push(header)

  for (const m of messages) {
    if (includeText) {
      const t = m.text?.trim() ?? ""
      if (t) {
        const isCheckpoint = /<conversation-checkpoint>|<summary>/i.test(t)
        lines.push(`${m.role}: ${isCheckpoint ? "(prior compaction checkpoint elided)" : t}`)
      }
    }
    if (calls) for (const u of m.toolUses) lines.push(callLine(u))
    if (results !== "none") {
      for (const r of m.toolResults ?? []) {
        const tag = `result ${r.tool_use_id}${r.isError ? " (error)" : ""}`
        if (results === "size") {
          lines.push(`${tag}: (${r.text.length} chars)`)
          continue
        }
        let body = r.text
        if (results === "head" && body.length > resultChars) {
          body = `${body.slice(0, resultChars)}…(${body.length} chars)`
        }
        lines.push(`${tag}: ${body}`)
      }
    }
  }
  return lines.join("\n")
}
