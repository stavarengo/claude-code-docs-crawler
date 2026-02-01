import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchWithRedirects } from './fetch.js';
import { parseUrls } from './parse.js';

const SEED_URL = 'https://code.claude.com/docs/en/llms.txt';
const SCOPE_PREFIX = 'https://code.claude.com/docs/en/';

const queue: string[] = [];                          // URLs waiting to be fetched
const queued = new Set<string>();                    // O(1) check: is URL in queue?
const fetched = new Set<string>();                   // URLs successfully fetched
const attempts = new Map<string, number>();          // url → attempt count (1-3)
let consecutive429s = 0;                             // abort at 3

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function normalize(url: string): string | null {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.href;
    } catch {
        return null;
    }
}

function enqueue(url: string) {
    const normalized = normalize(url);
    if (!normalized) return;
    if (queued.has(normalized) || fetched.has(normalized)) return;
    queue.push(normalized);
    queued.add(normalized);
}

function dequeue(): string | undefined {
    const url = queue.shift();
    if (url) queued.delete(url);
    return url;
}

function requeue(url: string) {
    queue.push(url);
    queued.add(url);
}

async function saveContent(url: string, body: string) {
    const parsed = new URL(url);
    let filePath = path.join('content', parsed.host, parsed.pathname);

    // Handle directory-style URLs
    if (filePath.endsWith('/') || !path.extname(filePath)) {
        filePath = path.join(filePath, 'index.txt');
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, body, 'utf-8');
    console.log(`Saved: ${filePath}`);
}

// Main crawl loop
enqueue(SEED_URL);

while (queue.length > 0) {
    const url = dequeue();
    if (!url) continue;

    const attemptCount = (attempts.get(url) ?? 0) + 1;

    if (attemptCount > 3) {
        console.log(`Giving up on ${url} after 3 attempts`);
        continue;
    }
    attempts.set(url, attemptCount);

    const result = await fetchWithRedirects(url, SCOPE_PREFIX);

    switch (result.type) {
        case 'success':
            consecutive429s = 0;
            fetched.add(result.finalUrl);
            queued.delete(result.finalUrl);  // handle redirect collision
            await saveContent(result.finalUrl, result.body);
            for (const newUrl of parseUrls(result.body, result.finalUrl, SCOPE_PREFIX)) {
                enqueue(newUrl);
            }
            break;

        case 'rate-limited': {
            consecutive429s++;
            if (consecutive429s >= 3) {
                console.error('Aborting: 3 consecutive 429 responses');
                process.exit(1);
            }
            const delay = result.retryAfter ?? 5000;
            console.log(`Rate limited, waiting ${String(delay)}ms...`);
            await sleep(delay);
            requeue(url);
            break;
        }

        case 'error':
            consecutive429s = 0;  // non-429 resets the streak
            console.log(`Error fetching ${url}: ${result.reason ?? String(result.status)}`);
            requeue(url);
            break;

        case 'out-of-scope':
            console.log(`Skipped out-of-scope redirect: ${url} → ${result.redirectedTo}`);
            break;

        case 'non-text':
            console.log(`Skipped non-text content: ${url} (${result.contentType})`);
            break;
    }
}

console.log(`Done. Fetched ${String(fetched.size)} pages.`);
