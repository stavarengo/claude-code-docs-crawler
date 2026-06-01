import { describe, it } from "node:test"
import assert from "node:assert"
import { formatOutputEvent } from "../src/output.ts"

describe("output formatting", () => {
  it("renders structured events with shell-safe field values", () => {
    assert.strictEqual(
      formatOutputEvent("INFO", "content.saved", {
        status: "new",
        path: "/tmp/content docs/index.txt",
        count: 2,
        empty: "",
        skipped: undefined,
      }),
      "[INFO] content.saved status=new path=\"/tmp/content docs/index.txt\" count=2 empty=\"\"",
    )
  })
})
