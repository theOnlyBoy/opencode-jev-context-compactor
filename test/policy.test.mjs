#!/usr/bin/env node
/** Unit tests for the deletion policy — no network, no OpenCode. Run after `npm run build`. */
import assert from "node:assert"

const { applyPolicy } = await import("../dist/policy.js")

const msg = (role, text = "", toolUses = [], toolResults) => {
  const m = { role, text, toolUses }
  if (toolResults) m.toolResults = toolResults
  return m
}
const call = (uid, tool, input) => ({ tool_use_id: uid, tool, input })
const res = (uid, text, isError = false) => ({ tool_use_id: uid, text, isError })

const messages = [
  msg("user", "start"),
  msg("assistant", "", [call("A", "read", { path: "src/x.ts" })]),
  msg("user", "", [], [res("A", "x-content")]),
  msg("assistant", "", [call("B", "bash", { command: "npm test" })]),
  msg("user", "", [], [res("B", "boom", true)]),
  msg("assistant", "", [call("C", "bash", { command: "npm test" })]),
  msg("user", "", [], [res("C", "ok")]),
  msg("assistant", "", [call("D", "read", { path: "src/y.ts" })]),
  msg("user", "", [], [res("D", "y-content")]),
  msg("assistant", "", [call("E", "read", { path: "src/y.ts" })]),
  msg("user", "", [], [res("E", "y-content-2")]),
]

// the engine, being probabilistic, said "delete everything"
const decisions = ["t1", "t2", "t3", "t4", "t5"].map((id) => ({
  id,
  tool: "x",
  keepCall: 0.1,
  keepResult: 0.1,
  action: "drop_call",
  reason: "call_dropped",
}))

const opts = { preserveRecentMessages: 0, truncateHeadChars: 300, smallResultChars: 0 }
const out = applyPolicy(messages, decisions, opts)
const byId = new Map(out.decisions.map((d) => [d.id, d]))

// t2 = errored bash, then a successful identical call → error-resolved (delete)
// t4 = earlier identical read → superseded (delete)
// t1, t3, t5 = probabilistic only → downgraded to truncate
assert.equal(out.stats.errorResolved, 1, "B should be error-resolved")
assert.equal(out.stats.superseded, 1, "D should be superseded")
assert.equal(out.stats.downgraded, 3, "A, C, E should be downgraded")
assert.equal(byId.get("t2").action, "drop_call", "deterministic: error-resolved deletes")
assert.equal(byId.get("t4").action, "drop_call", "deterministic: superseded deletes")
assert.equal(byId.get("t1").action, "drop_result", "probabilistic: truncate, never delete")
assert.equal(byId.get("t3").action, "drop_result", "probabilistic: truncate, never delete")
assert.equal(byId.get("t5").action, "drop_result", "probabilistic: truncate, never delete")

// small-result guard: nothing is touched
const small = applyPolicy(messages, decisions, { ...opts, smallResultChars: 1000 })
assert.equal(small.stats.hardDrops, 0, "small results must not be deleted")
assert.ok(small.decisions.every((d) => d.action === "keep"), "small results are kept")

// protected tools / files are never touched (even when they would be superseded)
const prot = applyPolicy(messages, decisions, { ...opts, protectedTools: ["bash"] })
const protById = new Map(prot.decisions.map((d) => [d.id, d]))
assert.equal(protById.get("t2").action, "keep", "protected tool: error-resolved must not delete")

const protFile = applyPolicy(messages, decisions, { ...opts, protectedFiles: ["src/**"] })
const protFileById = new Map(protFile.decisions.map((d) => [d.id, d]))
assert.equal(protFileById.get("t4").action, "keep", "protected file: superseded must not delete")
assert.ok(protFile.stats.protected >= 2, "protected count should reflect kept calls")

console.log("ok: policy deletes only on deterministic evidence; small results and protected targets untouched")
