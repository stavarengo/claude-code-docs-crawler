# claude-code-docs-crawler

Crawls documentation from [code.claude.com](https://code.claude.com) and related GitHub repositories, saves it locally as markdown, and produces an index for quick navigation. Links between pages are rewritten to relative paths so the local copy works without network access.

## How it works

The pipeline has three steps, each a standalone script:

1. **Crawl** — starts from a seed URL, follows links within a defined scope, downloads content as markdown. Handles redirects, rate limiting, and incremental updates (only re-downloads changed pages). Outputs files under `content/docs/` and a `crawl-metadata.json` that records what was fetched.

2. **Generate index** — reads the metadata and produces `content/docs/index.md`, a compact directory listing. Designed so an agent or reader can find a file path quickly without walking the whole tree.

3. **Rewrite links** — walks all downloaded markdown files and replaces absolute URLs with relative paths using the URL-to-local-path mappings from the crawl metadata. Skips URLs inside fenced code blocks.

## Prerequisites

- Node.js 24.12.0
- npm

## Setup

```sh
npm install
```

## Running

Crawl docs and fetch all linked pages:

```sh
npm run crawl
```

Regenerate the navigation index after a crawl:

```sh
npm run generateIndex
```

Rewrite absolute links to relative paths:

```sh
npx tsx src/rewrite-links.ts
```

Pass `--show-diff` to see exactly what changed:

```sh
npx tsx src/rewrite-links.ts --show-diff
```

## Configuration

All configuration is via environment variables with sensible defaults:

| Variable | Default | Description |
|---|---|---|
| `SEED_URL` | `https://code.claude.com/docs/llms.txt` | Starting URL for the crawl |
| `SCOPE_PREFIX` | `https://code.claude.com/docs/en/` | Primary domain boundary |
| `CONTENT_DIR` | `./content` | Where downloaded files are saved |

## Project layout

```
src/
  crawl.ts            — main crawler (BFS queue, dedup, incremental tracking)
  fetch.ts            — HTTP layer (redirects, rate limiting, content-type filtering)
  parse.ts            — extracts URLs from markdown and HTML
  generate-index.ts   — builds the compact directory index
  rewrite-links.ts    — absolute-to-relative link rewriting
  url-resolution.ts   — shared types for URL mapping

test/                 — Node.js native test runner, one file per module

content/
  docs/               — downloaded documentation
  crawl-metadata.json — crawl state, URL mappings, change tracking
```

## Development

Type check:

```sh
npm run typecheck
```

Run tests:

```sh
npm test
```

Lint:

```sh
npm run lint
npm run lint:fix
```

Update dependencies:

```sh
npm run ncu
```
