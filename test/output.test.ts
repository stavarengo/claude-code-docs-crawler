import { describe, it } from "node:test"
import assert from "node:assert"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { formatOutputEvent, logEvent } from "../src/output.ts"

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

  it("writes structured events to a local transcript file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "crawler-output-test-"))
    const transcriptPath = path.join(dir, "crawler-output.log")
    const originalOutputFile = process.env["CRAWLER_OUTPUT_FILE"]
    const originalLog = console.log
    process.env["CRAWLER_OUTPUT_FILE"] = transcriptPath
    console.log = () => undefined

    try {
      logEvent("INFO", "content.saved", {
        status: "new",
        path: "docs/index.txt",
      })

      const transcript = readFileSync(transcriptPath, "utf-8")
      assert.ok(transcript.includes("# Docs Crawler output"))
      assert.ok(transcript.includes("[INFO] content.saved status=new path=docs/index.txt"))
    } finally {
      if (originalOutputFile === undefined) {
        delete process.env["CRAWLER_OUTPUT_FILE"]
      } else {
        process.env["CRAWLER_OUTPUT_FILE"] = originalOutputFile
      }
      console.log = originalLog
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
