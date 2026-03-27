import { mkdir, writeFile, readFileSync, existsSync } from "node:fs"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { execSync } from "node:child_process"
import type { FetchResult } from "./fetch.js"
import { parseUrls } from "./parse.js"
import { rewriteMarkdownLinksInContent } from "./rewrite-links.js"
import type { UrlResolutionEntry } from "./url-resolution.js"
import { QueueManager } from "./queue-manager.js"
import { parseCliArgs } from "./cli.js"

const mkdirAsync = promisify(mkdir)
const writeFileAsync = promisify(writeFile)

export interface SeedConfig {
  seedUrl: string
  scopePrefix: string
  additionalScopePrefixes: string[]
  localPrefix: string
}

export const SEEDS: SeedConfig[] = [
  {
    seedUrl: "https://code.claude.com/docs/llms.txt",
    scopePrefix: "https://code.claude.com/docs/en/",
    additionalScopePrefixes: ["https://github.com/aws-solutions-library-samples"],
    localPrefix: "claude",
  },
  {
    seedUrl: "https://platform.claude.com/llms.txt",
    scopePrefix: "https://platform.claude.com/docs/en",
    additionalScopePrefixes: [],
    localPrefix: "claude",
  },
  {
    seedUrl: "https://developers.openai.com/api/docs/llms.txt",
    scopePrefix: "https://developers.openai.com/api/docs/",
    additionalScopePrefixes: [],
    localPrefix: "openai",
  },
  {
    seedUrl: "https://developers.openai.com/api/reference/llms.txt",
    scopePrefix: "https://developers.openai.com/api/reference/",
    additionalScopePrefixes: [],
    localPrefix: "openai",
  },
  // {
  //   seedUrl: "https://modelcontextprotocol.io/llms.txt",
  //   scopePrefix: "https://modelcontextprotocol.io/",
  //   additionalScopePrefixes: [],
  //   localPrefix: "mcp",
  // },
]

function getRepoRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  try {
    const topLevel = execSync("git rev-parse --show-toplevel", {
      cwd: moduleDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf-8")
      .trim()

    if (topLevel) {
      return path.resolve(topLevel)
    }
  } catch {
    // fall back
  }

  return path.resolve(moduleDir, "..")
}

const REPO_ROOT = getRepoRoot()
const DEFAULT_CONTENT_DIR = path.join(REPO_ROOT, "content")
const DOWNLOADS_SUBDIR = "docs"

function assertWithinRepoRoot(absPath: string, label: string) {
  const normalized = path.resolve(absPath)
  const rootWithSep = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : `${REPO_ROOT}${path.sep}`
  if (!normalized.startsWith(rootWithSep)) {
    throw new Error(`${label} must be within repo root: ${REPO_ROOT}`)
  }
}

function resolveContentDir(contentDir: string): string {
  const abs = path.isAbsolute(contentDir)
    ? path.resolve(contentDir)
    : path.resolve(REPO_ROOT, contentDir)

  assertWithinRepoRoot(abs, "CONTENT_DIR")
  return abs
}

function normalize(url: string): string | null {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    return parsed.href
  } catch {
    return null
  }
}

