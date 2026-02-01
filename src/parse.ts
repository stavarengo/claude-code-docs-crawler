export function parseUrls(body: string, baseUrl: string, scopePrefix: string): string[] {
  const found = new Set<string>()

  // Markdown links: [text](url)
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const url = match[1]
    if (url) found.add(url.trim())
  }

  // Markdown reference links: [label]: url
  for (const match of body.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)) {
    const url = match[1]
    if (url) found.add(url.trim())
  }

  // HTML href attributes
  for (const match of body.matchAll(/href=["']([^"']+)["']/gi)) {
    const url = match[1]
    if (url) found.add(url.trim())
  }

  // Bare HTTPS URLs
  for (const match of body.matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
    found.add(match[0])
  }

  // Resolve, normalize, filter
  const results: string[] = []
  for (const raw of found) {
    try {
      const resolved = new URL(raw, baseUrl)
      resolved.hash = "" // strip fragment
      const normalized = resolved.href
      if (normalized.startsWith(scopePrefix)) {
        results.push(normalized)
      }
    } catch {
      // Invalid URL, skip
    }
  }

  return [...new Set(results)]
}
