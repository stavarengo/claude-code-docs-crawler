# PRD: Parallel Crawl with Per-Domain Concurrency

**Project:** claude-code-docs-crawler
**Branch:**

## Introduction

The crawler currently fetches pages one at a time, sequentially. With hundreds of pages across multiple domains, HTTP round-trip latency (200-500ms each) makes a full crawl take 26+ minutes. This feature introduces a centralized QueueManager with per-domain concurrency control, allowing multiple HTTP fetches in parallel while respecting per-domain rate limits. Seed groups also run in parallel instead of sequentially.

## Goals

- Reduce total crawl time from ~26 minutes to ~3-5 minutes by parallelizing HTTP fetches
- Limit concurrent fetches per domain (default 10) to avoid overwhelming servers
- Isolate rate limiting (429) to the affected domain without blocking other domains
- Make concurrency configurable via CLI flag
- Preserve all existing crawl behavior (dedup, scope filtering, error handling, metadata)

## User Stories

### US-001: QueueManager and DomainQueue

**Status:** pending
**Description:** As a developer, I need a QueueManager module that routes fetch requests to per-domain queues with concurrency control, so that multiple HTTP fetches can run in parallel without overwhelming any single domain.

**Acceptance Criteria:**
- [ ] New file `src/queue-manager.ts` exports `QueueManager` class
- [ ] `QueueManager` constructor accepts optional `concurrencyPerDomain` (default 10)
- [ ] `QueueManager` has one public method: `fetch(url, scopePrefixes): Promise<FetchResult>` that delegates to `fetchWithRedirects`
- [ ] Internally maintains a `Map<string, DomainQueue>` keyed by hostname, created lazily on first request to that domain
- [ ] `DomainQueue` tracks in-flight count against `maxConcurrency` — new fetches wait when all slots are occupied
- [ ] `DomainQueue` supports `pause(ms)` — stops launching new fetches for the given duration (used for 429 handling)
- [ ] When a fetch completes or pause expires, the next pending fetch is launched automatically (drain behavior)
- [ ] Multiple domains operate independently — pausing one domain does not affect others
- [ ] New test file `test/queue-manager.test.ts` verifies:
  - Submitting N requests to a single domain only allows `maxConcurrency` in-flight at once
  - `pause(ms)` holds new fetches until the duration elapses
  - Requests to different domains are routed to separate queues and run independently
  - One domain paused does not block fetches to other domains
- [ ] Typecheck passes (`npx tsc --noEmit`)
- [ ] All tests pass (`npm test`)

### US-002: Refactor crawlGroup to Use QueueManager

**Status:** pending
**Description:** As a developer, I need `crawlGroup` to use the shared QueueManager for HTTP fetches instead of fetching sequentially, so that discovered URLs are fetched concurrently within the group.

**Acceptance Criteria:**
- [ ] `crawlGroup` accepts a `QueueManager` instance as a parameter
- [ ] `crawlGroup` no longer calls `fetchWithRedirects` directly — all fetches go through `queueManager.fetch()`
- [ ] Discovered URLs are submitted to the QueueManager without awaiting individually — multiple fetches run concurrently
- [ ] As each fetch promise resolves, the group processes the result (saves content, parses new URLs, enqueues them)
- [ ] The group waits for all in-flight fetches to complete before returning
- [ ] Dedup logic (`queued`, `fetched`, `failed` sets) remains in the group, unchanged
- [ ] Scope filtering remains in the group, unchanged
- [ ] Rate limiting behavior (consecutive 429 tracking, abort-after-3) remains in the group — the group requeues rate-limited URLs via `queueManager.fetch()` and the domain pause happens automatically in the QueueManager
- [ ] Error retry logic (transient errors retried up to 3x) remains in the group, unchanged
- [ ] Existing integration tests in `test/crawl.test.ts` pass without changes (or with minimal adjustments to pass the QueueManager)
- [ ] Typecheck passes (`npx tsc --noEmit`)
- [ ] All tests pass (`npm test`)

### US-003: Parallelize Seed Groups

**Status:** pending
**Description:** As a user, I want all seed groups to crawl in parallel so that multi-domain crawls complete faster.

