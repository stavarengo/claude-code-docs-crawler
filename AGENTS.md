# AGENTS.md

## Known Issues

### `@eslint/json` type incompatibility with `exactOptionalPropertyTypes`

`@eslint/json` (currently at 1.0.0, the latest release) has plugin types that do not
satisfy ESLint's `Plugin` interface when `exactOptionalPropertyTypes: true` is enabled
in tsconfig. This is an upstream bug with no available fix.

The `eslint.config.ts` works around this with a cast via `@eslint/core`'s `Plugin` type:

```ts
import type { Plugin } from "@eslint/core"
// ...
plugins: { json: json as unknown as Plugin },
```

This is the only option short of removing `exactOptionalPropertyTypes` or dropping
`@eslint/json`. Do not remove this cast — it will break `tsc`.

## Tooling Notes

- Single tsconfig: `tsconfig.node.json` covers everything (`src/`, `test/`, and root
  config files). There is no `tsconfig.json`.
- ESLint uses explicit `project: ["tsconfig.node.json"]` in parserOptions (not
  `projectService`), so all files resolve against the real tsconfig with full strict
  settings.
- `jiti` is a dev dependency required for ESLint to load the TypeScript config file.

## ESM Script Guard Pattern

Scripts that are both entry points and importable modules (e.g. `src/crawl.ts`) must
guard their top-level execution so tests can import without triggering side effects:

```ts
import { fileURLToPath } from "node:url"
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && (process.argv[1] === __filename || process.argv[1].endsWith("src/crawl.ts"))) {
  main()
}
```

Do NOT use `process.argv[1].includes("crawl")` — test file paths (e.g.
`test/crawl-metadata.test.ts`) will also match.

## Crawl Configuration for Tests

`crawl()` reads `SEED_URL`, `SCOPE_PREFIX`, and `CONTENT_DIR` from environment
variables at call time, falling back to hardcoded defaults. Integration tests
override these via `process.env` before calling `crawl()` and restore them in a
`finally` block. No dependency injection or constructor changes needed.
