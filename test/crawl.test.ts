import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { createServer } from "node:http"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

// Import crawl — it must be exported and accept config via env vars
import { crawl, type SeedConfig } from "../src/crawl.ts"

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
    const indexPath = path.join(TEST_CONTENT_DIR, "docs", host, "docs", "index.txt")
    const pageAPath = path.join(TEST_CONTENT_DIR, "docs", host, "docs", "page-a", "index.txt")
    const pageBPath = path.join(TEST_CONTENT_DIR, "docs", host, "docs", "page-b", "index.txt")
    const pageCPath = path.join(TEST_CONTENT_DIR, "docs", host, "docs", "page-c", "index.txt")

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
    const externalPath = path.join(TEST_CONTENT_DIR, "docs", "external.example.com")
    assert.ok(!existsSync(externalPath), "out-of-scope external.example.com was not saved")

    // --- Assert crawl-metadata.json was written with correct structure ---
    const metadataPath = path.join(TEST_CONTENT_DIR, "crawl-metadata.json")
    assert.ok(existsSync(metadataPath), "crawl-metadata.json exists")

    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
      seeds: { seedUrl: string, scopePrefix: string, additionalScopePrefixes: string[] }[]
      lastUpdate: string
      result: string
      stats: Record<string, number>
      items: Record<string, { status: string, statusReason: string, fetchedAt: string }>
    }

    assert.strictEqual(metadata.seeds[0]!.seedUrl, seedUrl)
    assert.strictEqual(metadata.seeds[0]!.scopePrefix, scopePrefix)
    assert.strictEqual(metadata.result, "success")
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.exec(metadata.lastUpdate), "lastUpdate is ISO 8601")

    // --- Assert per-item statuses ---
    // 4 pages successfully fetched (seed, page-a, page-b, page-c).
    // /docs/redirect is an in-scope 301 → /docs/page-b. fetchWithRedirects follows it
    // transparently and returns success with finalUrl=page-b, so the redirect URL itself
    // never appears in items. page-b may be saved twice (once directly, once via the
    // redirect). With concurrent fetching the save order is non-deterministic, so page-b
    // may end up as either "new" or "unchanged".
    const successItems = Object.entries(metadata.items).filter(([, v]) => v.status === "success")
    assert.strictEqual(successItems.length, 4, "4 pages crawled successfully")

    const newItems = successItems.filter(([, v]) => v.statusReason === "new")
    const unchangedItems = successItems.filter(([, v]) => v.statusReason === "unchanged")
    assert.ok(newItems.length >= 3 && newItems.length <= 4, `expected 3-4 new items, got ${String(newItems.length)}`)
    assert.ok(unchangedItems.length <= 1, `expected 0-1 unchanged items, got ${String(unchangedItems.length)}`)

    // The out-of-scope link is filtered by parseUrls and never enqueued,
    // so no skipped items appear in metadata
    const skippedItems = Object.entries(metadata.items).filter(([, v]) => v.status === "skipped")
    assert.strictEqual(skippedItems.length, 0, "out-of-scope link was filtered before enqueueing")

    // --- Assert stats ---
    assert.strictEqual(metadata.stats["success"], 4)
    assert.ok(
      (metadata.stats["success.new"] ?? 0) >= 3 && (metadata.stats["success.new"] ?? 0) <= 4,
      `expected 3-4 success.new, got ${String(metadata.stats["success.new"])}`,
    )
    assert.ok(
      (metadata.stats["success.unchanged"] ?? 0) <= 1,
      `expected 0-1 success.unchanged, got ${String(metadata.stats["success.unchanged"])}`,
    )
    assert.strictEqual(metadata.stats["failed"], 0)
  })
})

