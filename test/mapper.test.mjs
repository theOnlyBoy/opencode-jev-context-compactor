#!/usr/bin/env node
/** Unit tests for the v2 ⇄ engine mapper. No network. Run after `npm run build`. */
import assert from "node:assert"

const { toLibraryMessages, renderSummary } = await import("../dist/mapper.js")

// role mapping: anything that is not assistant becomes user (tool results ride on a user message)
const roles = toLibraryMessages([
  { role: "assistant", content: [{ type: "text", text: "hi" }] },
  { role: "tool", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "ok" } }] },
  { role: "user", content: [{ type: "text", text: "yo" }] },
])
assert.deepEqual(roles.map((m) => m.role), ["assistant", "user", "user"])

// tool-call / tool-result pairing is preserved by id
const paired = toLibraryMessages([
  { role: "assistant", content: [{ type: "tool-call", id: "call_1", name: "read", input: { path: "src/x.ts" } }] },
  { role: "tool", content: [{ type: "tool-result", id: "call_1", name: "read", result: { type: "text", value: "x" } }] },
])
assert.equal(paired[0].toolUses[0].tool_use_id, "call_1")
assert.equal(paired[0].toolUses[0].tool, "read")
assert.equal(paired[1].toolResults[0].tool_use_id, "call_1")

// result value kinds
const kinds = toLibraryMessages([
  { role: "tool", content: [
    { type: "tool-result", id: "e", name: "bash", result: { type: "error", value: { error: { message: "boom" } } } },
    { type: "tool-result", id: "j", name: "gql", result: { type: "json", value: { a: 1 } } },
    { type: "tool-result", id: "c", name: "read", result: { type: "content", value: [{ type: "text", text: "hi" }, { type: "file", name: "a.png", uri: "u" }] } },
  ] },
])
const [errR] = kinds[0].toolResults.filter((r) => r.tool_use_id === "e")
assert.equal(errR.isError, true)
assert.equal(errR.text, "boom")
const [jsonR] = kinds[0].toolResults.filter((r) => r.tool_use_id === "j")
assert.equal(jsonR.text, '{"a":1}')
const [contentR] = kinds[0].toolResults.filter((r) => r.tool_use_id === "c")
assert.ok(contentR.text.includes("hi") && contentR.text.includes("[file a.png]"), "content parts render")

// M1: attachments are noted — both the ai `media` part and the sdk `file` part
const withAttachments = toLibraryMessages([
  { role: "user", content: [
    { type: "text", text: "look" },
    { type: "file", filename: "screenshot.png", mime: "image/png", url: "u" },
    { type: "media" },
  ] },
])
assert.ok(withAttachments[0].text.includes("attachment"), "attachment marker present")
assert.ok(withAttachments[0].text.includes("screenshot.png"), "attachment filename present")

// M2: the summary carries every surviving call's name + input, and its result
const summary = renderSummary([
  { role: "assistant", text: "looking", toolUses: [{ tool_use_id: "t1", tool: "read", input: { path: "src/x.ts" } }] },
  { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "t1", text: "x-content" }] },
])
assert.ok(summary.includes("call t1 read"), "call line with name")
assert.ok(summary.includes('"path":"src/x.ts"'), "call line with input")
assert.ok(summary.includes("result t1: x-content"), "result line")

// a prior checkpoint must be elided, never nested (it would grow without bound)
const cp = renderSummary([
  { role: "user", text: "<conversation-checkpoint>\n<summary>old stuff</summary>", toolUses: [] },
])
assert.ok(cp.includes("prior compaction checkpoint elided"), "checkpoint text is elided")
assert.ok(!cp.includes("old stuff"), "old checkpoint body is not nested")

// stats style: header-led, results by size only
const stats = renderSummary(
  [{ role: "user", text: "hi", toolUses: [], toolResults: [{ tool_use_id: "t1", text: "x".repeat(500) }] }],
  { header: "Jev compaction -50%", results: "size" },
)
assert.ok(stats.startsWith("Jev compaction -50%"), "header leads")
assert.ok(stats.includes("(500 chars)"), "stats style lists result size, not body")

// minimal style: header only — literally no content
const minimal = renderSummary(
  [{ role: "user", text: "hi", toolUses: [], toolResults: [{ tool_use_id: "t1", text: "x" }] }],
  { header: "Jev compaction -50%", results: "none", calls: false, text: false },
)
assert.equal(minimal, "Jev compaction -50%", "minimal is header only")

console.log("ok: mapper — roles, pairing, result kinds, attachments, calls, elision, stats style")
