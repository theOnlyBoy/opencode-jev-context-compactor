#!/usr/bin/env node
/** Unit test for the per-tool_use_id decision cache: a judged call is never judged twice. */
import assert from "node:assert"

const { wrapCache } = await import("../dist/index.js")

let baseCalls = 0
const base = {
  async ask(_state, questions) {
    baseCalls++
    const answers = {}
    for (const k of Object.keys(questions)) answers[k] = { noul: 0.2 }
    return { answers }
  },
}

const calls = [{ id: "t1", tool_use_id: "use1" }]
const idToUse = new Map([["t1", "use1"]])
const cache = new Map()
const asker = wrapCache(base, calls, idToUse, cache)

const q = { call_t1: { type: "noul" }, result_t1: { type: "noul" } }

const first = await asker.ask({}, q)
assert.equal(baseCalls, 1, "first ask hits the model")
assert.equal(first.answers.call_t1.noul, 0.2)

const second = await asker.ask({}, q)
assert.equal(baseCalls, 1, "second ask hits the cache — no model call")
assert.equal(second.answers.call_t1.noul, 0.2, "cached answer returned")

// a brand-new call still reaches the model
const more = wrapCache(base, [{ id: "t2", tool_use_id: "use2" }], new Map([["t2", "use2"]]), cache)
await more.ask({}, { call_t2: { type: "noul" }, result_t2: { type: "noul" } })
assert.equal(baseCalls, 2, "uncached call reaches the model")

console.log("ok: cache — a judged call is never judged twice")
