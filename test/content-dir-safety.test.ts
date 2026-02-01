import { describe, it } from "node:test"
import assert from "node:assert"
import { crawl } from "../src/crawl.ts"

// Ensure we never write outside the repo root by mistake.
describe("US-008: Content dir safety", () => {
  it("throws when CONTENT_DIR resolves outside repo root", async () => {
    process.env["CONTENT_DIR"] = "../definitely-outside-repo"
    process.env["SEED_URL"] = "http://example.invalid/"
    process.env["SCOPE_PREFIX"] = "http://example.invalid/"

    try {
      await assert.rejects(
        async () => crawl(),
        /within repo root/i,
      )
    } finally {
      delete process.env["CONTENT_DIR"]
      delete process.env["SEED_URL"]
      delete process.env["SCOPE_PREFIX"]
    }
  })
})
