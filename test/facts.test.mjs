#!/usr/bin/env node
/** Unit tests for reference detection (factsFirst). No network. Run after `npm run build`. */
import assert from "node:assert"

const { referencedCallIds } = await import("../dist/facts.js")

/** a call + its result, then later prose that may reference the call's target */
const scenario = (input, prose) => [
  { role: "assistant", text: "", toolUses: [{ tool_use_id: "c1", tool: "read", input }] },
  { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "c1", text: "x" }] },
  { role: "user", text: prose, toolUses: [] },
]

// a generic word that merely recurs in prose must NOT pin the call
const generic = referencedCallIds(scenario({ command: "npm test" }, "did the test pass?"), 0)
assert.equal(generic.size, 0, "generic word 'test' is not a reference")

// a path / identifier that appears later IS a reference
const path = referencedCallIds(scenario({ path: "src/config.ts" }, "what does src/config.ts set?"), 0)
assert.ok(path.has("t1"), "path target pins the call")

const id = referencedCallIds(scenario({ orderId: "ORD-4412" }, "has ORD-4412 shipped?"), 0)
assert.ok(id.has("t1"), "id target pins the call")

const absent = referencedCallIds(scenario({ path: "src/config.ts" }, "carry on then"), 0)
assert.equal(absent.size, 0, "no reference, no pin")

console.log("ok: facts — targets pin, generic words do not")
