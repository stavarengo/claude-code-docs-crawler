import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert"
import { createServer, type Server } from "node:http"
import { fetchWithRedirects } from "../src/fetch.ts"

let server: Server
let baseUrl: string
let scopePrefix: string

beforeEach(() => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, baseUrl)
    const path = url.pathname

    switch (path) {
      case "/ok":
        res.writeHead(200, { "content-type": "text/html" })
        res.end("<h1>Hello</h1>")
        break

      case "/redirect-once":
        res.writeHead(302, { location: `${baseUrl}/ok` })
        res.end()
        break

      case "/redirect-chain-a":
        res.writeHead(302, { location: `${baseUrl}/redirect-chain-b` })
        res.end()
        break

      case "/redirect-chain-b":
        res.writeHead(302, { location: `${baseUrl}/redirect-chain-c` })
        res.end()
        break

      case "/redirect-chain-c":
        res.writeHead(200, { "content-type": "text/html" })
        res.end("<h1>End of chain</h1>")
        break

      case "/redirect-out-of-scope":
        res.writeHead(302, { location: "https://other.example.com/external" })
        res.end()
        break

      case "/redirect-loop": {
        // Each request increments a counter; after maxRedirects hops we exceed
        res.writeHead(302, { location: `${baseUrl}/redirect-loop` })
        res.end()
        break
      }

      case "/rate-limited-with-header":
        res.writeHead(429, { "retry-after": "5" })
        res.end()
        break

      case "/rate-limited-no-header":
        res.writeHead(429)
        res.end()
        break

      case "/not-found":
        res.writeHead(404)
        res.end()
        break

      case "/server-error":
        res.writeHead(500)
        res.end()
        break

      case "/binary":
        res.writeHead(200, { "content-type": "application/octet-stream" })
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        break

      default:
        res.writeHead(404)
        res.end()
    }
  })

  server.listen(0)
  const { port } = server.address() as { port: number }
  baseUrl = `http://localhost:${port}`
  scopePrefix = baseUrl
})

afterEach(() => {
  server.close()
})

describe("US-003: fetchWithRedirects", () => {
  it("returns success with finalUrl and body for a 200 text response", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/ok`, scopePrefix)
    assert.deepStrictEqual(result, {
      type: "success",
      finalUrl: `${baseUrl}/ok`,
      body: "<h1>Hello</h1>",
    })
  })

  it("follows a single redirect within scope and reflects the final URL", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/redirect-once`, scopePrefix)
    assert.deepStrictEqual(result, {
      type: "success",
      finalUrl: `${baseUrl}/ok`,
      body: "<h1>Hello</h1>",
    })
  })

  it("follows a multi-hop redirect chain within scope", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/redirect-chain-a`, scopePrefix)
    assert.deepStrictEqual(result, {
      type: "success",
      finalUrl: `${baseUrl}/redirect-chain-c`,
      body: "<h1>End of chain</h1>",
    })
  })

  it("returns out-of-scope when a redirect leaves the scope prefix", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/redirect-out-of-scope`, scopePrefix)
    assert.deepStrictEqual(result, {
      type: "out-of-scope",
      originalUrl: `${baseUrl}/redirect-out-of-scope`,
      redirectedTo: "https://other.example.com/external",
    })
  })

  it("returns error with 'Too many redirects' when maxRedirects is exceeded", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/redirect-loop`, scopePrefix, 3)
    assert.deepStrictEqual(result, {
      type: "error",
      reason: "Too many redirects",
    })
  })

  it("returns rate-limited with retryAfter in milliseconds when Retry-After header is present", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/rate-limited-with-header`, scopePrefix)
    assert.deepStrictEqual(result, {
      type: "rate-limited",
      retryAfter: 5000,
    })
  })

  it("returns rate-limited with retryAfter null when Retry-After header is absent", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/rate-limited-no-header`, scopePrefix)
    assert.deepStrictEqual(result, {
      type: "rate-limited",
      retryAfter: null,
    })
  })

  it("returns error with status for a 404 response", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/not-found`, scopePrefix)
    assert.deepStrictEqual(result, {
      type: "error",
      status: 404,
    })
  })

  it("returns error with status for a 500 response", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/server-error`, scopePrefix)
    assert.deepStrictEqual(result, {
      type: "error",
      status: 500,
    })
  })

  it("returns non-text when content-type is not text-based", async () => {
    const result = await fetchWithRedirects(`${baseUrl}/binary`, scopePrefix)
    assert.deepStrictEqual(result, {
      type: "non-text",
      contentType: "application/octet-stream",
      url: `${baseUrl}/binary`,
    })
  })

  it("returns error with reason when the server refuses the connection", async () => {
    // Use a port where nothing is listening
    const result = await fetchWithRedirects("http://localhost:1", scopePrefix)
    assert.strictEqual(result.type, "error")
    assert.ok("reason" in result && typeof result.reason === "string")
    assert.ok(result.reason.length > 0)
  })
})
