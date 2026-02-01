# Claude Code Docs Crawler — Design Document

**Date:** 2026-02-01
**Status:** Ready for implementation

## Overview

A Node.js CLI tool that crawls `https://code.claude.com/docs/` starting from `llms.txt`, saving all in-scope content locally for offline access or further processing.

## Requirements

### Functional
- Seed from `https://code.claude.com/docs/llms.txt`
- Save content to `./content/<host>/<path>` (e.g., `content/code.claude.com/docs/en/best-practices.md`)
- Only crawl URLs matching `https://code.claude.com/docs/**`
- Follow redirects only if they stay within scope
- Parse fetched content for new URLs (markdown links, HTML hrefs, bare URLs)
- Deduplicate URLs (normalize by stripping fragments, resolving relative paths)

### Error Handling
- On fetch failure: requeue to end of queue, max 3 attempts per URL
- On 429 (rate limited): honor `Retry-After` header, wait, then requeue
- Abort if 3 consecutive 429s occur without any successful fetch in between
- Non-429 errors reset the consecutive-429 counter

## Architecture

### File Structure
```
crawl.js            — entry point; queue, state, and crawl loop
lib/
  fetch.js          — fetch with manual redirect handling + 429 support
  parse.js          — URL extraction and normalization
content/            — output directory (gitignored)
```

### Dependencies
None. Uses Node 24's native `fetch`, `fs/promises`, `path`, and `URL`.

## Detailed Design

### State Management (crawl.js)

```javascript
const SEED_URL = 'https://code.claude.com/docs/llms.txt';
const SCOPE_PREFIX = 'https://code.claude.com/docs/';

const queue = [];              // URLs waiting to be fetched
const queued = new Set();      // O(1) check: is URL in queue?
const fetched = new Set();     // URLs successfully fetched
const attempts = new Map();    // url → attempt count (1-3)
let consecutive429s = 0;       // abort at 3
```

**Queue operations:**
- `enqueue(url)`: normalize, skip if in `queued` or `fetched`, else add
- `dequeue()`: shift from queue, remove from `queued`
- `requeue(url)`: push to end, re-add to `queued`

### Utilities

```javascript
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
```

### Crawl Loop

The crawl loop uses top-level `await` (enabled by `"type": "module"` in package.json):

```javascript
enqueue(SEED_URL);

while (queue.length > 0) {
    const url = dequeue();
    const attemptCount = (attempts.get(url) || 0) + 1;

    if (attemptCount > 3) {
        console.log(`Giving up on ${url} after 3 attempts`);
        continue;
    }
    attempts.set(url, attemptCount);

    const result = await fetchWithRedirects(url, SCOPE_PREFIX);

    switch (result.type) {
        case 'success':
            consecutive429s = 0;
            fetched.add(result.finalUrl);
            queued.delete(result.finalUrl);  // handle redirect collision
            await saveContent(result.finalUrl, result.body);
            for (const newUrl of parseUrls(result.body, result.finalUrl, SCOPE_PREFIX)) {
                enqueue(newUrl);
            }
            break;

        case 'rate-limited':
            consecutive429s++;
            if (consecutive429s >= 3) {
                console.error('Aborting: 3 consecutive 429 responses');
                process.exit(1);
            }
            const delay = result.retryAfter || 5000;
            console.log(`Rate limited, waiting ${delay}ms...`);
            await sleep(delay);
            requeue(url);
            break;

        case 'error':
            consecutive429s = 0;  // non-429 resets the streak
            console.log(`Error fetching ${url}: ${result.reason || result.status}`);
            requeue(url);
            break;

        case 'out-of-scope':
            console.log(`Skipped out-of-scope redirect: ${url} → ${result.redirectedTo}`);
            break;
    }
}

console.log(`Done. Fetched ${fetched.size} pages.`);
```

### Fetch with Redirect Handling (lib/fetch.js)

