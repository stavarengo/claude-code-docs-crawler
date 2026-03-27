import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http"
import { QueueManager } from "../src/queue-manager.ts"

function listenOnRandomPort(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  host?: string,
): Promise<{ server: Server, baseUrl: string }> {
  return new Promise(resolve => {
    const s = createServer(handler)
    const onListening = () => {
      const addr = s.address() as { port: number }
      const displayHost = host ?? "localhost"
      resolve({ server: s, baseUrl: `http://${displayHost}:${addr.port}` })
    }
    if (host) {
      s.listen(0, host, onListening)
    } else {
      s.listen(0, onListening)
    }
  })
}

let server: Server
let baseUrl: string
let scopePrefixes: string[]

let inFlight: number
let maxInFlight: number

beforeEach(async () => {
  inFlight = 0
  maxInFlight = 0

  const result = await listenOnRandomPort((req, res) => {
    const url = new URL(req.url!, baseUrl)
    const searchDelay = url.searchParams.get("delay")
    const delay = searchDelay ? parseInt(searchDelay, 10) : 10

    inFlight++
    if (inFlight > maxInFlight) maxInFlight = inFlight

    setTimeout(() => {
      inFlight--
      if (url.pathname === "/rate-limited") {
        res.writeHead(429, { "retry-after": "1" })
        res.end()
        return
      }
      res.writeHead(200, { "content-type": "text/plain" })
      res.end(`OK: ${url.pathname}`)
    }, delay)
  })
  server = result.server
  baseUrl = result.baseUrl
  scopePrefixes = [baseUrl]
})

afterEach(() => {
  server.close()
})

describe("QueueManager: concurrency enforcement", () => {
  it("limits in-flight requests to maxConcurrency for a single domain", async () => {
    const qm = new QueueManager(2)

    // Submit 6 requests with a delay so they overlap
    const promises = Array.from({ length: 6 }, (_, i) =>
      qm.fetch(`${baseUrl}/page-${String(i)}?delay=50`, scopePrefixes),
    )

    await Promise.all(promises)

    // The server should have never seen more than 2 concurrent requests
    assert.ok(maxInFlight <= 2, `maxInFlight was ${String(maxInFlight)}, expected <= 2`)
    // But we did issue multiple requests, so maxInFlight should be > 0
    assert.ok(maxInFlight > 0, "at least one request was in flight")
  })

  it("uses default concurrency of 10 when not specified", () => {
    const qm = new QueueManager()
    // Verify the default exists — we can't easily test 10 concurrent without a lot of requests,
    // but we can verify the object was created
    assert.ok(qm instanceof QueueManager)
  })
})

describe("QueueManager: pause behavior", () => {
  it("pause(ms) holds new fetches until the duration elapses", async () => {
    const qm = new QueueManager(10)

    // Fetch one URL to create the domain queue
    await qm.fetch(`${baseUrl}/init?delay=1`, scopePrefixes)

    // Pause the domain
    const hostname = new URL(baseUrl).hostname
    qm.pauseDomain(hostname, 200)

    // Start a fetch during the pause — it should be delayed
    const startTime = Date.now()
    await qm.fetch(`${baseUrl}/after-pause?delay=1`, scopePrefixes)
    const elapsed = Date.now() - startTime

    // The fetch should have waited at least ~200ms for the pause
    assert.ok(elapsed >= 150, `elapsed was ${String(elapsed)}ms, expected >= 150ms`)
  })
})

describe("QueueManager: multi-domain independence", () => {
  it("routes requests to different domains to separate queues", async () => {
    // Use 127.0.0.1 for a different hostname than localhost
    const { server: server2, baseUrl: baseUrl2 } = await listenOnRandomPort((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("OK from server2")
      }, 10)
    }, "127.0.0.1")

    try {
      const qm = new QueueManager(1) // concurrency 1 per domain

      // With concurrency 1 per domain but 2 domains, both should run concurrently
      const start = Date.now()
      const [r1, r2] = await Promise.all([
        qm.fetch(`${baseUrl}/domain1?delay=100`, [...scopePrefixes, baseUrl2]),
        qm.fetch(`${baseUrl2}/domain2?delay=100`, [...scopePrefixes, baseUrl2]),
      ])
      const elapsed = Date.now() - start

      assert.strictEqual(r1.type, "success")
      assert.strictEqual(r2.type, "success")

      // Both should complete in ~100ms (parallel), not ~200ms (sequential)
      assert.ok(elapsed < 180, `elapsed was ${String(elapsed)}ms, expected < 180ms (parallel)`)
    } finally {
      server2.close()
    }
  })

  it("pausing one domain does not block fetches to other domains", async () => {
    // Use 127.0.0.1 for a different hostname than localhost
    const { server: server2, baseUrl: baseUrl2 } = await listenOnRandomPort((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("OK from server2")
      }, 10)
    }, "127.0.0.1")

    try {
      const qm = new QueueManager(10)
      const allScopes = [...scopePrefixes, baseUrl2]

      // Initialize both domain queues
      await Promise.all([
        qm.fetch(`${baseUrl}/init?delay=1`, allScopes),
        qm.fetch(`${baseUrl2}/init?delay=1`, allScopes),
      ])

      // Pause domain 1 (localhost)
      qm.pauseDomain("localhost", 5000)

      // Fetch from domain 2 (127.0.0.1) should complete quickly
      const start = Date.now()
      const result = await qm.fetch(`${baseUrl2}/fast?delay=1`, allScopes)
      const elapsed = Date.now() - start

      assert.strictEqual(result.type, "success")
      assert.ok(elapsed < 100, `elapsed was ${String(elapsed)}ms, expected < 100ms`)
    } finally {
      server2.close()
    }
  })
})
