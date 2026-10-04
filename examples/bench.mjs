#!/usr/bin/env node
/**
 * Bench: every scenario × every strategy, through the real pipeline.
 *
 *   node examples/bench.mjs            # real Jev calls (needs TYPESAFE_API_KEY)
 *   node examples/bench.mjs --mock     # offline, no key
 *
 * Correctness metric: `refDropped` = calls whose target is provably referenced later but which the
 * strategy dropped. It should be 0; anything else is a strategy letting a real reference die.
 *
 * Run after `npm run build` (imports ../dist).
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const HERE = dirname(fileURLToPath(import.meta.url))
const LIVE = !process.argv.includes("--mock")
const STRATEGIES = ["judgement", "factsFirst", "deterministic", "auto"]

const { toLibraryMessages } = await import("../dist/mapper.js")
const { compact } = await import("../dist/vendor/fast-jev-compaction/src/compact.js")
const { JevClient } = await import("../dist/vendor/fast-jev-compaction/src/client.js")
const { wrapAsker, referencedCallIds } = await import("../dist/facts.js")
const { applyPolicy, totalChars } = await import("../dist/policy.js")

if (LIVE && !process.env.TYPESAFE_API_KEY) {
  console.error("LIVE bench needs TYPESAFE_API_KEY (or pass --mock).")
  process.exit(1)
}

function mockAsker() {
  return {
    async ask(_s, questions) {
      const answers = {}
      for (const [k, q] of Object.entries(questions)) if (q.type === "noul") answers[k] = { noul: 0.1 }
      return { model: "mock", answers }
    },
  }
}
/** count actual model calls */
function counting(base) {
  let calls = 0
  return { asker: { async ask(s, q) { calls++; return base.ask(s, q) } }, count: () => calls }
}

const dir = join(HERE, "scenarios")
const files = readdirSync(dir).filter((f) => f.endsWith(".messages.json")).sort()
// preserveRecentMessages is 2 here (not the default) so short transcripts still expose candidates;
// minResultChars is 0 because the fixtures are small. keepThreshold matches the plugin default.
const cfg = { minReductionRatio: 0, preserveRecentMessages: 2, keepThreshold: 0.15, minResultChars: 0 }

const rows = []
for (const file of files) {
  const scenario = JSON.parse(readFileSync(join(dir, file), "utf8"))
  const lib = toLibraryMessages(scenario.messages)
  const referenced = referencedCallIds(lib, cfg.preserveRecentMessages)

  for (const strategy of STRATEGIES) {
    const base = LIVE ? new JevClient({ apiKey: process.env.TYPESAFE_API_KEY, model: process.env.FAST_JEV_MODEL }) : mockAsker()
    const counter = counting(base)
    const prepared = wrapAsker(counter.asker, { strategy, messages: lib, preserveRecentMessages: cfg.preserveRecentMessages })
    const t0 = Date.now()
    const result = await compact(lib, prepared.asker, cfg)
    const ms = Date.now() - t0

    const pol = applyPolicy(lib, result.decisions, {
      preserveRecentMessages: cfg.preserveRecentMessages,
      truncateHeadChars: 300,
      smallResultChars: 0,
    })
    const before = totalChars(lib)
    const after = totalChars(pol.messages)
    const reduction = before > 0 ? (before - after) / before : 0

    const byId = new Map(pol.decisions.map((d) => [d.id, d]))
    let refDropped = 0
    let refTruncated = 0
    for (const id of referenced) {
      const d = byId.get(id)
      if (!d) continue
      if (d.action === "drop_call") refDropped++
      else if (d.action === "drop_result") refTruncated++
    }

    rows.push({
      topic: scenario.topic ?? file,
      strategy,
      effective: prepared.effective,
      pinned: prepared.pinned,
      reduction: +(reduction * 100).toFixed(1),
      modelCalls: counter.count(),
      ms,
      refTotal: referenced.size,
      refDropped,
      refTruncated,
    })
  }
}

const head = ["topic", "strategy", "eff", "pinned", "reduction%", "modelCalls", "ms", "ref/kept", "refCut", "refDropped"]
const cellKey = (h) =>
  ({ "reduction%": "reduction", "ref/kept": "refTotal", eff: "effective" }[h] ?? h)
const widths = head.map((h) => Math.max(h.length, ...rows.map((r) => String(r[cellKey(h)]).length)))
const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join("  ")

console.log(`\n${LIVE ? "LIVE Jev" : "mock"} bench — ${rows.length} runs\n`)
console.log(line(head))
for (const r of rows) {
  console.log(line([
    r.topic, r.strategy, r.effective, r.pinned, r.reduction, r.modelCalls, r.ms,
    `${r.refTotal}/${r.refTotal - r.refDropped}`, r.refTruncated, r.refDropped,
  ]))
}
const totalDropped = rows.reduce((n, r) => n + r.refDropped, 0)
console.log(`\nreferenced-but-dropped (should be 0): ${totalDropped}`)
const byStrategy = STRATEGIES.map((s) => {
  const rs = rows.filter((r) => r.strategy === s)
  return `${s}: ${rs.reduce((n, r) => n + r.refDropped, 0)} dropped / ${rs.reduce((n, r) => n + r.modelCalls, 0)} calls`
})
console.log(byStrategy.join("   ·   "))

const outDir = join(HERE, "out")
mkdirSync(outDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const outFile = join(outDir, `bench-${LIVE ? "live" : "mock"}-${stamp}.md`)
writeFileSync(
  outFile,
  [
    `# Bench — ${LIVE ? "LIVE Jev" : "mock"} — ${stamp}`,
    "",
    "| " + head.join(" | ") + " |",
    "|" + head.map(() => "---").join("|") + "|",
    ...rows.map((r) => `| ${[r.topic, r.strategy, r.effective, r.pinned, r.reduction, r.modelCalls, r.ms, `${r.refTotal}/${r.refTotal - r.refDropped}`, r.refTruncated, r.refDropped].join(" | ")} |`),
    "",
    `**referenced-but-dropped total:** ${totalDropped} (should be 0)`,
    "",
  ].join("\n"),
)
console.log(`report: ${outFile}\n`)
