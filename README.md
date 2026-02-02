# claude-code-docs-crawler

Crawls documentation from [code.claude.com](https://code.claude.com) and related GitHub repositories, saves it locally as markdown, and produces a compact index for agent navigation following [Vercel's index style](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals). Links between pages are rewritten to relative paths so the local copy works without network access.

If you just need the already-crawled docs without running the crawler yourself, grab them directly from [stavarengo/claude-code-docs](https://github.com/stavarengo/claude-code-docs).

## How it works

The pipeline has three steps, each a standalone script:

1. **Crawl** — starts from a seed URL, follows links within a defined scope, downloads content as markdown. Handles redirects, rate limiting, and incremental updates (only re-downloads changed pages). Outputs files under `content/docs/` and a `crawl-metadata.json` that records what was fetched.

2. **Generate index** — reads the metadata and produces `content/docs/index.md` using the compact `dir:{file1,file2,...}` format from [Vercel's agent indexing approach](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals). An agent reads the index to locate the right file, then fetches only that file — no need to walk the whole tree or load everything into context upfront.

3. **Rewrite links** — walks all downloaded markdown files and replaces absolute URLs with relative paths using the URL-to-local-path mappings from the crawl metadata. Skips URLs inside fenced code blocks.

## Prerequisites

- Node.js
- npm

## Setup

```sh
npm install
```

## Running

- `npm run crawl` — crawl docs and fetch all linked pages
- `npm run generateIndex` — regenerate the navigation index after a crawl
- `npm run typecheck` — type check
- `npm test` — run tests
- `npm run lint` / `npm run lint:fix` — lint

## Configuration

All configuration is via environment variables with sensible defaults:

| Variable | Default | Description |
|---|---|---|
| `SEED_URL` | `https://code.claude.com/docs/llms.txt` | Starting URL for the crawl |
| `SCOPE_PREFIX` | `https://code.claude.com/docs/en/` | Primary domain boundary |
| `CONTENT_DIR` | `./content` | Where downloaded files are saved |
