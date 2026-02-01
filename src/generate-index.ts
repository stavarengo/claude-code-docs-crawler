import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { execSync } from "node:child_process"

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
const INDEX_FILENAME = "index.md"

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

interface CrawlMetadata {
  items: Record<string, { status: string, statusReason: string }>
}

// Groups saved paths by parent directory, sorting filenames within each group.
function groupByDirectory(savedPaths: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const savedPath of savedPaths) {
    const dir = path.posix.dirname(savedPath)
    const file = path.posix.basename(savedPath)
    const existing = groups.get(dir)
    if (existing) {
      existing.push(file)
    } else {
      groups.set(dir, [file])
    }
  }
  for (const files of groups.values()) {
    files.sort()
  }
  return groups
}

// Generates a compact directory index from a list of saved paths.
// Format: each line is  dir:{file1,file2,...}  — the agent reads this to
// locate the right file on demand, then reads only that file.
export function generateIndex(savedPaths: string[]): string {
  const groups = groupByDirectory(savedPaths)
  const sortedDirs = [...groups.keys()].sort()

  const lines: string[] = [
    "[Claude Code Docs Index]",
    "root: .",
    "IMPORTANT: Read files on demand. Use this index to locate the right file, then read only that file.",
    "",
  ]

  for (const dir of sortedDirs) {
    const files = groups.get(dir)!
    lines.push(`${dir}:{${files.join(",")}}`)
  }

  return lines.join("\n") + "\n"
}

// Reads crawl-metadata.json and generates the index from successfully crawled paths.
export function generateIndexFromMetadata(contentDir: string = DEFAULT_CONTENT_DIR): string {
  const absContentDir = resolveContentDir(contentDir)

  const metadataPath = path.join(absContentDir, "crawl-metadata.json")
  if (!existsSync(metadataPath)) {
    throw new Error(`Crawl metadata not found at ${metadataPath}. Run the crawl first.`)
  }

  const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as CrawlMetadata

  const savedPaths = Object.entries(metadata.items)
    .filter(([, item]) => item.status === "success" && item.statusReason !== "removed")
    .map(([key]) => key)

  return generateIndex(savedPaths)
}

function main() {
  const contentDir = resolveContentDir(process.env["CONTENT_DIR"] ?? DEFAULT_CONTENT_DIR)
  const downloadsDir = path.join(contentDir, DOWNLOADS_SUBDIR)
  const index = generateIndexFromMetadata(contentDir)
  const outputPath = path.join(downloadsDir, INDEX_FILENAME)
  writeFileSync(outputPath, index, "utf-8")
  console.log(`Index written to ${outputPath}`)
  console.log(`Index size: ${Buffer.byteLength(index)} bytes`)
}

const __filename = fileURLToPath(import.meta.url)
if (process.argv[1] && (process.argv[1] === __filename || process.argv[1].endsWith("src/generate-index.ts"))) {
  main()
}
