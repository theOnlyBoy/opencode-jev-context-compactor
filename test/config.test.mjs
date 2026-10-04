#!/usr/bin/env node
/** Regression: config precedence must be options > env > defaults (the audit's P1). Run after build. */
import assert from "node:assert/strict"
import { resolveConfig } from "../dist/index.js"

let passed = 0
const ok = (name) => {
  passed++
  console.log(`ok: ${name}`)
}

const KEY = "FAST_JEV_PRUNE"
const saved = process.env[KEY]

try {
  // explicit option wins over the environment
  process.env[KEY] = "0"
  assert.equal(resolveConfig({ prune: true }).prune, true, "options.prune:true must beat FAST_JEV_PRUNE=0")
  ok("config: options.prune:true overrides FAST_JEV_PRUNE=0")

  // env applies when no explicit option
  assert.equal(resolveConfig({}).prune, false, "FAST_JEV_PRUNE=0 disables when no option given")
  ok("config: FAST_JEV_PRUNE=0 disables by default")

  // default when nothing set
  delete process.env[KEY]
  assert.equal(resolveConfig({}).prune, true, "default is on")
  ok("config: default prune on")

  // explicit false
  assert.equal(resolveConfig({ prune: false }).prune, false, "options.prune:false disables")
  ok("config: options.prune:false disables")
} finally {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
}

console.log(`\n${passed} checks passed`)
