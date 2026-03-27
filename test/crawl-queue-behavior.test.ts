import { describe, it } from "node:test"
import assert from "node:assert"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { crawl, type SeedConfig } from "../src/crawl.ts"

const TEST_CONTENT_DIR = path.resolve("tmp/test-crawl-queue-behavior")

function listenOnRandomPort(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string, requestCounts: Map<string, number>, close: () => Promise<void> }> {
  const requestCounts = new Map<string, number>()
  const server = createServer((req, res) => {
    const url = req.url ?? "/"
    requestCounts.set(url, (requestCounts.get(url) ?? 0) + 1)
    handler(req, res)
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("server.address() did not return a port"))
        return
      }

      resolve({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        requestCounts,
        close: () => new Promise((closeResolve, closeReject) => {
          server.close(err => {
            if (err) {
              closeReject(err)
              return
            }
            closeResolve()
          })
        }),
      })
    })
  })
}

async function runCrawl(seeds: SeedConfig[]) {
  process.env["CONTENT_DIR"] = TEST_CONTENT_DIR
  try {
    await crawl({ seeds })
  } finally {
    delete process.env["CONTENT_DIR"]
  }
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (ctx: { baseUrl: string, requestCounts: Map<string, number> }) => Promise<void>,
) {
  rmSync(TEST_CONTENT_DIR, { recursive: true, force: true })
  const server = await listenOnRandomPort(handler)
  try {
    await run({
      baseUrl: server.baseUrl,
      requestCounts: server.requestCounts,
    })
  } finally {
    await server.close()
    rmSync(TEST_CONTENT_DIR, { recursive: true, force: true })
  }
}

describe("crawl queue behavior", () => {
  it("guesses both /foo/index.md and /foo.md for directory URLs and does not retry guessed failures", async () => {
    await withServer((req, res) => {
      switch (req.url) {
        case "/docs/":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end("[Foo](/docs/foo/)")
          return

        case "/docs/foo/":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
          res.end("<html><body>Foo</body></html>")
          return

        case "/docs/foo.md":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end("# Foo Markdown\n")
          return

        case "/docs/foo/index.md":
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          res.end("boom")
          return

        default:
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
      }
    }, async ({ baseUrl, requestCounts }) => {
      await runCrawl([{
        seedUrl: `${baseUrl}/docs/`,
        scopePrefix: `${baseUrl}/docs/`,
        additionalScopePrefixes: [],
        localPrefix: "",
      }])

      const host = baseUrl.replace("http://", "")
      const savedPath = path.join(TEST_CONTENT_DIR, "docs", host, "docs", "foo.md")
      assert.ok(existsSync(savedPath), `expected guessed markdown file at ${savedPath}`)
      assert.strictEqual(readFileSync(savedPath, "utf-8"), "# Foo Markdown\n")
      assert.strictEqual(requestCounts.get("/docs/foo.md"), 1)
      assert.strictEqual(requestCounts.get("/docs/foo/index.md"), 1)
    })
  })

  it("accepts a URL only once per seed even if it is rediscovered after an error", async () => {
    await withServer((req, res) => {
      switch (req.url) {
        case "/docs/":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end("[Page A](/docs/page-a)\n[Page B](/docs/page-b)\n")
          return

        case "/docs/page-a":
        case "/docs/page-b":
          setTimeout(() => {
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
            res.end("[Missing](/docs/missing)\n")
          }, 10)
          return

        case "/docs/missing":
          setTimeout(() => {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
            res.end("Not Found")
          }, 100)
          return

        default:
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
      }
    }, async ({ baseUrl, requestCounts }) => {
      await runCrawl([{
        seedUrl: `${baseUrl}/docs/`,
        scopePrefix: `${baseUrl}/docs/`,
        additionalScopePrefixes: [],
        localPrefix: "",
      }])

      assert.strictEqual(requestCounts.get("/docs/missing"), 1)
    })
  })

  it("keeps uniqueness seed-scoped when two seeds share the same discovered URL", async () => {
    await withServer((req, res) => {
      switch (req.url) {
        case "/seed-a/":
        case "/seed-b/":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end("[Shared](/shared/page)\n")
          return

        case "/shared/page":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end("# Shared Page\n")
          return

        default:
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
      }
    }, async ({ baseUrl, requestCounts }) => {
      await runCrawl([
        {
          seedUrl: `${baseUrl}/seed-a/`,
          scopePrefix: `${baseUrl}/seed-a/`,
          additionalScopePrefixes: [`${baseUrl}/shared/`],
          localPrefix: "",
        },
        {
          seedUrl: `${baseUrl}/seed-b/`,
          scopePrefix: `${baseUrl}/seed-b/`,
          additionalScopePrefixes: [`${baseUrl}/shared/`],
          localPrefix: "",
        },
      ])

      assert.strictEqual(requestCounts.get("/shared/page"), 2)
    })
  })
})
