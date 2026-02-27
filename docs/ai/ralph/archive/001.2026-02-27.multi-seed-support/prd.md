# PRD: Multi-Seed Crawler Support

**Project:** claude-code-docs-crawler
**Branch:** main

## Introduction

The crawler currently supports a single hardcoded seed URL (`https://code.claude.com/docs/llms.txt`) with one scope prefix and one additional scope prefix array. We need to crawl a second documentation source (`https://platform.claude.com/llms.txt`) with its own scope prefix (`https://platform.claude.com/docs/en`). Rather than duplicating globals, we refactor the configuration into an array of seed configs so the crawler can handle any number of seeds in a single run.

## Goals

- Support crawling multiple seed URLs in a single `npm run crawl` invocation
- Each seed has its own scope prefix and optional additional scope prefixes
- Crawled content from all seeds is saved into the same `content/docs/` tree (separated by host)
- Metadata reflects all seeds used in the crawl
- Existing tests continue to pass (env var override still works for test isolation)

## User Stories

### US-001: Define SeedConfig type and SEEDS array
**Status:** done
**Description:** As a developer, I want seed configuration expressed as a typed array so that adding new seeds is a one-line change.

**Acceptance Criteria:**
- [ ] Export a `SeedConfig` interface from `src/crawl.ts` with fields: `seedUrl: string`, `scopePrefix: string`, `additionalScopePrefixes: string[]`
- [ ] Replace the three constants (`SEED_URL`, `SCOPE_PREFIX`, `ADDITIONAL_SCOPE_PREFIXES`) at `src/crawl.ts:14-18` with a single `SEEDS: SeedConfig[]` array containing both seeds:
  - `{ seedUrl: "https://code.claude.com/docs/llms.txt", scopePrefix: "https://code.claude.com/docs/en/", additionalScopePrefixes: ["https://github.com/aws-solutions-library-samples"] }`
  - `{ seedUrl: "https://platform.claude.com/llms.txt", scopePrefix: "https://platform.claude.com/docs/en", additionalScopePrefixes: [] }`
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] Lint passes (`npm run lint:js`)

### US-002: Update crawl() to use multiple seeds
**Status:** done
**Description:** As a developer, I want `crawl()` to enqueue all seed URLs and merge all scope prefixes so that content from every seed is discovered and fetched.

**Acceptance Criteria:**
- [ ] When `SEED_URL` env var is set, `crawl()` uses a single-element seeds array built from `SEED_URL`/`SCOPE_PREFIX` env vars (preserving test isolation)
- [ ] When no env var is set, `crawl()` uses the `SEEDS` constant
- [ ] `scopePrefixes` is derived from all seeds: `seeds.flatMap(s => [s.scopePrefix, ...s.additionalScopePrefixes])`
- [ ] All seed URLs are enqueued at startup (not just one)
- [ ] The HTML canonical-extraction branch (`isCodeDomain` at line 296) checks against all primary scope prefixes (`seeds.map(s => s.scopePrefix)`) instead of just the single `scopePrefix`
- [ ] Rename `isCodeDomain` to `isDocsDomain` to reflect its generalized meaning
- [ ] Typecheck passes
- [ ] Lint passes

### US-003: Update metadata types and buildMetadata
**Status:** done
**Description:** As a developer, I want crawl metadata to record all seeds used so that downstream tools know the full crawl configuration.

**Acceptance Criteria:**
- [ ] `BuildMetadataInput` replaces `seedUrl: string` and `scopePrefix: string` with `seeds: SeedConfig[]`
- [ ] `CrawlMetadata` replaces `seedUrl: string` and `scopePrefix: string` with `seeds: SeedConfig[]`
- [ ] `buildMetadata()` returns `seeds` array in the output object instead of `seedUrl`/`scopePrefix`
- [ ] The `crawl()` call site passes the `seeds` array to `buildMetadata()`
- [ ] The output `crawl-metadata.json` has shape `{ seeds: [...], lastUpdate, result, stats, items, urlResolution }`
- [ ] Typecheck passes
- [ ] Lint passes

### US-004: Update tests for multi-seed metadata
**Status:** done
**Description:** As a developer, I want existing tests to pass with the new metadata shape so that confidence in correctness is maintained.

**Acceptance Criteria:**
- [ ] All `buildMetadata()` calls in `test/crawl-metadata.test.ts` pass `seeds: [{ seedUrl, scopePrefix, additionalScopePrefixes: [] }]` instead of `seedUrl`/`scopePrefix`
- [ ] All `buildMetadata` assertions in `test/crawl-metadata.test.ts` check `metadata.seeds[0].seedUrl` and `metadata.seeds[0].scopePrefix` instead of `metadata.seedUrl`/`metadata.scopePrefix`
- [ ] The integration test in `test/crawl.test.ts` updates its metadata type cast and assertions to use `seeds` array instead of `seedUrl`/`scopePrefix`
- [ ] All tests pass (`npm test`)
- [ ] Typecheck passes
- [ ] Lint passes

## Functional Requirements

- FR-1: `SeedConfig` interface exported from `src/crawl.ts` with `seedUrl`, `scopePrefix`, `additionalScopePrefixes` fields
- FR-2: `SEEDS` array replaces `SEED_URL`, `SCOPE_PREFIX`, `ADDITIONAL_SCOPE_PREFIXES` constants
- FR-3: `crawl()` enqueues all seed URLs from the seeds array at startup
- FR-4: `crawl()` builds merged `scopePrefixes` from all seeds' scope + additional scope prefixes
- FR-5: HTML canonical-extraction logic checks all primary scope prefixes, not just one
- FR-6: `SEED_URL`/`SCOPE_PREFIX` env vars override the entire seeds array with a single-element array (backward compat for tests)
- FR-7: `crawl-metadata.json` output uses `seeds: SeedConfig[]` instead of `seedUrl`/`scopePrefix`

## Non-Goals

- No per-seed metadata files (all seeds share one `crawl-metadata.json`)
- No per-seed crawl isolation (all seeds share one queue, one items map, one urlResolution map)
- No env var support for multiple seeds (env vars only used for test overrides with a single seed)
- No changes to `src/fetch.ts`, `src/parse.ts`, `src/rewrite-links.ts`, or `src/generate-index.ts`

## Technical Considerations

- `src/generate-index.ts` has its own local `CrawlMetadata` interface that only reads `items` — it does not reference `seedUrl`/`scopePrefix`, so it needs no changes
- `fetchWithRedirects()` and `parseUrls()` already accept `scopePrefixes: string[]` — no changes needed
- `rewriteMarkdownLinksInContent()` operates on the shared `urlResolution` map — no changes needed
- The queue, `items` map, and `urlResolution` are naturally shared across seeds since content is keyed by host+path

## Success Metrics

- All existing tests pass without modification to test logic (only metadata shape assertions change)
- `npm run typecheck` and `npm run lint:js` pass
- Running `npm run crawl` produces content under both `content/docs/code.claude.com/` and `content/docs/platform.claude.com/`

## Open Questions

None — the scope is well-defined.
