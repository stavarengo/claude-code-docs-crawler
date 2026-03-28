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
type LogLevel = "INFO" | "NOTICE" | "WARN" | "ERROR" | "SUMMARY"
type LogValue = boolean | number | string | null | undefined

function quoteLogValue(value: string): string {
  return JSON.stringify(value)
}

function formatLogValue(value: LogValue): string {
  if (value === null) return "null"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value !== "string") return String(value)
  if (value.length === 0) return "\"\""
  if (/^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]+$/.test(value)) return value
  return quoteLogValue(value)
}

function formatLogEvent(level: LogLevel, event: string, fields: Record<string, LogValue> = {}): string {
  const parts = [`[${level}]`, event]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    parts.push(`${key}=${formatLogValue(value)}`)
  }
  return parts.join(" ")
}

function logEvent(level: LogLevel, event: string, fields: Record<string, LogValue> = {}): void {
  const message = formatLogEvent(level, event, fields)
  switch (level) {
    case "WARN":
      console.warn(message)
      return
    case "ERROR":
      console.error(message)
      return
    default:
      console.log(message)
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

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
  // Split URL into path portion and suffix (query + fragment), preserved verbatim
  const qIdx = url.indexOf("?")
  const hIdx = url.indexOf("#")
  let splitAt = -1
  if (qIdx !== -1 && hIdx !== -1) splitAt = Math.min(qIdx, hIdx)
  else if (qIdx !== -1) splitAt = qIdx
  else if (hIdx !== -1) splitAt = hIdx

  const pathPart = splitAt === -1 ? url : url.slice(0, splitAt)
  const suffix = splitAt === -1 ? "" : url.slice(splitAt)

  if (pathPart.endsWith(".md")) return []

  if (pathPart.endsWith("/")) {
    return [
      `${pathPart}index.md${suffix}`,
      `${pathPart.slice(0, -1)}.md${suffix}`,
    ]
  }
  return [`${pathPart}.md${suffix}`]
}

export type SaveResult = "new" | "changed" | "unchanged"

export async function saveContent(url: string, body: string, contentDir = DEFAULT_CONTENT_DIR, localPrefix = ""): Promise<SaveResult> {
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
    return "changed"
  }

  await mkdirAsync(path.dirname(filePath), { recursive: true })
  await writeFileAsync(filePath, body, "utf-8")
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

function urlToRelativePath(url: string, localPrefix = ""): string {
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
  guessGroupOriginalUrl?: string
  guessAttemptKind?: GuessAttemptKind
}

type GuessAttemptKind = "original" | "guess"

interface GuessAttemptState {
  kind: GuessAttemptKind
  outcome?: string
}

interface GuessGroupState {
  originalUrl: string
  attempts: Map<string, GuessAttemptState>
  winnerUrl?: string
  closed: boolean
}

interface CrawlResultCounts {
  successCount: number
  skippedCount: number
  failedCount: number
}

function countItemsByStatus(items: Iterable<ItemRecord>): CrawlResultCounts {
  const counts: CrawlResultCounts = {
    successCount: 0,
    skippedCount: 0,
    failedCount: 0,
  }

  for (const item of items) {
    if (item.status === "success") {
      counts.successCount++
    } else if (item.status === "skipped") {
      counts.skippedCount++
    } else if (item.status === "failed") {
      counts.failedCount++
    }
  }

  return counts
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

  logEvent("INFO", "seed.start", {
    seed: seed.seedUrl,
    scope_prefix: seed.scopePrefix,
    additional_scope_prefixes: JSON.stringify(seed.additionalScopePrefixes),
    local_prefix: seed.localPrefix,
  })

  const items = new Map<string, ItemRecord>()
  const urlResolution: Record<string, UrlResolutionEntry> = {}
  const guessGroups = new Map<string, GuessGroupState>()

  function enqueue(url: string, opts?: {
    bestEffort?: boolean
    guessGroupOriginalUrl?: string
    guessAttemptKind?: GuessAttemptKind
  }): string | null {
    const normalized = normalize(url)
    if (!normalized) return null
    if (accepted.has(normalized)) return null
    const pendingUrl: PendingUrl = {
      url: normalized,
      bestEffort: opts?.bestEffort === true,
    }
    if (opts?.guessGroupOriginalUrl !== undefined) {
      pendingUrl.guessGroupOriginalUrl = opts.guessGroupOriginalUrl
    }
    if (opts?.guessAttemptKind !== undefined) {
      pendingUrl.guessAttemptKind = opts.guessAttemptKind
    }
    pending.push(pendingUrl)
    accepted.add(normalized)
    return normalized
  }

  function getOrCreateGuessGroup(originalUrl: string): GuessGroupState {
    let group = guessGroups.get(originalUrl)
    if (!group) {
      group = {
        originalUrl,
        attempts: new Map<string, GuessAttemptState>(),
        closed: false,
      }
      guessGroups.set(originalUrl, group)
    }
    return group
  }

  function ensureGuessAttempt(group: GuessGroupState, candidateUrl: string, kind: GuessAttemptKind): void {
    if (!group.attempts.has(candidateUrl)) {
      group.attempts.set(candidateUrl, { kind })
    }
  }

  function countResolvedAttempts(group: GuessGroupState): number {
    let resolved = 0
    for (const attempt of group.attempts.values()) {
      if (attempt.outcome !== undefined) {
        resolved++
      }
    }
    return resolved
  }

  function formatGuessAttempts(group: GuessGroupState): string {
    const parts: string[] = []
    for (const [candidateUrl, attempt] of group.attempts) {
      if (attempt.outcome === undefined) continue
      parts.push(`${attempt.kind}:${candidateUrl}->${attempt.outcome}`)
    }
    return parts.join(";")
  }

  function maybeEmitGuessGroupOutcome(group: GuessGroupState): void {
    if (group.closed) return
    const totalAttempts = group.attempts.size
    const resolvedAttempts = countResolvedAttempts(group)
    if (totalAttempts === 0 || resolvedAttempts < totalAttempts) return

    group.closed = true
    const attempts = formatGuessAttempts(group)
    if (group.winnerUrl) {
      logEvent("NOTICE", "fetch.guess_resolved", {
        original_url: group.originalUrl,
        winner_url: group.winnerUrl,
        attempts,
        resolved_attempts: resolvedAttempts,
        total_attempts: totalAttempts,
      })
      return
    }

    logEvent("ERROR", "fetch.guess_failed", {
      original_url: group.originalUrl,
      attempts,
      resolved_attempts: resolvedAttempts,
      total_attempts: totalAttempts,
    })
  }

  function recordGuessAttemptOutcome(
    entry: PendingUrl,
    outcome: string,
    opts?: { succeeded?: boolean, winnerUrl?: string },
  ): boolean {
    const groupOriginalUrl = entry.guessGroupOriginalUrl
    if (!groupOriginalUrl) return false

    const group = guessGroups.get(groupOriginalUrl)
    if (!group) return false

    const existing = group.attempts.get(entry.url)
    if (!existing) {
      group.attempts.set(entry.url, {
        kind: entry.guessAttemptKind ?? "guess",
        outcome,
      })
    } else {
      existing.outcome ??= outcome
    }

    if (opts?.succeeded) {
      group.winnerUrl ??= opts.winnerUrl ?? entry.url
    }

    maybeEmitGuessGroupOutcome(group)
    return true
  }

  function enqueueMarkdownGuesses(url: string) {
    const normalizedOriginal = normalize(url)
    if (!normalizedOriginal) return

    const group = getOrCreateGuessGroup(normalizedOriginal)
    const originalAttempt = group.attempts.get(normalizedOriginal)
    if (!originalAttempt) {
      group.attempts.set(normalizedOriginal, {
        kind: "original",
        outcome: "markdown_guess_started",
      })
    } else {
      originalAttempt.outcome ??= "markdown_guess_started"
    }

    for (const guess of getMarkdownGuesses(normalizedOriginal)) {
      const queuedGuess = enqueue(guess, {
        bestEffort: true,
        guessGroupOriginalUrl: normalizedOriginal,
        guessAttemptKind: "guess",
      })
      if (queuedGuess) {
        ensureGuessAttempt(group, queuedGuess, "guess")
      }
    }

    maybeEmitGuessGroupOutcome(group)
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
          recordGuessAttemptOutcome(entry, "html_response")
          // HTML from docs domain: extract canonical to discover the markdown URL
          const canonical = extractCanonical(result.body)
          if (canonical && canonical !== result.finalUrl) {
            enqueue(canonical)
            enqueueMarkdownGuesses(canonical)
          }
          enqueueMarkdownGuesses(result.finalUrl)
        } else if (isHtml && result.finalUrl.startsWith("https://github.com/")) {
          recordGuessAttemptOutcome(entry, "html_response")
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
          logEvent("INFO", "content.saved", {
            status: changeStatus,
            url: result.finalUrl,
            path: key,
          })
          urlResolution[url] = { finalUrl: result.finalUrl, savedPath: key }
          urlResolution[result.finalUrl] = { finalUrl: result.finalUrl, savedPath: key }
          items.set(key, {
            status: "success",
            statusReason: changeStatus,
            fetchedAt: new Date().toISOString(),
          })
          recordGuessAttemptOutcome(entry, "success", {
            succeeded: true,
            winnerUrl: result.finalUrl,
          })
          for (const newUrl of parseUrls(result.body, result.finalUrl, scopePrefixes)) {
            enqueue(newUrl)
          }
        }
        break
      }

      case "rate-limited": {
        consecutive429s++
        const delay = result.retryAfter ?? 5000
        const hostname = new URL(url).hostname
        if (consecutive429s >= 3) {
          logEvent("ERROR", "crawl.aborted", {
            reason: "consecutive_rate_limit",
            consecutive_429s: consecutive429s,
            url,
            domain: hostname,
            effect: "run_aborted",
          })
          aborted = true
          break
        }
        logEvent("WARN", "fetch.rate_limited", {
          url,
          domain: hostname,
          retry_in_ms: delay,
          next_action: bestEffort ? "mark_failed" : "requeue",
        })
        queueManager.pauseDomain(hostname, delay)
        if (bestEffort) {
          recordGuessAttemptOutcome(entry, "rate_limited")
          markFailed(url)
          break
        }
        requeue(entry)
        break
      }

      case "error": {
        consecutive429s = 0
        const errorKey = result.status ? String(result.status) : (result.reason ?? "unknown")
        if (bestEffort || result.status === 404 || result.status === 406) {
          const handledByGuessGroup = recordGuessAttemptOutcome(entry, errorKey)
          if (!handledByGuessGroup) {
            logEvent("ERROR", "fetch.failed", {
              url,
              error: errorKey,
              next_action: "mark_failed",
              best_effort: bestEffort,
            })
          }
          markFailed(url)
        } else {
          const prev = consecutiveErrors.get(url)
          const entry = (prev?.error === errorKey)
            ? { count: prev.count + 1, error: errorKey }
            : { count: 1, error: errorKey }
          consecutiveErrors.set(url, entry)
          if (entry.count >= 3) {
            logEvent("ERROR", "fetch.give_up", {
              url,
              terminal_reason: errorKey,
              retry_count: entry.count,
              next_action: "mark_failed",
            })
            markFailed(url)
          } else {
            logEvent("ERROR", "fetch.failed", {
              url,
              error: errorKey,
              retry_count: entry.count,
              next_action: "requeue",
            })
            requeue({
              url,
              bestEffort: false,
            })
          }
        }
        break
      }

      case "out-of-scope":
        recordGuessAttemptOutcome(entry, "out_of_scope")
        logEvent("INFO", "fetch.skipped_out_of_scope", {
          url,
          redirected_to: result.redirectedTo,
        })
        items.set(url, {
          status: "skipped",
          statusReason: "redirectOutOfScope",
          fetchedAt: new Date().toISOString(),
        })
        break

      case "non-text":
        recordGuessAttemptOutcome(entry, "non_text")
        logEvent("INFO", "fetch.skipped_non_text", {
          url,
          content_type: result.contentType,
        })
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
        .catch((err) => {
          inFlight.delete(promise)
          logEvent("ERROR", "fetch.unexpected", {
            url,
            error: getErrorMessage(err),
          })
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
  const concurrencyPerDomain = opts?.concurrency ?? 10

  logEvent("INFO", "run.start", {
    content_dir: contentDir,
    downloads_dir: downloadsDir,
    concurrency_per_domain: concurrencyPerDomain,
    seed_count: seeds.length,
  })

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

  for (const { seed, result } of seedResults) {
    const counts = countItemsByStatus(result.items.values())
    logEvent("SUMMARY", "seed.summary", {
      seed: seed.seedUrl,
      fetched_count: result.fetchedCount,
      success_count: counts.successCount,
      skipped_count: counts.skippedCount,
      failed_count: counts.failedCount,
      aborted: result.aborted,
    })
  }

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
    logEvent("INFO", "content.rewrite_completed", {
      changed_files: rewriteResult.stats.changedFiles,
      scanned_files: rewriteResult.stats.scannedFiles,
      local_prefix: localPrefix,
    })
    if (rewriteResult.stats.changedFiles > 0) {
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
  logEvent("INFO", "metadata.written", {
    path: metadataPath,
    result: metadata.result,
  })
  logEvent("SUMMARY", "run.summary", {
    fetched_pages: totalFetched,
    result: metadata.result,
    metadata_path: metadataPath,
    failed_count: metadata.stats["failed"],
    seeds_completed: seedResults.filter(({ result }) => !result.aborted).length,
    seeds_aborted: seedResults.filter(({ result }) => result.aborted).length,
  })
}

// Only run crawl when executed directly as a script (not when imported)
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && (process.argv[1] === __filename || process.argv[1].endsWith("src/crawl.ts"))) {
  const cliArgs = parseCliArgs(process.argv.slice(2))
  crawl(cliArgs)
}
