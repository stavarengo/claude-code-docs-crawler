import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { mkdir, readFileSync, existsSync, rmSync } from "node:fs"
import { promisify } from "node:util"
import path from "node:path"

const mkdirAsync = promisify(mkdir)

// We import the saveContent helper and buildMetadata from crawl.ts
// These will be exported once implemented.
import { saveContent, buildMetadata, markRemovedItems } from "../src/crawl.ts"

const TEST_CONTENT_DIR = path.resolve("tmp/test-crawl-metadata")

beforeEach(async () => {
  rmSync(TEST_CONTENT_DIR, { recursive: true, force: true })
  await mkdirAsync(TEST_CONTENT_DIR, { recursive: true })
})

afterEach(() => {
  rmSync(TEST_CONTENT_DIR, { recursive: true, force: true })
})

describe("US-004: saveContent returns change status", () => {
  it("returns 'new' when no prior file exists", async () => {
    const url = "http://example.com/docs/page"
    const result = await saveContent(url, "hello world", TEST_CONTENT_DIR)
    assert.strictEqual(result, "new")
  })

  it("returns 'changed' when file exists with different content", async () => {
    const url = "http://example.com/docs/page"
    // First write
    await saveContent(url, "original content", TEST_CONTENT_DIR)
    // Second write with different content
    const result = await saveContent(url, "updated content", TEST_CONTENT_DIR)
    assert.strictEqual(result, "changed")
  })

  it("returns 'unchanged' when file exists with identical content and does not rewrite", async () => {
    const url = "http://example.com/docs/page"
    // First write
    await saveContent(url, "same content", TEST_CONTENT_DIR)

    const filePath = path.join(TEST_CONTENT_DIR, "example.com", "docs", "page", "index.txt")

    // Second write with same content — should NOT rewrite
    const result = await saveContent(url, "same content", TEST_CONTENT_DIR)
    assert.strictEqual(result, "unchanged")

    // Verify file content is still there
    const content = readFileSync(filePath, "utf-8")
    assert.strictEqual(content, "same content")
  })

  it("handles directory-style URLs (trailing slash)", async () => {
    const url = "http://example.com/docs/"
    const result = await saveContent(url, "index content", TEST_CONTENT_DIR)
    assert.strictEqual(result, "new")

    const filePath = path.join(TEST_CONTENT_DIR, "example.com", "docs", "index.txt")
    assert.ok(existsSync(filePath))
  })
})

