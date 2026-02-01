# Learnings: Claude Code Docs Crawler

**Plan document:** `docs/ai/plans/2026-02-01-docs-crawler-design.md`
**Status:** Design complete, ready for implementation (no code written yet)

## Key Learnings

### Environment
- Node 24 available with native `fetch` (no axios/node-fetch needed)
- Use `"type": "module"` in package.json for ES modules + top-level await

### User Preferences (already decided, don't re-ask)
- **Retry behavior:** Failed URLs go to END of queue (not immediate retry), max 3 attempts per URL
- **429 handling:** Honor `Retry-After` header, wait the specified duration, then requeue
- **Abort condition:** 3 consecutive 429s without any successful fetch in between

### Implementation Gotchas
- **Scope check every redirect hop:** Use `redirect: 'manual'` and check scope BEFORE following each redirect, not just at the final URL
- **Consecutive 429 counter:** Resets on ANY success AND on non-429 errors (network failures, 4xx, 5xx). Only pure consecutive 429s trigger abort.
- **Queue deduplication:** Maintain both a `queue` array AND a `queued` Set — the Set provides O(1) membership checks while the array preserves order
- **Directory URLs:** If URL path ends in `/` or has no file extension, append `index.txt` when saving (otherwise `fs.writeFile` fails or creates wrong structure)

### Architecture
- 3 files total: `crawl.js` (entry + state), `lib/fetch.js` (redirect handling), `lib/parse.js` (URL extraction)
- `fetchWithRedirects()` returns typed result objects (`{ type: 'success' | 'error' | 'rate-limited' | 'out-of-scope', ... }`) — caller handles all state mutations
