import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchWithRedirects } from './lib/fetch.js';
import { parseUrls } from './lib/parse.js';

const SEED_URL = 'https://code.claude.com/docs/en/llms.txt';
const SCOPE_PREFIX = 'https://code.claude.com/docs/en/';

/** @type {string[]} */
const queue = [];              // URLs waiting to be fetched
const queued = new Set();      // O(1) check: is URL in queue?
const fetched = new Set();     // URLs successfully fetched
const attempts = new Map();    // url → attempt count (1-3)
let consecutive429s = 0;       // abort at 3

/** @param {number} ms */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @returns {string | null}
 */
function normalize(url) {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.href;
    } catch {
        return null;
    }
}

/** @param {string} url */
function enqueue(url) {
    const normalized = normalize(url);
    if (!normalized) return;
    if (queued.has(normalized) || fetched.has(normalized)) return;
    queue.push(normalized);
    queued.add(normalized);
}

/** @returns {string | undefined} */
function dequeue() {
    const url = queue.shift();
    if (url) queued.delete(url);
    return url;
}

/** @param {string} url */
function requeue(url) {
    queue.push(url);
    queued.add(url);
}

/**
 * @param {string} url
 * @param {string} body
 */
async function saveContent(url, body) {
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

    const attemptCount = (attempts.get(url) || 0) + 1;

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

        case 'rate-limited':
            consecutive429s++;
            if (consecutive429s >= 3) {
                console.error('Aborting: 3 consecutive 429 responses');
                process.exit(1);
            }
            const delay = result.retryAfter || 5000;
            console.log(`Rate limited, waiting ${delay}ms...`);
            await sleep(delay);
            requeue(url);
            break;

        case 'error':
            consecutive429s = 0;  // non-429 resets the streak
            console.log(`Error fetching ${url}: ${result.reason || result.status}`);
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

console.log(`Done. Fetched ${fetched.size} pages.`);
