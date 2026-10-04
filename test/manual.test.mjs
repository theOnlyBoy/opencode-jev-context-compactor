#!/usr/bin/env node
/**
 * Hook-level integration test for the MANUAL `/compress` pipeline, with a mock Jev asker (no network).
 * Mirrors what index.ts does in the `context` hook: map → prose drop → engine → policy → apply to v2.
 * Run after `npm run build`.
 */
import assert from "node:assert/strict"
import { toLibraryMessages, applyDecisionsToV2 } from "../dist/mapper.js"
import { applyPolicy, totalChars } from "../dist/policy.js"
import { wrapAsker } from "../dist/facts.js"
import { proseDrops, positionBar } from "../dist/prose.js"
import { compact } from "../dist/vendor/fast-jev-compaction/src/compact.js"
import { collectToolCalls } from "../dist/vendor/fast-jev-compaction/src/state.js"

let passed = 0
const ok = (name) => {
  passed++
  console.log(`ok: ${name}`)
}

// deterministic asker: keep calls, drop results, drop prose
const mockJev = {
  async ask(_state, questions) {
    const answers = {}
    for (const k of Object.keys(questions)) {
      if (k.startsWith("call_t")) answers[k] = { noul: 0.9 }
      else if (k.startsWith("result_t")) answers[k] = { noul: 0.05 }
      else if (k.startsWith("drop_m")) answers[k] = { noul: 0.9 }
      else answers[k] = { noul: 0.5 }
    }
    return { answers }
  },
}

const prose = (n) => `PROSE ${"word ".repeat(n)}`
const v2Fixture = () => [
  { role: "system", content: [{ type: "text", text: "system prompt" }] },
  { role: "user", content: [{ type: "text", text: prose(100) }] }, // 1: droppable prose
  { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { path: "big/file.md" } }] },
  { role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "Z".repeat(5000) } }] },
  { role: "assistant", content: [{ type: "text", text: "summary done" }] },
  { role: "user", content: [{ type: "text", text: "tail" }] },
]

// --- 1. prose pass drops the eligible message, no Jev call when none qualify ----
let v2 = v2Fixture()
let lib = toLibraryMessages(v2)
let drops = await proseDrops(mockJev, lib, 2)
assert.deepEqual([...drops], [1], "prose pass drops the one eligible prose message")
ok("manual: prose pass selects the eligible message")

const before = totalChars(lib)
v2 = v2.filter((_, i) => !drops.has(i))
lib = toLibraryMessages(v2)
assert.ok(totalChars(lib) < before, "dropping prose reduces the request size")
ok("manual: dropped prose shrinks the request")

// --- 2. engine + policy: drop the bulky tool result ----------------------------
const preserve = 0 // manual compress keeps nothing recent
const calls = collectToolCalls(lib, preserve)
const asker = wrapAsker(mockJev, { strategy: "judgement", messages: lib, preserveRecentMessages: preserve }).asker
const engine = await compact(lib, asker, { keepThreshold: 0.15, preserveRecentMessages: preserve })
const policy = applyPolicy(lib, engine.decisions, {
  preserveRecentMessages: preserve,
  truncateHeadChars: 300,
  smallResultChars: 0,
  protectedTools: [],
  protectedFiles: [],
})
const dropped = policy.decisions.filter((d) => d.action === "drop_result" || d.action === "drop_call")
assert.ok(dropped.length >= 1, "the bulky result is dropped/truncated")
ok("manual: engine + policy drop the bulky result")

// --- 3. apply to the v2 request view (non-destructive clone) -------------------
const pruned = applyDecisionsToV2(v2, policy.decisions, calls, 300)
const truncated = JSON.stringify(pruned).includes("truncated by Jev")
assert.ok(truncated, "the applied request view shows the truncation note")
assert.ok(JSON.stringify(v2Fixture()).includes("Z".repeat(5000)), "the original history is untouched")
ok("manual: truncation applied to the request view only")

// --- 4. position bar marks where it cut ----------------------------------------
const callById = new Map(calls.map((c) => [c.id, c]))
const spans = dropped
  .map((d) => callById.get(d.id))
  .filter(Boolean)
  .map((c) => [c.callIndex ?? 0, c.resultIndex ?? 0])
const bar = positionBar(lib.length, spans)
assert.equal(bar.length, 20, "bar is fixed width")
assert.ok(bar.includes("▓"), "bar marks a compressed position")
ok("manual: position bar marks the compressed region")

console.log(`\n${passed} checks passed`)