describe("US-004: buildMetadata", () => {
  it("produces correct structure with success result when no failures", () => {
    const items = new Map<string, { status: string, statusReason: string, fetchedAt: string }>([
      ["example.com/docs/page1/index.txt", { status: "success", statusReason: "new", fetchedAt: "2026-02-01T00:00:00.000Z" }],
      ["example.com/docs/page2/index.txt", { status: "success", statusReason: "changed", fetchedAt: "2026-02-01T00:00:01.000Z" }],
    ])

    const metadata = buildMetadata({
      seedUrl: "http://example.com/docs/",
      scopePrefix: "http://example.com/docs/",
      items,
      aborted: false,
    })

    assert.strictEqual(metadata.seedUrl, "http://example.com/docs/")
    assert.strictEqual(metadata.scopePrefix, "http://example.com/docs/")
    assert.strictEqual(metadata.result, "success")
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.exec(metadata.lastUpdate))
    assert.strictEqual(metadata.stats["uniqueUrls"], 2)
    assert.strictEqual(metadata.stats["success"], 2)
    assert.strictEqual(metadata.stats["success.new"], 1)
    assert.strictEqual(metadata.stats["success.changed"], 1)
    assert.strictEqual(metadata.stats["success.unchanged"], 0)
    assert.strictEqual(metadata.stats["success.removed"], 0)
    assert.strictEqual(metadata.stats["skipped"], 0)
    assert.strictEqual(metadata.stats["failed"], 0)
  })

  it("produces 'partial' result when at least one item has status 'failed'", () => {
    const items = new Map<string, { status: string, statusReason: string, fetchedAt: string }>([
      ["example.com/docs/ok/index.txt", { status: "success", statusReason: "new", fetchedAt: "2026-02-01T00:00:00.000Z" }],
      ["http://example.com/docs/bad", { status: "failed", statusReason: "httpError", fetchedAt: "2026-02-01T00:00:01.000Z" }],
    ])

    const metadata = buildMetadata({
      seedUrl: "http://example.com/docs/",
      scopePrefix: "http://example.com/docs/",
      items,
      aborted: false,
    })

    assert.strictEqual(metadata.result, "partial")
    assert.strictEqual(metadata.stats["failed"], 1)
    assert.strictEqual(metadata.stats["failed.httpError"], 1)
  })

  it("produces 'aborted' result when aborted flag is true", () => {
    const items = new Map<string, { status: string, statusReason: string, fetchedAt: string }>()

    const metadata = buildMetadata({
      seedUrl: "http://example.com/docs/",
      scopePrefix: "http://example.com/docs/",
      items,
      aborted: true,
    })

    assert.strictEqual(metadata.result, "aborted")
  })

  it("counts skipped categories correctly", () => {
    const items = new Map<string, { status: string, statusReason: string, fetchedAt: string }>([
      ["http://external.com/page", { status: "skipped", statusReason: "outOfScope", fetchedAt: "2026-02-01T00:00:00.000Z" }],
      ["example.com/docs/dup/index.txt", { status: "skipped", statusReason: "duplicate", fetchedAt: "2026-02-01T00:00:01.000Z" }],
      ["example.com/docs/redir/index.txt", { status: "skipped", statusReason: "redirectOutOfScope", fetchedAt: "2026-02-01T00:00:02.000Z" }],
      ["example.com/docs/redir2/index.txt", { status: "skipped", statusReason: "redirectDuplicate", fetchedAt: "2026-02-01T00:00:03.000Z" }],
    ])

    const metadata = buildMetadata({
      seedUrl: "http://example.com/docs/",
      scopePrefix: "http://example.com/docs/",
      items,
      aborted: false,
    })

    assert.strictEqual(metadata.stats["skipped"], 4)
    assert.strictEqual(metadata.stats["skipped.outOfScope"], 1)
    assert.strictEqual(metadata.stats["skipped.duplicate"], 1)
    assert.strictEqual(metadata.stats["skipped.redirectOutOfScope"], 1)
    assert.strictEqual(metadata.stats["skipped.redirectDuplicate"], 1)
  })
})

