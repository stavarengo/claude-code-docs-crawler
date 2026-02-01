export type FetchResult =
    | { type: 'success'; finalUrl: string; body: string }
    | { type: 'out-of-scope'; originalUrl: string; redirectedTo: string }
    | { type: 'rate-limited'; retryAfter: number | null }
    | { type: 'error'; reason?: string; status?: number }
    | { type: 'non-text'; contentType: string; url: string };

export async function fetchWithRedirects(url: string, scopePrefix: string, maxRedirects = 10): Promise<FetchResult> {
    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount < maxRedirects) {
        let response: Response;
        try {
            response = await fetch(currentUrl, { redirect: 'manual' });
        } catch (err) {
            return { type: 'error', reason: (err as Error).message };
        }

        // Handle redirects (3xx)
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
                return { type: 'error', reason: 'Redirect without Location header' };
            }

            const nextUrl = new URL(location, currentUrl).href;
            if (!nextUrl.startsWith(scopePrefix)) {
                return { type: 'out-of-scope', originalUrl: url, redirectedTo: nextUrl };
            }

            currentUrl = nextUrl;
            redirectCount++;
            continue;
        }

        // Handle 429
        if (response.status === 429) {
            return {
                type: 'rate-limited',
                retryAfter: parseRetryAfter(response.headers.get('retry-after'))
            };
        }

        // Handle other non-2xx
        if (!response.ok) {
            return { type: 'error', status: response.status };
        }

        // Check content-type - only process text-based content
        const contentType = response.headers.get('content-type') ?? '';
        if (!isTextContent(contentType)) {
            return { type: 'non-text', contentType, url: currentUrl };
        }

        // Success
        const body = await response.text();
        return { type: 'success', finalUrl: currentUrl, body };
    }

    return { type: 'error', reason: 'Too many redirects' };
}

function parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const seconds = parseInt(header, 10);
    return isNaN(seconds) ? null : seconds * 1000;
}

function isTextContent(contentType: string): boolean {
    const type = contentType.toLowerCase();
    return type.startsWith('text/') ||
           type.includes('application/json') ||
           type.includes('application/xml') ||
           type.includes('application/javascript');
}