describe("crawlGroup uses QueueManager for concurrent fetches", () => {
  it("fetches discovered URLs concurrently via QueueManager, not sequentially", async () => {
    // The seed page links to 4 pages. With concurrency, the server should see
    // multiple requests in-flight simultaneously (maxInFlight > 1).
    // With sequential fetching, maxInFlight would be exactly 1.
    let inFlight = 0
    let maxInFlight = 0

    // Replace the server with one that tracks in-flight requests
    server.close()
    server = createServer((req, res) => {
      const url = req.url ?? "/"

      if (url === "/docs/redirect") {
        res.writeHead(301, { location: `http://localhost:${String(port)}/docs/page-b` })
        res.end()
        return
      }

      const body = pages[url]
      if (body !== undefined) {
        inFlight++
        if (inFlight > maxInFlight) maxInFlight = inFlight
        // Add a small delay so concurrent requests overlap
        setTimeout(() => {
          inFlight--
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end(body)
        }, 50)
        return
      }

      res.writeHead(404, { "content-type": "text/plain" })
      res.end("Not Found")
    })
    server.listen(0)
    port = (server.address() as { port: number }).port
    baseUrl = `http://localhost:${String(port)}`

    // Use a flat page structure so all links are discovered at once
    pages["/docs/"] = [
      "# Docs Home",
      `[Page A](/docs/page-a)`,
      `[Page B](/docs/page-b)`,
      `[Page C](/docs/page-c)`,
    ].join("\n")

    process.env["SEED_URL"] = `${baseUrl}/docs/`
    process.env["SCOPE_PREFIX"] = `${baseUrl}/docs/`
    process.env["CONTENT_DIR"] = TEST_CONTENT_DIR

    try {
      await crawl()
    } finally {
      delete process.env["SEED_URL"]
      delete process.env["SCOPE_PREFIX"]
      delete process.env["CONTENT_DIR"]
    }

    // With concurrent fetching, after discovering links from the seed page,
    // pages a, b, and c should be fetched concurrently
    assert.ok(maxInFlight > 1, `expected concurrent in-flight requests but maxInFlight was ${String(maxInFlight)}`)

    // All pages should still be saved correctly
    const host = `localhost:${String(port)}`
    assert.ok(existsSync(path.join(TEST_CONTENT_DIR, "docs", host, "docs", "index.txt")), "seed saved")
    assert.ok(existsSync(path.join(TEST_CONTENT_DIR, "docs", host, "docs", "page-a", "index.txt")), "page-a saved")
    assert.ok(existsSync(path.join(TEST_CONTENT_DIR, "docs", host, "docs", "page-b", "index.txt")), "page-b saved")
    assert.ok(existsSync(path.join(TEST_CONTENT_DIR, "docs", host, "docs", "page-c", "index.txt")), "page-c saved")
  })
})