```javascript
export async function fetchWithRedirects(url, scopePrefix, maxRedirects = 10) {
    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount < maxRedirects) {
        let response;
        try {
            response = await fetch(currentUrl, { redirect: 'manual' });
        } catch (err) {
            return { type: 'error', reason: err.message };
        }

        // Handle redirects (3xx)
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
                return { type: 'error', reason: 'Redirect without Location header' };
            }

            const nextUrl = new URL(location, currentUrl).href;
            if (!nextUrl.startsWith(scopePrefix)) {
                return { type: 'out-of-scope', originalUrl: url, redirectedTo: nextUrl };
            }

            currentUrl = nextUrl;
            redirectCount++;
            continue;
        }

        // Handle 429
        if (response.status === 429) {
            return {
                type: 'rate-limited',
                retryAfter: parseRetryAfter(response.headers.get('retry-after'))
            };
        }

        // Handle other non-2xx
        if (!response.ok) {
            return { type: 'error', status: response.status };
        }

        // Success
        const body = await response.text();
        return { type: 'success', finalUrl: currentUrl, body };
    }

    return { type: 'error', reason: 'Too many redirects' };
}

function parseRetryAfter(header) {
    if (!header) return null;
    const seconds = parseInt(header, 10);
    return isNaN(seconds) ? null : seconds * 1000;
}
```

### URL Parsing (lib/parse.js)

```javascript
export function parseUrls(body, baseUrl, scopePrefix) {
    const found = new Set();

    // Markdown links: [text](url)
    for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        found.add(match[1].trim());
    }

    // Markdown reference links: [label]: url
    for (const match of body.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)) {
        found.add(match[1].trim());
    }

    // HTML href attributes
    for (const match of body.matchAll(/href=["']([^"']+)["']/gi)) {
        found.add(match[1].trim());
    }

    // Bare HTTPS URLs
    for (const match of body.matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
        found.add(match[0]);
    }

    // Resolve, normalize, filter
    const results = [];
    for (const raw of found) {
        try {
            const resolved = new URL(raw, baseUrl);
            resolved.hash = '';  // strip fragment
            const normalized = resolved.href;
            if (normalized.startsWith(scopePrefix)) {
                results.push(normalized);
            }
        } catch {
            // Invalid URL, skip
        }
    }

    return [...new Set(results)];
}
```

### File Saving

```javascript
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function saveContent(url, body) {
    const parsed = new URL(url);
    let filePath = path.join('content', parsed.host, parsed.pathname);

    // Handle directory-style URLs
    if (filePath.endsWith('/') || !path.extname(filePath)) {
        filePath = path.join(filePath, 'index.txt');
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body, 'utf-8');
    console.log(`Saved: ${filePath}`);
}
```

## Project Setup

### .gitignore addition
```
content/
```

### package.json
```json
{
  "name": "claude-code-docs-crawler",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "crawl": "node crawl.js"
  }
}
```

## Usage

```bash
npm run crawl
# or directly:
node crawl.js
```

Output will be saved to `./content/code.claude.com/docs/...`

## Edge Cases Handled

| Scenario | Behavior |
|----------|----------|
| Redirect to out-of-scope URL | Log and skip (no requeue) |
| Redirect to already-fetched URL | Skip saving, continue |
| Redirect to URL in queue | Remove from queue (will use redirect result) |
| Network error | Requeue, max 3 attempts |
| HTTP 4xx/5xx (non-429) | Requeue, max 3 attempts, resets 429 counter |
| HTTP 429 | Wait for Retry-After (default 5s), requeue |
| 3 consecutive 429s | Abort entire crawl |
| URL with fragment (#section) | Strip fragment before comparison |
| Relative URL in content | Resolve against current page URL |
| Directory URL (no file extension) | Save as `<path>/index.txt` |

## Implementation Order

1. Create project structure (`package.json`, `.gitignore`)
2. Implement `lib/fetch.js` (most complex, test with single URL first)
3. Implement `lib/parse.js` (can unit test independently)
4. Implement `crawl.js` (integrate all pieces)
5. Run against live endpoint, verify output

## Expected Output

```
$ node crawl.js
Saved: content/code.claude.com/docs/llms.txt
Saved: content/code.claude.com/docs/en/overview.md
Saved: content/code.claude.com/docs/en/best-practices.md
...
Done. Fetched 47 pages.
```

All content saved under `./content/code.claude.com/docs/`.
