# PRD: Docs Crawler — Metadata Tracking & Test Coverage

## Introduction

The docs crawler (`src/crawl.ts`, `src/fetch.ts`, `src/parse.ts`) already implements the core crawl loop: seeding from `llms.txt`, fetching pages with redirect and rate-limit handling, parsing URLs, and saving content to `./content/`. What's missing is **crawl metadata tracking** (a JSON report of every URL visited, its outcome, and aggregate stats) and **automated test coverage** for the URL parser, the fetch module, and the end-to-end crawl.

This PRD targets those two gaps. It does not touch the core fetch/parse/save logic, which is already working.

## Goals

- Write a metadata JSON file after each crawl run, recording per-URL status and aggregate stats exactly as specified in the design doc
- Track whether saved content is new, changed, or unchanged relative to a previous crawl run
- Detect previously-crawled pages that were not reached in the current run and mark them as `removed`
- Provide unit tests for `parseUrls` covering all extraction patterns and edge cases
- Provide unit tests for `fetchWithRedirects` covering redirect chains, scope checks, 429 handling, and content-type filtering
- Provide an integration test that runs the crawl loop against a local mock server and verifies the full pipeline end-to-end

## User Stories

### US-002: Unit tests for URL parser (`lib/parse.ts`)

**Description:** As a developer, I want automated tests for `parseUrls` so that regressions in URL extraction are caught before they reach production.

**Acceptance Criteria:**
- [ ] Test file at `test/parse.test.ts`
- [ ] Tests cover: markdown inline links `[text](url)`, markdown reference links `[label]: url`, HTML `href` attributes, bare `https://` URLs
- [ ] Tests verify relative URLs are resolved against the provided `baseUrl`
- [ ] Tests verify fragment (`#section`) stripping
- [ ] Tests verify out-of-scope URLs are filtered out
- [ ] Tests verify duplicate URLs are deduplicated in the returned array
- [ ] Tests verify invalid/malformed URLs are silently skipped (no throw)
- [ ] All tests pass with `node --test`
- [ ] Typecheck passes (`npx tsc --noEmit -p tsconfig.node.json`)

### US-003: Unit tests for fetch module (`lib/fetch.ts`)

**Description:** As a developer, I want automated tests for `fetchWithRedirects` so that redirect handling, scope enforcement, rate-limit logic, and content-type filtering are verified without hitting a live server.

**Acceptance Criteria:**
- [ ] Test file at `test/fetch.test.ts`
- [ ] Uses a local mock HTTP server (e.g., `node:http` `createServer`) — no external dependencies
- [ ] Tests cover: successful fetch returns `{ type: 'success', finalUrl, body }`
- [ ] Tests cover: single redirect within scope is followed and `finalUrl` reflects the redirected URL
- [ ] Tests cover: redirect chain (multiple hops) within scope is followed up to `maxRedirects`
- [ ] Tests cover: redirect to out-of-scope URL returns `{ type: 'out-of-scope', redirectedTo }`
- [ ] Tests cover: exceeding `maxRedirects` returns `{ type: 'error', reason: 'Too many redirects' }`
- [ ] Tests cover: HTTP 429 returns `{ type: 'rate-limited' }` with `retryAfter` parsed from header (in ms)
- [ ] Tests cover: HTTP 429 without `Retry-After` header returns `retryAfter: null`
- [ ] Tests cover: non-2xx status (e.g., 404, 500) returns `{ type: 'error', status }`
- [ ] Tests cover: non-text content-type returns `{ type: 'non-text', contentType }`
- [ ] Tests cover: network error (server refuses connection) returns `{ type: 'error', reason }`
- [ ] All tests pass with `node --test`
- [ ] Typecheck passes

### US-004: Crawl metadata JSON output

**Description:** As a developer, I want the crawler to write a metadata JSON file after each run so that I can audit what happened, compare runs, and detect drift.

**Acceptance Criteria:**
- [ ] After the crawl loop completes, a file is written to `content/crawl-metadata.json`
- [ ] The JSON has top-level keys: `seedUrl`, `scopePrefix`, `lastUpdate` (ISO 8601 timestamp), `result` (`"success"` | `"partial"` | `"aborted"`), `stats`, and `items`
- [ ] `result` is `"success"` when the loop exits normally, `"aborted"` when exiting due to 3 consecutive 429s
- [ ] `stats` contains aggregate counts matching the design doc: `uniqueUrls`, `success`, `success.new`, `success.changed`, `success.unchanged`, `success.removed`, `skipped`, `skipped.outOfScope`, `skipped.duplicate`, `skipped.redirectOutOfScope`, `skipped.redirectDuplicate`, `failed`, `failed.httpError`
- [ ] `items` is a map from relative path (for in-scope URLs) or full URL (for out-of-scope) to an object with `status`, `statusReason`, and `fetchedAt`
- [ ] For successful saves: the crawler compares the new body against the previously saved file (if any). If no previous file exists, `statusReason` is `"new"`. If the file exists and content differs, `statusReason` is `"changed"`. If content is identical, `statusReason` is `"unchanged"` and the file is not re-written.
- [ ] Typecheck passes