function toRawGitHubUrl(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/.exec(url)
  if (!match) return null
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}`
}

function extractCanonical(html: string): string | null {
  const match = (/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html))
    ?? (/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(html))
  return match?.[1] ?? null
}

function getMarkdownGuesses(url: string): string[] {
  if (url.endsWith(".md")) return []
  if (url.endsWith("/")) {
    return [
      `${url}index.md`,
      `${url.slice(0, -1)}.md`,
    ]
  }
  return [`${url}.md`]
}

export type SaveResult = "new" | "changed" | "unchanged"

export async function saveContent(url: string, body: string, contentDir: string = DEFAULT_CONTENT_DIR, localPrefix: string = ""): Promise<SaveResult> {
  const resolvedContentDir = resolveContentDir(contentDir)
  const parsed = new URL(url)
  let filePath = localPrefix
    ? path.join(resolvedContentDir, localPrefix, parsed.host, parsed.pathname)
    : path.join(resolvedContentDir, parsed.host, parsed.pathname)

  // Handle directory-style URLs
  if (filePath.endsWith("/") || !path.extname(filePath)) {
    filePath = path.join(filePath, "index.txt")
  }

  // Compare against existing file to determine change status
  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, "utf-8")
    if (existing === body) {
      return "unchanged"
    }
    await mkdirAsync(path.dirname(filePath), { recursive: true })
    await writeFileAsync(filePath, body, "utf-8")
    console.log(`Saved: ${filePath}`)
    return "changed"
  }

  await mkdirAsync(path.dirname(filePath), { recursive: true })
  await writeFileAsync(filePath, body, "utf-8")
  console.log(`Saved: ${filePath}`)
  return "new"
}

export interface ItemRecord {
  status: string
  statusReason: string
  fetchedAt: string
}

export interface BuildMetadataInput {
  seeds: SeedConfig[]
  items: Map<string, ItemRecord>
  urlResolution?: Record<string, UrlResolutionEntry>
  aborted: boolean
}

export interface CrawlMetadata {
  seeds: SeedConfig[]
  lastUpdate: string
  result: "success" | "partial" | "aborted"
  stats: Record<string, number>
  items: Record<string, ItemRecord>
  urlResolution: Record<string, UrlResolutionEntry>
}

export function buildMetadata({ seeds, items, urlResolution, aborted }: BuildMetadataInput): CrawlMetadata {
  // Determine result
  let result: "success" | "partial" | "aborted"
  if (aborted) {
    result = "aborted"
  } else {
    let hasFailure = false
    for (const item of items.values()) {
      if (item.status === "failed") {
        hasFailure = true
        break
      }
    }
    result = hasFailure ? "partial" : "success"
  }

  // Compute stats in a single pass
  const stats: Record<string, number> = {
    uniqueUrls: items.size,
    success: 0,
    "success.new": 0,
    "success.changed": 0,
    "success.unchanged": 0,
    "success.removed": 0,
    skipped: 0,
    "skipped.outOfScope": 0,
    "skipped.duplicate": 0,
    "skipped.redirectOutOfScope": 0,
    "skipped.redirectDuplicate": 0,
    failed: 0,
    "failed.httpError": 0,
  }

  function inc(key: string) {
    stats[key] = (stats[key] ?? 0) + 1
  }

  for (const item of items.values()) {
    if (item.status === "success") {
      inc("success")
      inc(`success.${item.statusReason}`)
    } else if (item.status === "skipped") {
      inc("skipped")
      inc(`skipped.${item.statusReason}`)
    } else if (item.status === "failed") {
      inc("failed")
      inc(`failed.${item.statusReason}`)
    }
  }

  // Convert items map to plain object
  const itemsObj: Record<string, ItemRecord> = {}
  for (const [key, value] of items) {
    itemsObj[key] = value
  }

  return {
    seeds,
    lastUpdate: new Date().toISOString(),
    result,
    stats,
    items: itemsObj,
    urlResolution: urlResolution ?? {},
  }
}

export function markRemovedItems(
  previousItems: Record<string, ItemRecord>,
  currentItems: Map<string, ItemRecord>,
): void {
  for (const [key, item] of Object.entries(previousItems)) {
    if (item.status === "success" && !currentItems.has(key)) {
      currentItems.set(key, {
        status: "success",
        statusReason: "removed",
        fetchedAt: item.fetchedAt,
      })
    }
  }
}

function urlToRelativePath(url: string, localPrefix: string = ""): string {
  const parsed = new URL(url)
  let filePath = localPrefix
    ? path.join(localPrefix, parsed.host, parsed.pathname)
    : path.join(parsed.host, parsed.pathname)
  if (filePath.endsWith("/") || !path.extname(filePath)) {
    filePath = path.join(filePath, "index.txt")
  }
  return filePath
}

interface CrawlGroupResult {
  items: Map<string, ItemRecord>
  urlResolution: Record<string, UrlResolutionEntry>
  fetchedCount: number
  aborted: boolean
}

interface PendingUrl {
  url: string
  bestEffort: boolean
}

async function crawlSeed(
  seed: SeedConfig,
  downloadsDir: string,
  queueManager: QueueManager,
): Promise<CrawlGroupResult> {
  const scopePrefixes = [seed.scopePrefix, ...seed.additionalScopePrefixes]
  const primaryScopePrefix = seed.scopePrefix
  const localPrefix = seed.localPrefix

  const pending: PendingUrl[] = []
  let pendingIdx = 0
  const accepted = new Set<string>()
  const fetched = new Set<string>()
  const consecutiveErrors = new Map<string, { count: number, error: string }>()
  let consecutive429s = 0
  let aborted = false

  const items = new Map<string, ItemRecord>()
  const urlResolution: Record<string, UrlResolutionEntry> = {}

  function enqueue(url: string, opts?: { bestEffort?: boolean }) {
    const normalized = normalize(url)
    if (!normalized) return
    if (accepted.has(normalized)) return
    pending.push({
      url: normalized,
      bestEffort: opts?.bestEffort === true,
    })
    accepted.add(normalized)
  }

  function enqueueMarkdownGuesses(url: string) {
    for (const guess of getMarkdownGuesses(url)) {
      enqueue(guess, { bestEffort: true })
    }
  }

  function requeue(entry: PendingUrl) {
    pending.push(entry)
  }

  function markFailed(url: string) {
    items.set(url, {
      status: "failed",
      statusReason: "httpError",
      fetchedAt: new Date().toISOString(),
    })
  }

  async function processResult(entry: PendingUrl, result: FetchResult): Promise<void> {
    const { url, bestEffort } = entry

    switch (result.type) {
      case "success": {
        consecutive429s = 0
        fetched.add(result.finalUrl)

        const isHtml = result.contentType.includes("text/html")
        const isDocsDomain = result.finalUrl.startsWith(primaryScopePrefix)

        if (isHtml && isDocsDomain) {
          // HTML from docs domain: extract canonical to discover the markdown URL
          const canonical = extractCanonical(result.body)
          if (canonical && canonical !== result.finalUrl) {
            enqueue(canonical)
            enqueueMarkdownGuesses(canonical)
          }
          enqueueMarkdownGuesses(result.finalUrl)
        } else if (isHtml && result.finalUrl.startsWith("https://github.com/")) {
          // HTML from GitHub: try the raw.githubusercontent.com version if it's a .md file
          const rawUrl = toRawGitHubUrl(result.finalUrl)
          if (rawUrl?.endsWith(".md")) {
            const rawSavedPath = urlToRelativePath(rawUrl, localPrefix)
            urlResolution[url] = { finalUrl: rawUrl, savedPath: rawSavedPath }
            urlResolution[result.finalUrl] = { finalUrl: rawUrl, savedPath: rawSavedPath }
            urlResolution[rawUrl] = { finalUrl: rawUrl, savedPath: rawSavedPath }
            enqueue(rawUrl, { bestEffort: true })
          }
        } else {
          const changeStatus = await saveContent(result.finalUrl, result.body, downloadsDir, localPrefix)
          const key = urlToRelativePath(result.finalUrl, localPrefix)
          urlResolution[url] = { finalUrl: result.finalUrl, savedPath: key }
          urlResolution[result.finalUrl] = { finalUrl: result.finalUrl, savedPath: key }
          items.set(key, {
            status: "success",
            statusReason: changeStatus,
            fetchedAt: new Date().toISOString(),
          })
          for (const newUrl of parseUrls(result.body, result.finalUrl, scopePrefixes)) {
            enqueue(newUrl)
          }
        }
        break
      }

      case "rate-limited": {
        consecutive429s++
        if (consecutive429s >= 3) {
          console.error("\x1b[31mAborting: 3 consecutive 429 responses\x1b[0m")
          aborted = true
          break
        }
        const delay = result.retryAfter ?? 5000
        console.log(`Rate limited, waiting ${String(delay)}ms...`)
        const hostname = new URL(url).hostname
        queueManager.pauseDomain(hostname, delay)
        if (bestEffort) {
          markFailed(url)
          break
        }
        requeue(entry)
        break
      }

      case "error": {
        consecutive429s = 0
        const errorKey = result.status ? String(result.status) : (result.reason ?? "unknown")
        console.log(`\x1b[31mError fetching ${url}: ${errorKey}\x1b[0m`)
        if (bestEffort || result.status === 404 || result.status === 406) {
          markFailed(url)
        } else {
          const prev = consecutiveErrors.get(url)
          const entry = (prev?.error === errorKey)
            ? { count: prev.count + 1, error: errorKey }
            : { count: 1, error: errorKey }
          consecutiveErrors.set(url, entry)
          if (entry.count >= 3) {
            console.log(`\x1b[31mGiving up on ${url} after 3 consecutive ${errorKey} errors\x1b[0m`)
            markFailed(url)
          } else {
            requeue({
              url,
              bestEffort: false,
            })
          }
        }
        break
      }

      case "out-of-scope":
        console.log(`Skipped out-of-scope redirect: ${url} → ${result.redirectedTo}`)
        items.set(url, {
          status: "skipped",
          statusReason: "redirectOutOfScope",
          fetchedAt: new Date().toISOString(),
        })
        break

      case "non-text":
        console.log(`Skipped non-text content: ${url} (${result.contentType})`)
        break
    }
  }

  enqueue(seed.seedUrl)

  // Concurrent fetch loop: submit all pending URLs to the QueueManager,
  // process results as they resolve, and submit newly discovered URLs
  const inFlight = new Set<Promise<void>>()

  function submitPending(): void {
    while (pendingIdx < pending.length && !aborted) {
      const entry = pending[pendingIdx++]!
      const { url } = entry

      const promise = queueManager.fetch(url, scopePrefixes)
        .then(result => processResult(entry, result))
        .then(() => {
          inFlight.delete(promise)
          submitPending()
        })
        .catch(err => {
          inFlight.delete(promise)
          console.error(`\x1b[31mUnexpected error processing ${url}:\x1b[0m`, err)
        })
      inFlight.add(promise)
    }
  }

  submitPending()

  // Wait until all in-flight fetches complete
  while (inFlight.size > 0 && !aborted) {
    await Promise.race(inFlight)
  }

  return { items, urlResolution, fetchedCount: fetched.size, aborted }
}

// Main crawl function — accepts config via environment variables:
//   SEED_URL, SCOPE_PREFIX, CONTENT_DIR (all fall back to hardcoded defaults)
export async function crawl(opts?: { showGitDiff?: boolean, seeds?: SeedConfig[], concurrency?: number }) {
  // Determine seeds: env var override (single seed) > opts.seeds > SEEDS constant
  let seeds: SeedConfig[]
  if (process.env["SEED_URL"]) {
    seeds = [{
      seedUrl: process.env["SEED_URL"],
      scopePrefix: process.env["SCOPE_PREFIX"] ?? process.env["SEED_URL"],
      additionalScopePrefixes: [],
      localPrefix: "",
    }]
  } else {
    seeds = opts?.seeds ?? SEEDS
  }

  const contentDir = resolveContentDir(process.env["CONTENT_DIR"] ?? DEFAULT_CONTENT_DIR)
  const downloadsDir = path.join(contentDir, DOWNLOADS_SUBDIR)

  // Load prior crawl metadata if it exists
  const metadataPath = path.join(contentDir, "crawl-metadata.json")
  let previousItems: Record<string, ItemRecord> = {}
  if (existsSync(metadataPath)) {
    try {
      const prior = JSON.parse(readFileSync(metadataPath, "utf-8")) as { items?: Record<string, ItemRecord> }
      previousItems = prior.items ?? {}
    } catch {
      // Ignore malformed prior metadata
    }
  }

  const queueManager = new QueueManager(opts?.concurrency)

  // Launch all seeds concurrently — each seed has its own dedup state and
  // retry bookkeeping; only the QueueManager is shared across seeds.
  const seedResults = await Promise.all(seeds.map(seed =>
    crawlSeed(seed, downloadsDir, queueManager)
      .then(result => ({ seed, result }))))

  // Aggregate seed results by localPrefix for post-processing and metadata merge.
  const groups = new Map<string, CrawlGroupResult>()
  for (const { seed, result } of seedResults) {
    const group = groups.get(seed.localPrefix) ?? {
      items: new Map<string, ItemRecord>(),
      urlResolution: {},
      fetchedCount: 0,
      aborted: false,
    }

    for (const [key, value] of result.items) group.items.set(key, value)
    Object.assign(group.urlResolution, result.urlResolution)
    group.fetchedCount += result.fetchedCount
    group.aborted = group.aborted || result.aborted
    groups.set(seed.localPrefix, group)
  }

  // Post-group processing runs after all groups complete
  const allItems = new Map<string, ItemRecord>()
  const allUrlResolution: Record<string, UrlResolutionEntry> = {}
  let anyAborted = false
  let totalFetched = 0

  for (const [localPrefix, result] of groups) {
    // Mark pages from prior run that were not visited in this group
    const groupPreviousItems: Record<string, ItemRecord> = {}
    for (const [key, item] of Object.entries(previousItems)) {
      if (!localPrefix || key.startsWith(localPrefix + "/")) {
        groupPreviousItems[key] = item
      }
    }
    markRemovedItems(groupPreviousItems, result.items)

    // Rewrite absolute markdown links to local relative paths within this group
    const rewriteOptions = localPrefix
      ? { showGitDiff: opts?.showGitDiff === true, subDir: localPrefix }
      : { showGitDiff: opts?.showGitDiff === true }
    const rewriteResult = await rewriteMarkdownLinksInContent(downloadsDir, result.urlResolution, rewriteOptions)
    if (rewriteResult.stats.changedFiles > 0) {
      console.log(
        `Rewrote links in ${String(rewriteResult.stats.changedFiles)}/${String(rewriteResult.stats.scannedFiles)} markdown files.`,
      )
      for (const savedPath of rewriteResult.changedSavedPaths) {
        const item = result.items.get(savedPath)
        if (item?.status === "success" && item.statusReason === "unchanged") {
          item.statusReason = "changed"
        }
      }
    }

    // Merge into combined results
    for (const [key, value] of result.items) allItems.set(key, value)
    Object.assign(allUrlResolution, result.urlResolution)
    totalFetched += result.fetchedCount
    if (result.aborted) anyAborted = true
  }

  // Write crawl metadata
  const metadata = buildMetadata({
    seeds,
    items: allItems,
    urlResolution: allUrlResolution,
    aborted: anyAborted,
  })

  await mkdirAsync(path.dirname(metadataPath), { recursive: true })
  await writeFileAsync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8")
  console.log(`Metadata written to ${metadataPath}`)
  console.log(`Done. Fetched ${String(totalFetched)} pages.`)
}

// Only run crawl when executed directly as a script (not when imported)
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && (process.argv[1] === __filename || process.argv[1].endsWith("src/crawl.ts"))) {
  const cliArgs = parseCliArgs(process.argv.slice(2))
  crawl(cliArgs)
}
