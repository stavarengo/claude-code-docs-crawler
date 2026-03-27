# PRD: Crawl Output Observability

**Project:** claude-code-docs-crawler
**Branch:**

## Introduction

The crawler's current console output was written for a mostly linear fetch flow. After
parallel crawl support landed, log lines from related work now interleave, guessed
markdown candidates emit misleading red errors, and CI output is harder to trust during
pipeline failures. This feature redesigns crawl logging so operators can understand what
the crawler is doing, which failures are expected fallbacks, which failures are terminal,
and whether the run is progressing, degraded, or aborted.

This is an observability change only. Crawl behavior, fetch policy, retry semantics, and
saved content should remain the same unless a small code-shape change is required to emit
clearer logs.

## Goals

- Make crawl logs trustworthy under parallel execution by emitting one atomic console call
  per logical event
- Eliminate false-positive red errors for guessed markdown candidates when another
  candidate later succeeds
- Group guessed URL attempts under the original URL so operators can understand fallback
  behavior without reconstructing it manually
- Make temporary blockers such as rate limits and retries explicit in CI output
- Provide concise seed-level and run-level summaries so failed pipelines can often be
  diagnosed without reproducing locally

## User Stories

### US-001: Add structured plain-text logging primitives
**Status:** pending
**Description:** As a developer, I want a small internal logging helper in `src/crawl.ts`
so that all crawl events use stable severity prefixes and consistent formatting.

**Acceptance Criteria:**
- [ ] `src/crawl.ts` defines a small internal severity model for crawl output:
  `INFO`, `NOTICE`, `WARN`, `ERROR`, `SUMMARY`
- [ ] Crawl events are emitted in a stable plain-text shape such as
  `[LEVEL] event.name key=value key=value`
- [ ] Each logical event is emitted with exactly one `console.log`, `console.warn`, or
  `console.error` call, even when the rendered message spans multiple lines
- [ ] Existing ad hoc ANSI-colored strings such as `Error fetching ...` and
  `Aborting: 3 consecutive 429 responses` are replaced by the structured formatter
- [ ] No external logging library or JSON logger is introduced
- [ ] `npx tsc --noEmit -p tsconfig.node.json` passes
- [ ] `npm run lint:js` passes

### US-002: Group markdown guess outcomes by original URL
**Status:** pending
**Description:** As a pipeline operator, I want all guessed markdown attempts reported
under the original URL so that fallback behavior is visible without noisy standalone
errors.

**Acceptance Criteria:**
- [ ] When an original URL spawns markdown guesses, the crawler creates group state keyed
  by the original URL
- [ ] Each candidate in the group records its attempt kind (`original` or `guess`) and
  terminal outcome (`success`, HTTP status, retry exhaustion, or other error reason)
- [ ] Failed guess candidates do not emit standalone red errors while the group is still
  unresolved
- [ ] If any candidate in the group succeeds, the crawler emits exactly one grouped
  `NOTICE` or low-noise `INFO` event for the original URL
- [ ] The grouped success event includes the winner URL and all attempts resolved so far
- [ ] If the original URL and all guesses fail, the crawler emits exactly one grouped
  `ERROR` event for the original URL
- [ ] The grouped failure event includes every attempted candidate and its terminal
  outcome in one console call
- [ ] Sibling guesses may still finish after the group closes, but they must not emit a
  second visible group result
- [ ] Existing guess-fetch behavior is preserved: guessed URLs are still fetched at most
  once per seed
- [ ] `npx tsc --noEmit -p tsconfig.node.json` passes
- [ ] `npm run lint:js` passes

### US-003: Make blockers, retries, and aborts explicit
**Status:** pending
**Description:** As a CI user, I want temporary blockers and terminal failures to be
clearly labeled so I can tell whether the crawler is waiting, retrying, or giving up.

**Acceptance Criteria:**
- [ ] A rate-limited primary URL emits a `WARN` event that includes at least:
  `url`, `domain`, `retry_in_ms`, and the next action taken
- [ ] Requeued primary URLs log retry visibility at `WARN` level instead of generic error
  text
- [ ] Aborting after three consecutive 429 responses emits one `ERROR` event that states
  the abort condition and its effect on the run
- [ ] Terminal primary URL failure after retry exhaustion emits one `ERROR` event that
  includes the URL, terminal reason, and retry count
- [ ] Unexpected exceptions escaping normal crawl handling emit a structured `ERROR`
  event instead of a partially formatted message
- [ ] 404 and 406 responses for guessed URLs never emit independent `ERROR` lines
- [ ] `npx tsc --noEmit -p tsconfig.node.json` passes
- [ ] `npm run lint:js` passes

### US-004: Emit lifecycle and summary events for crawl progress
**Status:** pending
**Description:** As a pipeline operator, I want run-start, seed-start, save, rewrite,
seed-summary, and run-summary messages so I can understand progress without reading raw
code.

**Acceptance Criteria:**
- [ ] The crawl emits one run-start event before work begins that includes:
  `content_dir`, `downloads_dir`, `concurrency_per_domain`, and `seed_count`
- [ ] The crawl emits one seed-start event per seed that includes:
  `seed`, `scope_prefix`, `additional_scope_prefixes`, and `local_prefix`
- [ ] Successful content writes emit a structured `INFO` event such as `content.saved`
  that includes save `status`, source `url`, and saved `path`
- [ ] Link rewriting emits a structured `INFO` or `SUMMARY` event that includes at least
  scanned markdown file count and changed markdown file count
