import { mkdir, writeFile, readFileSync, existsSync } from "node:fs"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { fetchWithRedirects } from "./fetch.js"
import { parseUrls } from "./parse.js"

const mkdirAsync = promisify(mkdir)
const writeFileAsync = promisify(writeFile)

const SEED_URL = "https://code.claude.com/docs/llms.txt"
const SCOPE_PREFIX = "https://code.claude.com/docs/en/"
const ADDITIONAL_SCOPE_PREFIXES = [
  "https://github.com/aws-solutions-library-samples",
]
const DEFAULT_CONTENT_DIR = "content"

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

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
  const match = url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/blob\/(.+)$/)
  if (!match) return null
  return `https://raw.githubusercontent.com/${match[1]}/${match[2]}`
}

function extractCanonical(html: string): string | null {
  const match = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)
  return match?.[1] ?? null
}

export type SaveResult = "new" | "changed" | "unchanged"

export async function saveContent(url: string, body: string, contentDir: string = DEFAULT_CONTENT_DIR): Promise<SaveResult> {
  const parsed = new URL(url)
  let filePath = path.join(contentDir, parsed.host, parsed.pathname)

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
  seedUrl: string
  scopePrefix: string
  items: Map<string, ItemRecord>
  aborted: boolean
}

export interface CrawlMetadata {
  seedUrl: string
  scopePrefix: string
  lastUpdate: string
  result: "success" | "partial" | "aborted"
  stats: Record<string, number>
  items: Record<string, ItemRecord>
}

export function buildMetadata({ seedUrl, scopePrefix, items, aborted }: BuildMetadataInput): CrawlMetadata {
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
    seedUrl,
    scopePrefix,
    lastUpdate: new Date().toISOString(),
    result,
    stats,
    items: itemsObj,
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

function urlToRelativePath(url: string): string {
  const parsed = new URL(url)
  let filePath = path.join(parsed.host, parsed.pathname)
  if (filePath.endsWith("/") || !path.extname(filePath)) {
    filePath = path.join(filePath, "index.txt")
  }
  return filePath
}

// Main crawl function — accepts config via environment variables:
//   SEED_URL, SCOPE_PREFIX, CONTENT_DIR (all fall back to hardcoded defaults)
export async function crawl() {
  const seedUrl = process.env["SEED_URL"] ?? SEED_URL
  const scopePrefix = process.env["SCOPE_PREFIX"] ?? SCOPE_PREFIX
  const scopePrefixes = [scopePrefix, ...ADDITIONAL_SCOPE_PREFIXES]
  const contentDir = process.env["CONTENT_DIR"] ?? DEFAULT_CONTENT_DIR

  const queue: string[] = []
  const queued = new Set<string>()
  const fetched = new Set<string>()
  const consecutiveErrors = new Map<string, { count: number, error: string }>()
  const failed = new Set<string>()
  let consecutive429s = 0
  let aborted = false

  const items = new Map<string, ItemRecord>()

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

  function enqueue(url: string) {
    const normalized = normalize(url)
    if (!normalized) return
    if (queued.has(normalized) || fetched.has(normalized) || failed.has(normalized)) return
    queue.push(normalized)
    queued.add(normalized)
  }

  function dequeue(): string | undefined {
    const url = queue.shift()
    if (url) queued.delete(url)
    return url
  }

  function requeue(url: string) {
    queue.push(url)
    queued.add(url)
  }

  enqueue(seedUrl)

  while (queue.length > 0) {
    const url = dequeue()
    if (!url) continue

    const result = await fetchWithRedirects(url, scopePrefixes)

    switch (result.type) {
      case "success": {
        consecutive429s = 0
        fetched.add(result.finalUrl)
        queued.delete(result.finalUrl) // handle redirect collision

        const isHtml = result.contentType.includes("text/html")
        const isCodeDomain = result.finalUrl.startsWith(scopePrefix)

        if (isHtml && isCodeDomain) {
          // HTML from code.claude.com: extract canonical to discover the markdown URL
          const canonical = extractCanonical(result.body)
          if (canonical && canonical !== result.finalUrl) {
            enqueue(canonical)
            if (!canonical.endsWith(".md")) {
              enqueue(canonical + ".md")
            }
          }
          if (!result.finalUrl.endsWith(".md")) {
            enqueue(result.finalUrl + ".md")
          }
        } else if (isHtml && result.finalUrl.startsWith("https://github.com/")) {
          // HTML from GitHub: try the raw.githubusercontent.com version if it's a .md file
          const rawUrl = toRawGitHubUrl(result.finalUrl)
          if (rawUrl && rawUrl.endsWith(".md")) {
            enqueue(rawUrl)
          }
        } else {
          const changeStatus = await saveContent(result.finalUrl, result.body, contentDir)
          const key = urlToRelativePath(result.finalUrl)
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
          console.error("Aborting: 3 consecutive 429 responses")
          aborted = true
          break
        }
        const delay = result.retryAfter ?? 5000
        console.log(`Rate limited, waiting ${String(delay)}ms...`)
        await sleep(delay)
        requeue(url)
        break
      }

      case "error": {
        consecutive429s = 0
        const errorKey = result.status ? String(result.status) : (result.reason ?? "unknown")
        console.log(`Error fetching ${url}: ${errorKey}`)
        if (result.status === 404 || result.status === 406) {
          failed.add(url)
          items.set(url, {
            status: "failed",
            statusReason: "httpError",
            fetchedAt: new Date().toISOString(),
          })
        } else {
          const prev = consecutiveErrors.get(url)
          const entry = (prev && prev.error === errorKey)
            ? { count: prev.count + 1, error: errorKey }
            : { count: 1, error: errorKey }
          consecutiveErrors.set(url, entry)
          if (entry.count >= 3) {
            console.log(`Giving up on ${url} after 3 consecutive ${errorKey} errors`)
            failed.add(url)
            items.set(url, {
              status: "failed",
              statusReason: "httpError",
              fetchedAt: new Date().toISOString(),
            })
          } else {
            requeue(url)
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

    if (aborted) break
  }

  // Mark pages from prior run that were not visited in this run
  markRemovedItems(previousItems, items)

  // Write crawl metadata
  const metadata = buildMetadata({
    seedUrl,
    scopePrefix,
    items,
    aborted,
  })

  await mkdirAsync(path.dirname(metadataPath), { recursive: true })
  await writeFileAsync(metadataPath, JSON.stringify(metadata, null, 2), "utf-8")
  console.log(`Metadata written to ${metadataPath}`)
  console.log(`Done. Fetched ${String(fetched.size)} pages.`)
}

// Only run crawl when executed directly as a script (not when imported)
const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && (process.argv[1] === __filename || process.argv[1].endsWith("src/crawl.ts"))) {
  crawl()
}
