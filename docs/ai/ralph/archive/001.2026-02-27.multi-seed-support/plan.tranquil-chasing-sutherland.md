# Support Multiple Seeds

## Context

The crawler currently supports a single seed URL (`https://code.claude.com/docs/llms.txt`) with one scope prefix and one hardcoded additional scope prefix array. We need to add a second seed (`https://platform.claude.com/llms.txt`) with its own scope prefix (`https://platform.claude.com/docs/en`). Rather than bolting on a second set of globals, we refactor the configuration into an array of seed configs.

## Changes

### 1. Replace hardcoded constants with a `SEEDS` array (`src/crawl.ts:14-18`)

Replace:
```typescript
const SEED_URL = "https://code.claude.com/docs/llms.txt"
const SCOPE_PREFIX = "https://code.claude.com/docs/en/"
const ADDITIONAL_SCOPE_PREFIXES = [
  "https://github.com/aws-solutions-library-samples",
]
```

With:
```typescript
interface SeedConfig {
  seedUrl: string
  scopePrefix: string
  additionalScopePrefixes: string[]
}

const SEEDS: SeedConfig[] = [
  {
    seedUrl: "https://code.claude.com/docs/llms.txt",
    scopePrefix: "https://code.claude.com/docs/en/",
    additionalScopePrefixes: ["https://github.com/aws-solutions-library-samples"],
  },
  {
    seedUrl: "https://platform.claude.com/llms.txt",
    scopePrefix: "https://platform.claude.com/docs/en",
    additionalScopePrefixes: [],
  },
]
```

### 2. Update `crawl()` initialization (`src/crawl.ts:232-281`)

- Derive `seeds` from env vars (for tests) or fall back to `SEEDS`:
  ```typescript
  const seeds: SeedConfig[] = process.env["SEED_URL"]
    ? [{
        seedUrl: process.env["SEED_URL"],
        scopePrefix: process.env["SCOPE_PREFIX"] ?? process.env["SEED_URL"],
        additionalScopePrefixes: [],
      }]
    : SEEDS
  ```
- Build merged `scopePrefixes` from all seeds:
  ```typescript
  const scopePrefixes = seeds.flatMap(s => [s.scopePrefix, ...s.additionalScopePrefixes])
  ```
- Collect primary scope prefixes for the HTML canonical-extraction logic:
  ```typescript
  const primaryScopePrefixes = seeds.map(s => s.scopePrefix)
  ```
- Enqueue all seed URLs:
  ```typescript
  for (const seed of seeds) {
    enqueue(seed.seedUrl)
  }
  ```

### 3. Fix HTML domain check (`src/crawl.ts:296`)

Replace:
```typescript
const isCodeDomain = result.finalUrl.startsWith(scopePrefix)
```
With:
```typescript
const isDocsDomain = primaryScopePrefixes.some(p => result.finalUrl.startsWith(p))
```

And update the condition on line 298 from `isCodeDomain` to `isDocsDomain`.

### 4. Update metadata types and `buildMetadata` (`src/crawl.ts:121-204`)

Change `BuildMetadataInput` and `CrawlMetadata` to use `seeds: SeedConfig[]` instead of `seedUrl: string` + `scopePrefix: string`.

The metadata JSON will change from:
```json
{ "seedUrl": "...", "scopePrefix": "...", ... }
```
To:
```json
{ "seeds": [{ "seedUrl": "...", "scopePrefix": "...", "additionalScopePrefixes": [...] }, ...], ... }
```

Update the `buildMetadata` call site at line 418-424 accordingly.

### 5. Update `generateIndexFromMetadata` (`src/generate-index.ts:48-51, 102`)

The local `CrawlMetadata` interface in this file only uses `items`, so no change needed there. But verify it doesn't break.

### 6. Update tests

- `test/crawl-metadata.test.ts`: Update `buildMetadata` calls to pass `seeds` array instead of `seedUrl`/`scopePrefix`.
- `test/crawl.test.ts`: The integration test sets `SEED_URL`/`SCOPE_PREFIX` env vars — this still works because of the env var override logic. Update metadata assertions to check `seeds` array instead of `seedUrl`/`scopePrefix`.

## Files to modify

1. `src/crawl.ts` — seed config type, crawl loop, metadata types, buildMetadata
2. `test/crawl-metadata.test.ts` — update buildMetadata test calls and assertions
3. `test/crawl.test.ts` — update metadata assertions

## Verification

1. `npm test` — all tests pass
2. `npm run typecheck` — no type errors
3. `npm run lint:js` — no lint errors
