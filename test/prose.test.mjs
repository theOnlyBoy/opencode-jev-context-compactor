import assert from "node:assert/strict"
import { positionBar, proseDrops } from "../dist/prose.js"

let passed = 0
const ok = (name) => {
  passed++
  console.log(`ok: ${name}`)
}

// ---- positionBar -----------------------------------------------------------
assert.equal(positionBar(0, [[0, 1]]), "", "empty bar when total <= 0")
ok("positionBar: empty for zero total")

const bar = positionBar(100, [[40, 60]], 10)
assert.equal(bar.length, 10, "bar is `width` cells")
assert.equal(bar, "░░░░▓▓░░░░", "span 40-60 maps to the middle cells")
ok("positionBar: maps a span to the right cells")

assert.equal(positionBar(100, [], 10), "░░░░░░░░░░", "all kept when no spans")
ok("positionBar: all-kept with no spans")

assert.equal(positionBar(10, [[0, 10]], 5), "▓▓▓▓▓", "a full span fills the bar")
ok("positionBar: full span fills")

// ---- proseDrops ------------------------------------------------------------
const asks = []
const fakeAsker = (noulByIndex) => ({
  async ask(_state, questions) {
    asks.push(Object.keys(questions))
    const answers = {}
    for (const key of Object.keys(questions)) {
      const i = Number(key.replace("drop_m", ""))
      answers[key] = { noul: noulByIndex(i) }
    }
    return { answers }
  },
})

const long = (n) => "x".repeat(n)
const lib = [
  { role: "user", text: long(500) }, // 0 candidate
  { role: "assistant", text: long(500) }, // 1 candidate
  { role: "user", text: "short" }, // 2 too small
  { role: "assistant", text: long(500), toolUses: [{}] }, // 3 has tools
  { role: "user", text: long(500) }, // 4 protected tail
  { role: "assistant", text: long(500) }, // 5 protected tail
]

// everything unnecessary -> only the two eligible indices drop
let drops = await proseDrops(fakeAsker(() => 0.9), lib, 2)
assert.deepEqual([...drops].sort(), [0, 1], "drops only eligible, non-tool, non-tail messages")
ok("proseDrops: eligibility (size / tools / protected tail)")

// threshold respected
drops = await proseDrops(fakeAsker(() => 0.5), lib, 2)
assert.equal(drops.size, 0, "nothing drops below threshold")
ok("proseDrops: threshold respected")

drops = await proseDrops(fakeAsker((i) => (i === 0 ? 0.95 : 0.1)), lib, 2)
assert.deepEqual([...drops], [0], "only messages Jev is sure about drop")
ok("proseDrops: per-message decision")

// no candidates -> no Jev call
asks.length = 0
drops = await proseDrops(fakeAsker(() => 0.9), [{ role: "user", text: "short" }], 2)
assert.equal(drops.size, 0, "no candidates, no drops")
assert.equal(asks.length, 0, "no Jev call when there are no candidates")
ok("proseDrops: no candidates -> no Jev call")

console.log(`\n${passed} checks passed`)
