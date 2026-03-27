import { describe, it } from "node:test"
import assert from "node:assert"

import { parseCliArgs } from "../src/cli.js"

describe("parseCliArgs", () => {
  it("returns defaults when no flags are provided", () => {
    const result = parseCliArgs([])
    assert.strictEqual(result.showGitDiff, false)
    assert.strictEqual(result.concurrency, 10)
  })

  it("parses --show-diff as showGitDiff", () => {
    const result = parseCliArgs(["--show-diff"])
    assert.strictEqual(result.showGitDiff, true)
  })

  it("parses --diff as showGitDiff", () => {
    const result = parseCliArgs(["--diff"])
    assert.strictEqual(result.showGitDiff, true)
  })

  it("parses --show-git-diff as showGitDiff", () => {
    const result = parseCliArgs(["--show-git-diff"])
    assert.strictEqual(result.showGitDiff, true)
  })

  it("parses --concurrency with a valid number", () => {
    const result = parseCliArgs(["--concurrency", "5"])
    assert.strictEqual(result.concurrency, 5)
  })

  it("falls back to 10 for non-numeric --concurrency", () => {
    const result = parseCliArgs(["--concurrency", "abc"])
    assert.strictEqual(result.concurrency, 10)
  })

  it("falls back to 10 for zero --concurrency", () => {
    const result = parseCliArgs(["--concurrency", "0"])
    assert.strictEqual(result.concurrency, 10)
  })

  it("falls back to 10 for negative --concurrency", () => {
    const result = parseCliArgs(["--concurrency", "-3"])
    assert.strictEqual(result.concurrency, 10)
  })

  it("parses multiple flags together", () => {
    const result = parseCliArgs(["--show-diff", "--concurrency", "20"])
    assert.strictEqual(result.showGitDiff, true)
    assert.strictEqual(result.concurrency, 20)
  })
})
