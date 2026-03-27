import { fetchWithRedirects, type FetchResult } from "./fetch.js"

interface PendingFetch {
  url: string
  scopePrefixes: string[]
  resolve: (result: FetchResult) => void
}

class DomainQueue {
  private readonly maxConcurrency: number
  private inFlight = 0
  private readonly pending: PendingFetch[] = []
  private pausedUntil = 0

  constructor(maxConcurrency: number) {
    this.maxConcurrency = maxConcurrency
  }

  enqueue(url: string, scopePrefixes: string[]): Promise<FetchResult> {
    return new Promise<FetchResult>(resolve => {
      this.pending.push({ url, scopePrefixes, resolve })
      this.drain()
    })
  }

  pause(ms: number): void {
    this.pausedUntil = Date.now() + ms
    // Schedule a drain after the pause expires
    setTimeout(() => this.drain(), ms)
  }

  private drain(): void {
    const now = Date.now()
    if (now < this.pausedUntil) return

    while (this.inFlight < this.maxConcurrency && this.pending.length > 0) {
      const entry = this.pending.shift()!
      this.inFlight++
      fetchWithRedirects(entry.url, entry.scopePrefixes)
        .then(result => {
          entry.resolve(result)
          this.inFlight--
          this.drain()
        })
        .catch(() => {
          // fetchWithRedirects handles its own errors and returns FetchResult,
          // but just in case:
          entry.resolve({ type: "error", reason: "unexpected fetch failure" })
          this.inFlight--
          this.drain()
        })
    }
  }
}

export class QueueManager {
  private readonly concurrencyPerDomain: number
  private readonly domains = new Map<string, DomainQueue>()

  constructor(concurrencyPerDomain = 10) {
    this.concurrencyPerDomain = concurrencyPerDomain
  }

  fetch(url: string, scopePrefixes: string[]): Promise<FetchResult> {
    const hostname = new URL(url).hostname
    let queue = this.domains.get(hostname)
    if (!queue) {
      queue = new DomainQueue(this.concurrencyPerDomain)
      this.domains.set(hostname, queue)
    }
    return queue.enqueue(url, scopePrefixes)
  }

  pauseDomain(hostname: string, ms: number): void {
    const queue = this.domains.get(hostname)
    if (queue) {
      queue.pause(ms)
    }
  }
}
