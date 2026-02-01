import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { createServer } from "node:http"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

// Import crawl — it must be exported and accept config via env vars
import { crawl } from "../src/crawl.ts"

const TEST_CONTENT_DIR = path.resolve("tmp/test-crawl-integration")

let server: ReturnType<typeof createServer>
let port: number
let baseUrl: string

// Pages served by the mock server:
//   /docs/           - seed, links to /docs/page-a and /docs/page-b and /docs/redirect and https://external.example.com/outside
//   /docs/page-a     - links to /docs/page-c
//   /docs/page-b     - no further links
//   /docs/page-c     - no further links
//   /docs/redirect   - 301 → /docs/page-b (in-scope redirect)
//   /outside         - out-of-scope (never fetched because parseUrls filters it, but referenced)

const pages: Record<string, string> = {}

function buildPages() {
  pages["/docs/"] = [
    "# Docs Home",
    `[Page A](/docs/page-a)`,
    `[Page B](/docs/page-b)`,
    `[Redirect](/docs/redirect)`,
    `[Outside](https://external.example.com/outside)`,
  ].join("\n")

  pages["/docs/page-a"] = [
    "# Page A",
    `[Page C](/docs/page-c)`,
  ].join("\n")

  pages["/docs/page-b"] = "# Page B\n\nNo links here."
  pages["/docs/page-c"] = "# Page C\n\nLeaf page."
}

beforeEach(() => {
  buildPages()
  rmSync(TEST_CONTENT_DIR, { recursive: true, force: true })

  server = createServer((req, res) => {
    const url = req.url ?? "/"

    // Redirect: /docs/redirect → /docs/page-b
    if (url === "/docs/redirect") {
      res.writeHead(301, { location: `http://localhost:${String(port)}/docs/page-b` })
      res.end()
      return
    }

    const body = pages[url]
    if (body !== undefined) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      res.end(body)
      return
    }

    res.writeHead(404, { "content-type": "text/plain" })
    res.end("Not Found")
  })

  server.listen(0)
  port = (server.address() as { port: number }).port
  baseUrl = `http://localhost:${String(port)}`
})

afterEach(() => {
  server.close()
  rmSync(TEST_CONTENT_DIR, { recursive: true, force: true })
})

describe("US-006: Integration test for full crawl pipeline", () => {
  it("crawls all in-scope pages, follows in-scope redirect, skips out-of-scope, writes metadata", async () => {
    // Set env vars to point crawl at mock server + temp dir
    const seedUrl = `${baseUrl}/docs/`
    const scopePrefix = `${baseUrl}/docs/`
    process.env["SEED_URL"] = seedUrl
    process.env["SCOPE_PREFIX"] = scopePrefix
    process.env["CONTENT_DIR"] = TEST_CONTENT_DIR

    try {
      await crawl()
    } finally {
      delete process.env["SEED_URL"]
      delete process.env["SCOPE_PREFIX"]
      delete process.env["CONTENT_DIR"]
    }

    const host = `localhost:${String(port)}`

    // --- Assert in-scope pages were saved ---
    const indexPath = path.join(TEST_CONTENT_DIR, host, "docs", "index.txt")
    const pageAPath = path.join(TEST_CONTENT_DIR, host, "docs", "page-a", "index.txt")
    const pageBPath = path.join(TEST_CONTENT_DIR, host, "docs", "page-b", "index.txt")
    const pageCPath = path.join(TEST_CONTENT_DIR, host, "docs", "page-c", "index.txt")

    assert.ok(existsSync(indexPath), `seed index saved at ${indexPath}`)
    assert.ok(existsSync(pageAPath), `page-a saved at ${pageAPath}`)
    assert.ok(existsSync(pageBPath), `page-b saved at ${pageBPath}`)
    assert.ok(existsSync(pageCPath), `page-c saved at ${pageCPath}`)

    // Verify content matches what the mock server served
    assert.strictEqual(readFileSync(indexPath, "utf-8"), pages["/docs/"])
    assert.strictEqual(readFileSync(pageAPath, "utf-8"), pages["/docs/page-a"])
    assert.strictEqual(readFileSync(pageBPath, "utf-8"), pages["/docs/page-b"])
    assert.strictEqual(readFileSync(pageCPath, "utf-8"), pages["/docs/page-c"])

    // --- Assert out-of-scope URL was NOT saved ---
    // external.example.com should not appear anywhere in the content dir
    const externalPath = path.join(TEST_CONTENT_DIR, "external.example.com")
    assert.ok(!existsSync(externalPath), "out-of-scope external.example.com was not saved")

    // --- Assert crawl-metadata.json was written with correct structure ---
    const metadataPath = path.join(TEST_CONTENT_DIR, "crawl-metadata.json")
    assert.ok(existsSync(metadataPath), "crawl-metadata.json exists")

    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
      seedUrl: string
      scopePrefix: string
      lastUpdate: string
      result: string
      stats: Record<string, number>
      items: Record<string, { status: string, statusReason: string, fetchedAt: string }>
    }

    assert.strictEqual(metadata.seedUrl, seedUrl)
    assert.strictEqual(metadata.scopePrefix, scopePrefix)
    assert.strictEqual(metadata.result, "success")
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.exec(metadata.lastUpdate), "lastUpdate is ISO 8601")

    // --- Assert per-item statuses ---
    // 4 pages successfully fetched (seed, page-a, page-b, page-c).
    // /docs/redirect is an in-scope 301 → /docs/page-b. fetchWithRedirects follows it
    // transparently and returns success with finalUrl=page-b, so the redirect URL itself
    // never appears in items. page-b is saved twice (once directly, once via the redirect)
    // so its final statusReason is "unchanged".
    const successItems = Object.entries(metadata.items).filter(([, v]) => v.status === "success")
    assert.strictEqual(successItems.length, 4, "4 pages crawled successfully")

    // 3 items are "new", page-b is "unchanged" (saved twice due to redirect)
    const newItems = successItems.filter(([, v]) => v.statusReason === "new")
    const unchangedItems = successItems.filter(([, v]) => v.statusReason === "unchanged")
    assert.strictEqual(newItems.length, 3, "3 pages are new")
    assert.strictEqual(unchangedItems.length, 1, "page-b is unchanged (fetched again via redirect)")
    const unchangedEntry = unchangedItems[0]
    assert.ok(unchangedEntry, "unchanged entry exists")
    assert.ok(unchangedEntry[0].includes("page-b"), "the unchanged item is page-b")

    // The out-of-scope link is filtered by parseUrls and never enqueued,
    // so no skipped items appear in metadata
    const skippedItems = Object.entries(metadata.items).filter(([, v]) => v.status === "skipped")
    assert.strictEqual(skippedItems.length, 0, "out-of-scope link was filtered before enqueueing")

    // --- Assert stats ---
    assert.strictEqual(metadata.stats["success"], 4)
    assert.strictEqual(metadata.stats["success.new"], 3)
    assert.strictEqual(metadata.stats["success.unchanged"], 1)
    assert.strictEqual(metadata.stats["failed"], 0)
  })
})