describe("US-005: markRemovedItems", () => {
  it("marks previously successful items not visited in current run as removed", () => {
    const previousItems: Record<string, { status: string, statusReason: string, fetchedAt: string }> = {
      "example.com/docs/page1/index.txt": { status: "success", statusReason: "new", fetchedAt: "2026-01-31T00:00:00.000Z" },
      "example.com/docs/page2/index.txt": { status: "success", statusReason: "new", fetchedAt: "2026-01-31T00:00:01.000Z" },
    }

    const currentItems = new Map<string, { status: string, statusReason: string, fetchedAt: string }>([
      ["example.com/docs/page1/index.txt", { status: "success", statusReason: "unchanged", fetchedAt: "2026-02-01T00:00:00.000Z" }],
    ])

    markRemovedItems(previousItems, currentItems)

    // page2 was not visited, so it should be marked as removed
    const removed = currentItems.get("example.com/docs/page2/index.txt")
    assert.ok(removed, "removed item should be added to current items")
    assert.strictEqual(removed.status, "success")
    assert.strictEqual(removed.statusReason, "removed")
  })

  it("does not mark previously failed or skipped items as removed", () => {
    const previousItems: Record<string, { status: string, statusReason: string, fetchedAt: string }> = {
      "example.com/docs/failed/index.txt": { status: "failed", statusReason: "httpError", fetchedAt: "2026-01-31T00:00:00.000Z" },
      "http://external.com/page": { status: "skipped", statusReason: "outOfScope", fetchedAt: "2026-01-31T00:00:01.000Z" },
    }

    const currentItems = new Map<string, { status: string, statusReason: string, fetchedAt: string }>()

    markRemovedItems(previousItems, currentItems)

    assert.strictEqual(currentItems.size, 0, "failed and skipped items should not be marked as removed")
  })

  it("does not mark items that were visited in the current run", () => {
    const previousItems: Record<string, { status: string, statusReason: string, fetchedAt: string }> = {
      "example.com/docs/page1/index.txt": { status: "success", statusReason: "new", fetchedAt: "2026-01-31T00:00:00.000Z" },
    }

    const currentItems = new Map<string, { status: string, statusReason: string, fetchedAt: string }>([
      ["example.com/docs/page1/index.txt", { status: "success", statusReason: "changed", fetchedAt: "2026-02-01T00:00:00.000Z" }],
    ])

    markRemovedItems(previousItems, currentItems)

    // page1 was visited, so it should retain its current status
    const item = currentItems.get("example.com/docs/page1/index.txt")
    assert.ok(item)
    assert.strictEqual(item.statusReason, "changed")
    assert.strictEqual(currentItems.size, 1)
  })

  it("does not mark previously removed items as removed again", () => {
    const previousItems: Record<string, { status: string, statusReason: string, fetchedAt: string }> = {
      "example.com/docs/old/index.txt": { status: "success", statusReason: "removed", fetchedAt: "2026-01-31T00:00:00.000Z" },
    }

    const currentItems = new Map<string, { status: string, statusReason: string, fetchedAt: string }>()

    markRemovedItems(previousItems, currentItems)

    // Previously removed items had status 'success' but statusReason 'removed'.
    // They should still be marked as removed (status is 'success').
    const item = currentItems.get("example.com/docs/old/index.txt")
    assert.ok(item, "previously removed item should be re-marked as removed")
    assert.strictEqual(item.status, "success")
    assert.strictEqual(item.statusReason, "removed")
  })

  it("handles empty previous items gracefully", () => {
    const previousItems: Record<string, { status: string, statusReason: string, fetchedAt: string }> = {}
    const currentItems = new Map<string, { status: string, statusReason: string, fetchedAt: string }>([
      ["example.com/docs/page1/index.txt", { status: "success", statusReason: "new", fetchedAt: "2026-02-01T00:00:00.000Z" }],
    ])

    markRemovedItems(previousItems, currentItems)

    assert.strictEqual(currentItems.size, 1, "no removed items should be added when previous is empty")
  })
})

describe("US-005: buildMetadata counts removed items in stats", () => {
  it("includes removed items in uniqueUrls and success.removed", () => {
    const items = new Map<string, { status: string, statusReason: string, fetchedAt: string }>([
      ["example.com/docs/page1/index.txt", { status: "success", statusReason: "new", fetchedAt: "2026-02-01T00:00:00.000Z" }],
      ["example.com/docs/page2/index.txt", { status: "success", statusReason: "removed", fetchedAt: "2026-01-31T00:00:00.000Z" }],
      ["example.com/docs/page3/index.txt", { status: "success", statusReason: "removed", fetchedAt: "2026-01-30T00:00:00.000Z" }],
    ])

    const metadata = buildMetadata({
      seedUrl: "http://example.com/docs/",
      scopePrefix: "http://example.com/docs/",
      items,
      aborted: false,
    })

    assert.strictEqual(metadata.stats["uniqueUrls"], 3)
    assert.strictEqual(metadata.stats["success"], 3)
    assert.strictEqual(metadata.stats["success.removed"], 2)
    assert.strictEqual(metadata.stats["success.new"], 1)
  })
})