**Acceptance Criteria:**
- [ ] `crawl()` creates a single `QueueManager` instance shared across all groups
- [ ] `crawl()` launches all seed groups concurrently using `Promise.all` (replacing the current sequential `for...of` loop at line 478 of `src/crawl.ts`)
- [ ] Each group still gets its own dedup state, scope rules, and items — only the QueueManager is shared
- [ ] Post-group processing (markRemovedItems, rewriteMarkdownLinksInContent, merge into allItems) runs after all groups complete
- [ ] Crawl metadata, link rewriting, and index generation still work correctly
- [ ] Existing integration tests pass
- [ ] Typecheck passes (`npx tsc --noEmit`)
- [ ] All tests pass (`npm test`)

### US-004: CLI --concurrency Flag

**Status:** pending
**Description:** As a user, I want to control the per-domain concurrency via a `--concurrency` CLI flag so I can tune parallelism for different network conditions.

**Acceptance Criteria:**
- [ ] Replace raw `process.argv.includes()` CLI parsing with `parseArgs` from `node:util`
- [ ] Support existing flags: `--show-diff`, `--diff`, `--show-git-diff` (all map to `showGitDiff: true`)
- [ ] Add `--concurrency <number>` flag (default: 10)
- [ ] The parsed concurrency value is passed to `crawl()` which forwards it to the `QueueManager` constructor
- [ ] Invalid values (non-numeric, zero, negative) fall back to the default of 10
- [ ] Typecheck passes (`npx tsc --noEmit`)
- [ ] All tests pass (`npm test`)

## Functional Requirements

- FR-1: `QueueManager` must route each `fetch(url)` call to a `DomainQueue` keyed by the URL's hostname
- FR-2: Each `DomainQueue` must enforce a maximum number of concurrent in-flight HTTP fetches (default 10)
- FR-3: When a domain's concurrency limit is reached, additional fetch requests must wait in a pending queue until a slot opens
- FR-4: `DomainQueue.pause(ms)` must prevent new fetches from launching for the specified duration while allowing already in-flight fetches to complete
- FR-5: `DomainQueue` must automatically launch the next pending fetch when a slot becomes available (after a fetch completes or a pause expires)
- FR-6: `crawlGroup` must submit all discovered URLs to the QueueManager concurrently, processing results as they resolve
- FR-7: All seed groups must run in parallel via `Promise.all`, sharing a single QueueManager instance
- FR-8: The `--concurrency` CLI flag must accept an integer and pass it to the QueueManager as `concurrencyPerDomain`
- FR-9: CLI argument parsing must use `parseArgs` from `node:util` for all flags
- FR-10: `fetchWithRedirects` must remain unchanged — it is called by DomainQueue workers, not by crawlGroup directly

## Non-Goals

- No backpressure mechanism on groups — groups fire fetch calls as fast as they discover URLs (fine at our scale of hundreds to low thousands of URLs)
- No global concurrency limit across all domains — only per-domain limits
- No persistent queue or crash recovery
- No progress bar or real-time throughput reporting
- No environment variable for concurrency — CLI flag only
- No changes to fetchWithRedirects, saveContent, buildMetadata, parseUrls, or rewriteMarkdownLinks

## Technical Considerations

- `DomainQueue` pending entries are lightweight (`{ url, resolve }` callbacks), not HTTP connections — memory is negligible at our scale
- The QueueManager uses the URL's `hostname` (from `new URL(url).hostname`) as the domain key
- `parseArgs` from `node:util` is available in Node.js 18.3+ (project requires Node 24.12.0, so this is safe)
- The `crawlGroup` refactor changes how the BFS loop works: instead of dequeue-fetch-process one at a time, it becomes a concurrent processing model where multiple fetches are in flight simultaneously
- Post-group processing (markRemovedItems, link rewriting) depends on the group being fully complete, so it must run after `Promise.all` resolves

## Success Metrics

- Full crawl completes in under 5 minutes (down from 26+ minutes)
- No change in crawl output — same pages fetched, same metadata generated, same links rewritten
- All existing tests pass without modification (or with minimal signature changes)
- Per-domain concurrency is respected — no domain receives more than N simultaneous requests

## Open Questions

- None — the brainstorm document covers all design decisions.
