# PRD: Claude Code Docs Crawler

## Introduction

A Node.js CLI tool that crawls `https://code.claude.com/docs/` starting from `llms.txt`, saving all in-scope content locally. This enables developers to build a searchable local index of Claude Code documentation for offline access and processing.

## Goals

- Crawl Claude Code docs starting from the seed URL (`llms.txt`)
- Save all text-based content to local filesystem in organized structure
- Only crawl URLs within the defined scope (`https://code.claude.com/docs/en/**`)
- Handle redirects, rate limits, and errors gracefully
- Generate metadata JSON file tracking crawl execution and results
- Deduplicate URLs and normalize paths

## User Stories

### US-001: Create project structure
**Description:** As a developer, I need the basic project setup so I can run the crawler.

**Acceptance Criteria:**
- [ ] `package.json` with `"type": "module"` and `crawl` script
- [ ] `.gitignore` includes `content/` directory
- [ ] `lib/` directory created for modules
- [ ] Typecheck/lint passes

### US-002: Implement fetch with redirect handling
**Description:** As a developer, I need a fetch wrapper that handles redirects manually so I can control scope validation at each redirect hop.

**Acceptance Criteria:**
- [ ] `lib/fetch.js` exports `fetchWithRedirects(url, scopePrefix, maxRedirects)`
- [ ] Follows redirects (3xx) only if target stays within scope
- [ ] Returns `{ type: 'out-of-scope', originalUrl, redirectedTo }` for out-of-scope redirects
- [ ] Returns `{ type: 'rate-limited', retryAfter }` for 429 responses
- [ ] Parses `Retry-After` header (seconds to milliseconds)
- [ ] Returns `{ type: 'error', reason | status }` for failures
- [ ] Returns `{ type: 'success', finalUrl, body }` for successful fetches
- [ ] Limits redirects to 10 hops maximum
- [ ] Typecheck/lint passes

### US-003: Implement URL parsing from content
**Description:** As a developer, I need to extract URLs from fetched content so the crawler can discover new pages.

**Acceptance Criteria:**
- [ ] `lib/parse.js` exports `parseUrls(body, baseUrl, scopePrefix)`
- [ ] Extracts markdown links `[text](url)`
- [ ] Extracts markdown reference links `[label]: url`
- [ ] Extracts HTML href attributes `href="url"`
- [ ] Extracts bare HTTPS URLs
- [ ] Resolves relative URLs against base URL
- [ ] Strips URL fragments (#section)
- [ ] Filters to only in-scope URLs
- [ ] Returns deduplicated array
- [ ] Typecheck/lint passes

### US-004: Implement file saving
**Description:** As a developer, I need to save fetched content to the filesystem in an organized structure.

**Acceptance Criteria:**
- [ ] Saves to `content/<host>/<path>` structure
- [ ] Handles directory-style URLs (no extension) by saving as `index.txt`
- [ ] Creates parent directories recursively
- [ ] Logs saved file path to console
- [ ] Typecheck/lint passes

### US-005: Implement crawl queue and state management
**Description:** As a developer, I need queue management to track URLs to fetch and avoid duplicates.

**Acceptance Criteria:**
- [ ] `queue` array for URLs waiting to be fetched
- [ ] `queued` Set for O(1) duplicate checking
- [ ] `fetched` Set for already-fetched URLs
- [ ] `attempts` Map tracking retry count per URL
- [ ] `enqueue(url)` normalizes and adds if not queued/fetched
- [ ] `dequeue()` removes and returns next URL
- [ ] `requeue(url)` adds URL to end of queue
- [ ] Typecheck/lint passes

### US-006: Implement main crawl loop
**Description:** As a developer, I need the main crawl loop that coordinates fetching, parsing, and saving.

**Acceptance Criteria:**
- [ ] Seeds queue from `https://code.claude.com/docs/llms.txt`
- [ ] Processes queue until empty
- [ ] Tracks attempt count, max 3 per URL
- [ ] On success: saves content, parses for new URLs, enqueues discoveries
- [ ] On rate limit: waits for Retry-After (default 5s), requeues
- [ ] On error: logs and requeues (up to 3 attempts)
- [ ] On out-of-scope redirect: logs and skips (no requeue)
- [ ] Logs summary when complete
- [ ] Typecheck/lint passes

### US-007: Implement 429 abort threshold
**Description:** As a developer, I need the crawler to abort if rate-limited repeatedly so it doesn't run indefinitely.

**Acceptance Criteria:**
- [ ] Tracks consecutive 429 responses (counter)
- [ ] Non-429 responses reset the counter
- [ ] Aborts crawl with error message at 3 consecutive 429s
- [ ] Exits with non-zero status code on abort
- [ ] Typecheck/lint passes

### US-008: Generate metadata JSON file
**Description:** As a developer, I need a metadata file to track crawl execution results for debugging and monitoring.

**Acceptance Criteria:**
- [ ] Creates `content/metadata.json` after each crawl
- [ ] Includes `seedUrl`, `scopePrefix`, `lastUpdate` (ISO timestamp)
- [ ] Includes `result`: "success", "partial", or "aborted"
- [ ] Includes `stats` object with counts for all status categories
- [ ] Includes `items` object mapping paths to individual results
- [ ] Each item has `status`, `statusReason`, `fetchedAt`
- [ ] Typecheck/lint passes

## Functional Requirements

- FR-1: Seed crawl from `https://code.claude.com/docs/llms.txt`
- FR-2: Only crawl URLs matching `https://code.claude.com/docs/en/**`
- FR-3: Save content to `./content/<host>/<path>` structure
- FR-4: Follow redirects only if they stay within scope
- FR-5: Parse markdown links, reference links, HTML hrefs, and bare URLs from content
- FR-6: Normalize URLs by stripping fragments and resolving relative paths
- FR-7: Deduplicate URLs before adding to queue
- FR-8: Retry failed fetches up to 3 times
- FR-9: Honor `Retry-After` header on 429 responses (default 5 seconds)
- FR-10: Abort if 3 consecutive 429 responses occur without successful fetch between
- FR-11: Generate `metadata.json` with crawl execution details
- FR-12: Use Node.js native APIs only (no external dependencies)

## Non-Goals

- No incremental/differential updates (full crawl each time)
- No parallel/concurrent fetching
- No content transformation or processing
- No authentication or cookie handling
- No robots.txt parsing
- No configurable seed URL or scope (hardcoded for Claude Code docs)
- No progress bar or fancy CLI output
- No unit tests in MVP (manual verification against live endpoint)

## Technical Considerations

- Uses Node 24 native `fetch`, `fs/promises`, `path`, and `URL`
- No external dependencies (package.json has no `dependencies`)
- Top-level await enabled via `"type": "module"` in package.json
- Manual redirect handling required to validate scope at each hop
- File structure mirrors URL path for predictable output location

## Success Metrics

- Successfully crawls all in-scope pages from Claude Code docs
- Handles rate limiting without manual intervention
- Generates complete metadata.json with accurate statistics
- Runs to completion in reasonable time (under 5 minutes for typical run)
- No orphaned or duplicate files in output

## Open Questions

- None blocking for MVP implementation
