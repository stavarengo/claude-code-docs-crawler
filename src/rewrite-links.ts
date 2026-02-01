import { existsSync } from "node:fs"
import { readFile, writeFile, readdir } from "node:fs/promises"
import path from "node:path"
import type { UrlResolutionEntry } from "./url-resolution.js"

export interface RewriteStats {
  scannedFiles: number
  changedFiles: number
}

function splitUrlAndFragment(rawUrl: string): { url: string, fragment: string } {
  const hashIndex = rawUrl.indexOf("#")
  if (hashIndex === -1) return { url: rawUrl, fragment: "" }
  return { url: rawUrl.slice(0, hashIndex), fragment: rawUrl.slice(hashIndex) }
}

function computeRelativeLink(fromSavedPath: string, toSavedPath: string): string {
  const fromDir = path.posix.dirname(fromSavedPath)
  let rel = path.posix.relative(fromDir, toSavedPath)
  if (!rel.startsWith(".")) rel = `./${rel}`
  return rel
}

function parseLinkDestination(raw: string): { destination: string, suffix: string, prefix: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Support both (url) and (<url>) forms, and preserve any trailing title
  if (trimmed.startsWith("<")) {
    const end = trimmed.indexOf(">")
    if (end === -1) return null
    const destination = trimmed.slice(1, end)
    const suffix = trimmed.slice(end + 1)
    return { destination, suffix, prefix: "<" }
  }

  const firstSpace = trimmed.search(/\s/)
  if (firstSpace === -1) {
    return { destination: trimmed, suffix: "", prefix: "" }
  }
  return {
    destination: trimmed.slice(0, firstSpace),
    suffix: trimmed.slice(firstSpace),
    prefix: "",
  }
}

export function rewriteMarkdownLinks(
  markdown: string,
  opts: {
    fromSavedPath: string
    urlResolution: Record<string, UrlResolutionEntry>
    contentDir: string
  },
): { output: string, changed: boolean } {
  let changed = false

  const lines = markdown.split("\n")
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""

    // Toggle fenced code blocks on lines that start with ```
    if (/^```/.test(line.trimStart())) {
      inFence = !inFence
      continue
    }

    if (inFence) continue

    const updated = line.replace(/\[[^\]]*\]\(([^)]*)\)/g, (full, inner: string) => {
      const parsed = parseLinkDestination(inner)
      if (!parsed) return full

      const { destination, suffix, prefix } = parsed
      if (!/^https?:\/\//i.test(destination)) return full

      const { url: withoutFragment, fragment } = splitUrlAndFragment(destination)
      const resolution = opts.urlResolution[withoutFragment]
      if (!resolution) return full

      const targetAbs = path.join(opts.contentDir, resolution.savedPath)
      if (!existsSync(targetAbs)) return full

      const relative = computeRelativeLink(opts.fromSavedPath, resolution.savedPath)
      const rewritten = prefix
        ? `<${relative}${fragment}>${suffix}`
        : `${relative}${fragment}${suffix}`

      changed = true
      return full.replace(inner, ` ${rewritten} `.trim())
    })

    if (updated !== line) {
      lines[i] = updated
    }
  }

  const output = lines.join("\n")
  return { output, changed }
}

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...await walk(abs))
    } else {
      out.push(abs)
    }
  }
  return out
}

export async function rewriteMarkdownLinksInContent(
  contentDir: string,
  urlResolution: Record<string, UrlResolutionEntry>,
): Promise<{ changedSavedPaths: string[], stats: RewriteStats }> {
  const absContentDir = path.resolve(contentDir)
  const allFiles = await walk(absContentDir)

  const changedSavedPaths: string[] = []
  let scannedFiles = 0

  for (const absPath of allFiles) {
    if (!absPath.endsWith(".md")) continue

    const relPath = path.relative(absContentDir, absPath).split(path.sep).join(path.posix.sep)
    const input = await readFile(absPath, "utf-8")
    scannedFiles++

    const { output, changed } = rewriteMarkdownLinks(input, {
      fromSavedPath: relPath,
      urlResolution,
      contentDir: absContentDir,
    })

    if (!changed) continue

    await writeFile(absPath, output, "utf-8")
    changedSavedPaths.push(relPath)
  }

  return {
    changedSavedPaths,
    stats: {
      scannedFiles,
      changedFiles: changedSavedPaths.length,
    },
  }
}
