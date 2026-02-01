export function parseUrls(body: string, baseUrl: string, scopePrefix: string): string[] {
    const found = new Set<string>();

    // Markdown links: [text](url)
    for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        found.add(match[1].trim());
    }

    // Markdown reference links: [label]: url
    for (const match of body.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)) {
        found.add(match[1].trim());
    }

    // HTML href attributes
    for (const match of body.matchAll(/href=["']([^"']+)["']/gi)) {
        found.add(match[1].trim());
    }

    // Bare HTTPS URLs
    for (const match of body.matchAll(/https:\/\/[^\s<>"')\]]+/g)) {
        found.add(match[0]);
    }

    // Resolve, normalize, filter
    const results: string[] = [];
    for (const raw of found) {
        try {
            const resolved = new URL(raw, baseUrl);
            resolved.hash = '';  // strip fragment
            const normalized = resolved.href;
            if (normalized.startsWith(scopePrefix)) {
                results.push(normalized);
            }
        } catch {
            // Invalid URL, skip
        }
    }

    return [...new Set(results)];
}