describe("Seed groups run in parallel", () => {
  it("launches groups concurrently so total time is less than sum of group times", async () => {
    // Two seed groups with different localPrefixes hit the same server.
    // Each response takes ~100ms. If groups ran sequentially, total time
    // would be >= 200ms (2 groups x 100ms). If parallel, total time should
    // be ~100ms (both groups' fetches overlap).
    const GROUP_DELAY = 100

    server.close()
    server = createServer((req, res) => {
      const url = req.url ?? "/"
      const body = pages[url]
      if (body !== undefined) {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end(body)
        }, GROUP_DELAY)
        return
      }
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("Not Found")
    })
    server.listen(0)
    port = (server.address() as { port: number }).port
    baseUrl = `http://localhost:${String(port)}`

    // Group A pages
    pages["/group-a/"] = "# Group A Home"
    // Group B pages
    pages["/group-b/"] = "# Group B Home"

    const seeds: SeedConfig[] = [
      {
        seedUrl: `${baseUrl}/group-a/`,
        scopePrefix: `${baseUrl}/group-a/`,
        additionalScopePrefixes: [],
        localPrefix: "alpha",
      },
      {
        seedUrl: `${baseUrl}/group-b/`,
        scopePrefix: `${baseUrl}/group-b/`,
        additionalScopePrefixes: [],
        localPrefix: "beta",
      },
    ]

    process.env["CONTENT_DIR"] = TEST_CONTENT_DIR

    try {
      const start = Date.now()
      await crawl({ seeds })
      const elapsed = Date.now() - start

      // If sequential: ~200ms (2 x 100ms). If parallel: ~100ms.
      // Wide margin for CI — just verify it's faster than sequential would be.
      assert.ok(
        elapsed < GROUP_DELAY * 2 + 50,
        `expected parallel execution (elapsed ${String(elapsed)}ms < ${String(GROUP_DELAY * 2 + 50)}ms)`,
      )
    } finally {
      delete process.env["CONTENT_DIR"]
    }

    const host = `localhost:${String(port)}`

    // Both groups' pages should be saved under their respective localPrefix
    const groupAPath = path.join(TEST_CONTENT_DIR, "docs", "alpha", host, "group-a", "index.txt")
    const groupBPath = path.join(TEST_CONTENT_DIR, "docs", "beta", host, "group-b", "index.txt")
    assert.ok(existsSync(groupAPath), `group A page saved at ${groupAPath}`)
    assert.ok(existsSync(groupBPath), `group B page saved at ${groupBPath}`)

    // Verify content
    assert.strictEqual(readFileSync(groupAPath, "utf-8"), pages["/group-a/"])
    assert.strictEqual(readFileSync(groupBPath, "utf-8"), pages["/group-b/"])

    // Verify metadata includes both groups
    const metadataPath = path.join(TEST_CONTENT_DIR, "crawl-metadata.json")
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
      stats: Record<string, number>
    }
    assert.strictEqual(metadata.stats["success"], 2, "both groups' pages counted")
  })
})

describe("US-002: Multi-seed crawl", () => {
  it("enqueues and crawls pages from multiple seeds", async () => {
    // Add a second seed path to the mock server
    pages["/other/"] = [
      "# Other Docs Home",
      `[Other Page](/other/page-x)`,
    ].join("\n")
    pages["/other/page-x"] = "# Other Page X\n\nContent from second seed."

    // Build seeds array with two seeds pointing to different paths on the mock server
    const seeds: SeedConfig[] = [
      {
        seedUrl: `${baseUrl}/docs/`,
        scopePrefix: `${baseUrl}/docs/`,
        additionalScopePrefixes: [],
        localPrefix: "",
      },
      {
        seedUrl: `${baseUrl}/other/`,
        scopePrefix: `${baseUrl}/other/`,
        additionalScopePrefixes: [],
        localPrefix: "",
      },
    ]

    process.env["CONTENT_DIR"] = TEST_CONTENT_DIR

    try {
      await crawl({ seeds })
    } finally {
      delete process.env["CONTENT_DIR"]
    }

    const host = `localhost:${String(port)}`

    // Assert pages from FIRST seed were saved
    const indexPath = path.join(TEST_CONTENT_DIR, "docs", host, "docs", "index.txt")
    const pageAPath = path.join(TEST_CONTENT_DIR, "docs", host, "docs", "page-a", "index.txt")
    assert.ok(existsSync(indexPath), "first seed index saved")
    assert.ok(existsSync(pageAPath), "first seed page-a saved")

    // Assert pages from SECOND seed were saved
    const otherIndexPath = path.join(TEST_CONTENT_DIR, "docs", host, "other", "index.txt")
    const pageXPath = path.join(TEST_CONTENT_DIR, "docs", host, "other", "page-x", "index.txt")
    assert.ok(existsSync(otherIndexPath), "second seed index saved")
    assert.ok(existsSync(pageXPath), "second seed page-x saved")

    // Verify content from second seed
    assert.strictEqual(readFileSync(otherIndexPath, "utf-8"), pages["/other/"])
    assert.strictEqual(readFileSync(pageXPath, "utf-8"), pages["/other/page-x"])
  })
})