- [ ] Each seed emits one end-of-seed summary event that includes fetched count, success
  counts, skipped counts, failed count, and whether that seed aborted
- [ ] The crawl emits one final run summary event that includes total fetched pages,
  metadata path, overall result (`success`, `partial`, or `aborted`), total failures, and
  seeds completed vs aborted
- [ ] Existing crawl behavior is preserved: metadata writing, link rewriting, and saved
  content remain functionally unchanged apart from log output
- [ ] `npx tsc --noEmit -p tsconfig.node.json` passes
- [ ] `npm run lint:js` passes

### US-005: Add regression tests for visible logging behavior
**Status:** pending
**Description:** As a developer, I want console-output tests around grouped guesses and
blockers so that future crawl refactors do not reintroduce misleading logs.

**Acceptance Criteria:**
- [ ] Add a dedicated logging-focused test file, or extend an existing crawl behavior test
  file, to capture `console.log`, `console.warn`, and `console.error`
- [ ] A grouped-success test verifies:
  original URL fails, one guess succeeds, no standalone candidate error is emitted, and
  exactly one grouped success/notice event is visible
- [ ] A grouped-all-fail test verifies:
  original URL and all guesses fail, and exactly one grouped error event contains all
  candidate outcomes together
- [ ] A rate-limit visibility test verifies:
  rate limiting logs a `WARN` event with delay and next action
- [ ] An abort-visibility test verifies:
  three consecutive 429 responses emit one terminal `ERROR` event
- [ ] Existing behavioral coverage remains intact for guessed markdown fetches and
  seed-scoped deduping
- [ ] The verification command excludes the known-broken `test/crawl.test.ts` and
  `test/crawl-metadata.test.ts`
- [ ] `node --test test/fetch.test.ts test/parse.test.ts test/project-structure.test.ts test/queue-manager.test.ts test/crawl-queue-behavior.test.ts test/rewrite-links.test.ts test/crawl-logging.test.ts`
  passes
- [ ] `npx tsc --noEmit -p tsconfig.node.json` passes

## Functional Requirements

1. FR-1: The crawler must emit crawl lifecycle output using stable severity prefixes:
   `INFO`, `NOTICE`, `WARN`, `ERROR`, `SUMMARY`.
2. FR-2: Each logical event must be emitted via a single console call so related output
   does not interleave across parallel fetches.
3. FR-3: Markdown guess attempts must be grouped by original URL, not logged as
   independent terminal events.
4. FR-4: A grouped success event must identify the winning URL and include the outcomes
   of attempted siblings.
5. FR-5: A grouped failure event must be emitted only after the original URL and all
   guesses have failed.
6. FR-6: Guess-candidate 404 and 406 results must never produce standalone `ERROR`
   output.
7. FR-7: Rate limits and retries must emit `WARN` events that explain the current block
   and the next action.
8. FR-8: Abort conditions and retry-exhausted primary URL failures must emit `ERROR`
   events with enough detail to diagnose the failure from CI logs.
9. FR-9: The crawl must emit one run-start event and one seed-start event before fetch
   processing begins.
10. FR-10: Successful content writes must emit structured save events that include save
    status and destination path.
11. FR-11: Link rewrite completion, seed summaries, and final run summary must emit
    stable structured events.
12. FR-12: The feature must remain local to the crawler flow and must not require a
    queue-manager redesign or an external logging dependency.

## Non-Goals

- No external logger package
- No JSON log output or machine-readable event stream
- No new CLI flags for log verbosity in this pass
- No change to crawl scope rules, fetch policy, retry thresholds, or content parsing
- No redesign of `QueueManager` beyond what is needed for log context
- No per-request queue submission spam or fine-grained in-flight trace logging

## Design Considerations

- Prefer short event names that are easy to grep, such as `seed.start`,
  `content.saved`, `fetch.rate_limited`, `fetch.guess_resolved`,
  `fetch.guess_failed`, `seed.summary`, and `run.summary`
- Keep detail in key-value form where practical so CI users can scan and grep output
- Grouped guess events may render as a multi-line block, but the block must still be
  emitted through one console call
- Red output should mean something actionable; expected fallback misses should not look
  like terminal failures

## Technical Considerations

- Keep the implementation centered in `src/crawl.ts`, where retry, guessing, save, and
  summary decisions already live
- Extending `PendingUrl` with guess-group context and adding a guess-group state map keyed
  by original URL is the preferred shape
- Small local helper types such as `LogLevel`, `GuessAttemptKind`, `GuessAttemptOutcome`,
  and `GuessGroupState` are in scope
- If structured save events need path and status in one place, it is acceptable to change
  `saveContent()` so logging happens from the crawl flow rather than from inside the save
  helper
- Tests should assert on stable substrings and severity prefixes rather than exact full
  message text to avoid brittle wording-only failures
- The repository currently has two known-broken tests:
  `test/crawl.test.ts` and `test/crawl-metadata.test.ts`; verification for this feature
  must rely on targeted working tests plus typecheck

## Success Metrics

- A successful guessed markdown fallback produces one grouped non-error event and zero
  standalone candidate error lines
- A fully failed guess family produces one grouped error block that contains all attempts
- CI operators can tell from logs alone whether the crawler is starting, progressing,
  blocked by rate limiting, partially failing, or aborted
- `npx tsc --noEmit -p tsconfig.node.json` passes
- The targeted working test suite for crawl logging and crawl behavior passes

## Open Questions

None. The brainstorm document already validated the design direction and scope.