### US-005: Detect removed pages across crawl runs

**Description:** As a developer, I want the crawler to flag pages that existed in a previous crawl but were not reached in the current run, so I know when upstream content disappears.

**Acceptance Criteria:**
- [ ] Before the crawl loop starts, if `content/crawl-metadata.json` exists from a prior run, its `items` are loaded into memory
- [ ] After the crawl loop completes, any item from the previous metadata that has `status: "success"` and was **not** visited in the current run is recorded in the current metadata with `status: "success"` and `statusReason: "removed"`
- [ ] The corresponding file in `content/` is **not** deleted — only the metadata flags it
- [ ] `stats.success.removed` reflects the count of these items
- [ ] `stats.uniqueUrls` includes removed items in its total
- [ ] Typecheck passes

### US-006: Integration test for the full crawl pipeline

**Description:** As a developer, I want an end-to-end test that runs the actual crawl loop against a controlled mock server, so I can verify that fetch, parse, save, and metadata all work together correctly.

**Acceptance Criteria:**
- [ ] Test file at `test/crawl.test.ts`
- [ ] Spins up a local mock HTTP server that serves a small linked set of pages (e.g., 3–4 pages with cross-links, one redirect, one out-of-scope link)
- [ ] The test rewrites `SEED_URL` and `SCOPE_PREFIX` to point at the mock server (via environment variables or by refactoring the crawl module to accept config — choose the approach that requires minimal changes to `crawl.ts`)
- [ ] After the crawl completes, the test asserts:
    - All in-scope pages were saved to the expected file paths under a temp `content/` directory
    - Out-of-scope URLs were not saved
    - `crawl-metadata.json` was written with correct `stats` and per-item `status`/`statusReason`
- [ ] The test cleans up the temp output directory after running
- [ ] All tests pass with `node --test`
- [ ] Typecheck passes

## Functional Requirements

- FR-1: The crawler must track per-URL outcomes (success/skipped/failed) and the specific reason for each outcome throughout the crawl loop
- FR-2: On successful fetch, the crawler must compare the fetched body against any previously saved file to determine whether the content is new, changed, or unchanged
- FR-3: If content is unchanged, the crawler must skip the file write (avoid unnecessary disk I/O)
- FR-4: After the crawl loop exits, the crawler must write `content/crawl-metadata.json` with the full stats and items map
- FR-5: Before the crawl loop starts, the crawler must read any existing `crawl-metadata.json` to establish the prior-run baseline for removed-page detection
- FR-6: After the crawl loop exits, any prior-run item with `status: "success"` that was not visited in the current run must be recorded as `statusReason: "removed"`
- FR-7: `stats` must be computed as aggregate counts derived from the `items` map (not tracked independently), ensuring consistency
- FR-8: Unit tests must use only Node.js built-in modules — no test framework dependencies beyond `node:test` and `node:assert`

## Non-Goals

- This PRD does not change the fetch, parse, or save logic itself — those are already implemented
- No deletion of previously-crawled files from disk (removed pages are flagged in metadata only)
- No CLI flags or configuration file support — seed URL and scope prefix remain hardcoded constants
- No concurrent/parallel fetching — the crawl loop remains sequential
- No notification or alerting when removed pages are detected

## Technical Considerations

- **Metadata file location:** `content/crawl-metadata.json` sits alongside the crawled content. Since `content/` is gitignored, the metadata persists locally between runs but is not committed
- **New/changed/unchanged detection:** Use `fs.readFile` to read the existing file before `writeFile`. If the file doesn't exist (ENOENT), it's `"new"`. Compare strings directly — no hashing needed at this scale
- **Removed detection:** Load prior `items` from `crawl-metadata.json` at startup. After the loop, diff against the current run's visited set
- **Stats consistency:** Derive all `stats` counts from the final `items` map in a single pass before writing, rather than incrementing counters during the loop. This avoids counter drift bugs
- **Test isolation:** Integration tests must write to a temp directory (not the real `content/`). Use `fs.mkdtempSync` or similar
- **Mock server:** Use `node:http` `createServer` in tests. No external HTTP mocking libraries

## Success Metrics

- All unit and integration tests pass on a clean checkout with `node --test test/*.test.ts`
- Metadata JSON is produced after every crawl run and accurately reflects what happened
- A second crawl run against unchanged content produces all `"unchanged"` status reasons and zero file writes
- Removed pages are correctly identified when upstream content disappears between runs

## Open Questions

- Should `result: "partial"` be used when some URLs fail after exhausting retries but the crawl otherwise completes? (Currently the design doc lists it but doesn't define the trigger condition.) — Assume yes: `"partial"` when at least one URL has `status: "failed"` and the crawl did not abort.
