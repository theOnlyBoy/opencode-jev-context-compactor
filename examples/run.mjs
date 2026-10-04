#!/usr/bin/env node
/**
 * Standalone harness for jev-compaction-v2 — no OpenCode needed.
 *
 *   node examples/run.mjs                         # judgement, offline mock
 *   node examples/run.mjs --strategy=factsFirst    # facts-first, offline mock
 *   node examples/run.mjs --live                   # real Jev call (needs TYPESAFE_API_KEY)
 *
 * Run after `npm run build` (imports ../dist).
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const HERE = dirname(fileURLToPath(import.meta.url))
const LIVE = process.argv.includes("--live")
const strategy = (process.argv.find((a) => a.startsWith("--strategy="))?.split("=")[1]) ?? "judgement"

const { toLibraryMessages, renderSummary } = await import("../dist/mapper.js")
const { compact, messageChars } = await import(
  "../dist/vendor/fast-jev-compaction/src/compact.js",
)
const { JevClient } = await import("../dist/vendor/fast-jev-compaction/src/client.js")
const { wrapAsker } = await import("../dist/facts.js")
const { applyPolicy, totalChars } = await import("../dist/policy.js")

const fileArg = process.argv.find((a) => a.startsWith("--file="))?.split("=")[1]
const fixture = JSON.parse(readFileSync(fileArg ?? join(HERE, "customer-booking.messages.json"), "utf8"))
const lib = toLibraryMessages(fixture.messages)

/** offline stand-in: drop calls older than the newest 6, keep the rest — deterministic, no cost */
function mockAsker() {
  return {
    async ask(_state, questions) {
      const answers = {}
      for (const [name, q] of Object.entries(questions)) {
        if (q.type === "noul") answers[name] = { noul: /t1|t2|t3/.test(name) ? 0.08 : 0.92 }
        else if (q.type === "choice") answers[name] = { choice: Object.keys(q.criteria)[0], confidence: 0.9, probabilities: {} }
        else if (q.type === "score") answers[name] = { score: 1, confidence: 0.8, probabilities: {} }
      }
      return { model: "mock", answers }
    },
  }
}

const inputChars = lib.reduce((n, m) => n + messageChars(m), 0)
const cfg = { minReductionRatio: 0, preserveRecentMessages: 6, keepThreshold: 0.15, minResultChars: 0 }

console.log(`\n=== INPUT (${strategy}${LIVE ? ", live" : ", mock"}) ===`)
console.log(`messages: ${lib.length}   chars: ${inputChars}`)
for (const [i, m] of lib.entries()) {
  const head = (m.text || "").replace(/\s+/g, " ").slice(0, 62)
  const tools = m.toolUses.map((t) => `call:${t.tool}`).join(" ")
  const results = (m.toolResults || []).map((r) => `result:${r.text.length}c${r.isError ? "(err)" : ""}`).join(" ")
  console.log(`  ${String(i).padStart(2)} ${m.role.padEnd(9)} ${head}${tools || results ? "  [" + [tools, results].filter(Boolean).join(" ") + "]" : ""}`)
}

if (LIVE && !process.env.TYPESAFE_API_KEY) {
  console.error("\n--live needs TYPESAFE_API_KEY in the environment. Aborting.")
  process.exit(1)
}

const base = LIVE ? new JevClient({ apiKey: process.env.TYPESAFE_API_KEY, model: process.env.FAST_JEV_MODEL }) : mockAsker()
const prepared = wrapAsker(base, { strategy, messages: lib, preserveRecentMessages: cfg.preserveRecentMessages })
const asker = prepared.asker
console.log(`strategy: requested=${strategy}  effective=${prepared.effective}  pinnedByReference=${prepared.pinned}`)

const result = await compact(lib, asker, cfg)
const pol = applyPolicy(lib, result.decisions, {
  preserveRecentMessages: cfg.preserveRecentMessages,
  truncateHeadChars: cfg.truncateHeadChars ?? 300,
  smallResultChars: cfg.smallResultChars ?? 0,
})
const { stats } = result
const before = totalChars(lib)
const after = totalChars(pol.messages)
const ratio = before > 0 ? (before - after) / before : 0

console.log(`\n=== RESULT (${LIVE ? "LIVE Jev" : "mock"}, ${strategy}) ===`)
console.log(
  `reduction: ${(ratio * 100).toFixed(1)}%   chars ${stats.charsBefore} → ${stats.charsAfter}` +
    `   kept ${stats.kept}  resultsDropped ${stats.resultsDropped}  callsDropped ${stats.callsDropped}  pinned ${stats.pinned}`,
)
console.log(`state ~${stats.stateTokens} tokens (${stats.stateStage || "n/a"})   requests ${stats.requests}   ${stats.ms}ms`)
for (const d of pol.decisions) {
  console.log(`  ${d.tool.padEnd(16)} ${d.reason.padEnd(14)} call=${d.keepCall.toFixed(2)} result=${d.keepResult.toFixed(2)}`)
}

const header =
  `Jev compaction -${Math.round(ratio * 100)}% · kept ${stats.kept} · cut ${pol.stats.downgraded} · drop ${pol.stats.hardDrops} · ${stats.ms}ms`
const summary = renderSummary(pol.messages, { header, includeResults: false })
const outDir = join(HERE, "out")
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const outFile = join(outDir, `run-${LIVE ? "live" : "mock"}-${strategy}-${stamp}.md`)
writeFileSync(
  outFile,
  [
    `# jev-compaction-v2 — ${LIVE ? "LIVE" : "mock"} / ${strategy}`,
    "",
    `- messages: ${lib.length} → ${stats.messagesAfter}`,
    `- chars: ${stats.charsBefore} → ${stats.charsAfter} (reduction ${(ratio * 100).toFixed(1)}%)`,
    `- kept ${stats.kept} · resultsDropped ${stats.resultsDropped} · callsDropped ${stats.callsDropped} · pinned ${stats.pinned}`,
    `- state ~${stats.stateTokens} tokens (${stats.stateStage || "n/a"}) · requests ${stats.requests} · ${stats.ms}ms`,
    `- strategy: requested=${strategy} effective=${prepared.effective} pinned=${prepared.pinned}`,
    "",
    "## Decisions",
    ...pol.decisions.map((d) => `- \`${d.tool}\` — ${d.reason} (call ${d.keepCall.toFixed(2)}, result ${d.keepResult.toFixed(2)})`),
    "",
    "## Compaction summary",
    "",
    "```",
    summary,
    "```",
    "",
  ].join("\n"),
)
console.log(`\nreport: ${outFile}`)
