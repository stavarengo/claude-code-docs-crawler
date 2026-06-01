import { afterEach, describe, it } from "node:test"
import assert from "node:assert"
import { createServer, type RequestListener } from "node:http"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"
import { crawl, type SeedConfig } from "../src/crawl.ts"

const TEST_CONTENT_DIR = path.resolve("tmp/test-crawl-logging")
type RequestHandler = RequestListener

interface CapturedCall {
  method: "log" | "warn" | "error"
  args: unknown[]
}

function cleanup() {
  rmSync(TEST_CONTENT_DIR, { recursive: true, force: true })
}

function listenOnRandomPort(
  handler: RequestHandler,
): Promise<{ baseUrl: string, close: () => Promise<void> }> {
  const server = createServer(handler)

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
        close: () => new Promise((closeResolve, closeReject) => {
          server.close((err) => {
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

// eslint-disable-next-line no-unused-vars
async function withCapturedConsole<T>(run: (calls: CapturedCall[]) => Promise<T>): Promise<T> {
  const calls: CapturedCall[] = []
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }

  console.log = (...args: unknown[]) => {
    calls.push({ method: "log", args })
  }
  console.warn = (...args: unknown[]) => {
    calls.push({ method: "warn", args })
  }
  console.error = (...args: unknown[]) => {
    calls.push({ method: "error", args })
  }

  try {
    return await run(calls)
  } finally {
    console.log = originals.log
    console.warn = originals.warn
    console.error = originals.error
  }
}

async function runCrawl(seeds: SeedConfig[], concurrency = 1) {
  mkdirSync(path.join(TEST_CONTENT_DIR, "docs"), { recursive: true })
  process.env["CONTENT_DIR"] = TEST_CONTENT_DIR
  try {
    await crawl({ seeds, concurrency })
  } finally {
    delete process.env["CONTENT_DIR"]
  }
}

afterEach(() => {
  cleanup()
})

describe("crawl logging", () => {
  it("emits structured INFO and SUMMARY events for a successful crawl", async () => {
    cleanup()

    const server = await listenOnRandomPort((req, res) => {
      switch (req.url) {
        case "/docs/":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end("# Hello\n")
          return

        default:
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
      }
    })

    try {
      await withCapturedConsole(async (calls) => {
        await runCrawl([{
          seedUrl: `${server.baseUrl}/docs/`,
          scopePrefix: `${server.baseUrl}/docs/`,
          additionalScopePrefixes: [],
          localPrefix: "",
        }])

        const rendered = calls.map(call => String(call.args[0] ?? ""))
        assert.ok(
          rendered.some(line =>
            line.startsWith("[INFO] run.start ")
            && line.includes(`content_dir=${TEST_CONTENT_DIR}`)
            && line.includes(`downloads_dir=${path.join(TEST_CONTENT_DIR, "docs")}`)
            && line.includes("concurrency_per_domain=1")
            && line.includes("seed_count=1")),
        )
        assert.ok(
          rendered.some(line =>
            line.startsWith("[INFO] seed.start ")
            && line.includes(`seed=${server.baseUrl}/docs/`)
            && line.includes(`scope_prefix=${server.baseUrl}/docs/`)
            && line.includes("additional_scope_prefixes=[]")
            && line.includes("local_prefix=\"\"")),
        )
        assert.ok(
          rendered.some(line =>
            line.startsWith("[INFO] content.saved ")
            && line.includes(`url=${server.baseUrl}/docs/`)
            && line.includes("content_type=\"text/plain; charset=utf-8\"")
            && line.includes("status=new")),
        )
        assert.ok(
          rendered.some(line =>
            line.startsWith("[INFO] content.rewrite_completed ")
            && line.includes("scanned_files=")
            && line.includes("changed_files=0")),
        )
        assert.ok(
          rendered.some(line =>
            line.startsWith("[SUMMARY] seed.summary ")
            && line.includes(`seed=${server.baseUrl}/docs/`)
            && line.includes("fetched_count=1")
            && line.includes("success_count=1")
            && line.includes("skipped_count=0")
            && line.includes("failed_count=0")
            && line.includes("aborted=false")),
        )
        assert.ok(
          rendered.some(line =>
            line.startsWith("[SUMMARY] run.summary ")
            && line.includes("fetched_pages=1")
            && line.includes("failed_count=0")
            && line.includes("seeds_completed=1")
            && line.includes("seeds_aborted=0")),
        )
      })
    } finally {
      await server.close()
    }
  })

  it("logs and discards full HTML documents while keeping markdown with HTML elements", async () => {
    cleanup()

    const htmlDocument = [
      "<!doctype html>",
      "<html>",
      "<head><title>Not Markdown</title></head>",
      "<body><h1>Not Markdown</h1></body>",
      "</html>",
    ].join("\n")
    const markdownWithHtml = [
      "# Markdown with HTML",
      "",
      "<div class=\"callout\">This inline HTML is valid markdown content.</div>",
      "",
    ].join("\n")

    const server = await listenOnRandomPort((req, res) => {
      switch (req.url) {
        case "/docs/":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end("[Full HTML](/assets/full.txt)\n[Markdown HTML](/assets/snippet.txt)\n")
          return

        case "/assets/full.txt":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end(htmlDocument)
          return

        case "/assets/snippet.txt":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end(markdownWithHtml)
          return

        default:
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
      }
    })

    try {
      await withCapturedConsole(async (calls) => {
        await runCrawl([{
          seedUrl: `${server.baseUrl}/docs/`,
          scopePrefix: `${server.baseUrl}/docs/`,
          additionalScopePrefixes: [`${server.baseUrl}/assets/`],
          localPrefix: "",
        }])

        const host = new URL(server.baseUrl).host
        const discardedPath = path.join(TEST_CONTENT_DIR, "docs", host, "assets", "full.txt")
        const keptPath = path.join(TEST_CONTENT_DIR, "docs", host, "assets", "snippet.txt")

        assert.ok(!existsSync(discardedPath), "full HTML document should be discarded")
        assert.strictEqual(readFileSync(keptPath, "utf-8"), markdownWithHtml)

        const warnLines = calls
          .filter(call => call.method === "warn")
          .map(call => String(call.args[0] ?? ""))
        const discardLine = warnLines.find(line => line.startsWith("[WARN] content.discarded_html "))

        assert.ok(discardLine, "discard should be logged")
        assert.ok(discardLine.includes(`url=${server.baseUrl}/assets/full.txt`))
        assert.ok(discardLine.includes("path="))
        assert.ok(discardLine.includes("content_type=\"text/plain; charset=utf-8\""))
        assert.ok(discardLine.includes("extension=.txt"))
        assert.ok(discardLine.includes("validation_trigger=extension_and_content_type"))
        assert.ok(discardLine.includes("reason=html_document_detected"))
        assert.ok(discardLine.includes("next_action=mark_skipped"))

        const metadataPath = path.join(TEST_CONTENT_DIR, "crawl-metadata.json")
        const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as {
          stats: Record<string, number>
        }
        assert.strictEqual(metadata.stats["skipped.htmlDocument"], 1)
      })
    } finally {
      await server.close()
    }
  })

  it("emits WARN and ERROR events for repeated 429 responses", async () => {
    cleanup()

    const server = await listenOnRandomPort((req, res) => {
      switch (req.url) {
        case "/docs/":
          res.writeHead(429, { "retry-after": "0" })
          res.end("Slow down")
          return

        default:
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
      }
    })

    try {
      await withCapturedConsole(async (calls) => {
        await runCrawl([{
          seedUrl: `${server.baseUrl}/docs/`,
          scopePrefix: `${server.baseUrl}/docs/`,
          additionalScopePrefixes: [],
          localPrefix: "",
        }])

        const warnLines = calls
          .filter(call => call.method === "warn")
          .map(call => String(call.args[0] ?? ""))
        const errorLines = calls
          .filter(call => call.method === "error")
          .map(call => String(call.args[0] ?? ""))

        assert.ok(
          warnLines.some(line =>
            line.startsWith("[WARN] fetch.rate_limited ")
            && line.includes(`url=${server.baseUrl}/docs/`)
            && line.includes(`domain=127.0.0.1`)
            && line.includes("retry_in_ms=0")
            && line.includes("next_action=requeue")),
        )
        assert.ok(
          errorLines.some(line =>
            line.startsWith("[ERROR] crawl.aborted ")
            && line.includes("reason=consecutive_rate_limit")
            && line.includes("consecutive_429s=3")
            && line.includes("effect=run_aborted")),
        )
      })
    } finally {
      await server.close()
    }
  })

  it("emits a terminal ERROR event when a primary URL exhausts retries", async () => {
    cleanup()

    const server = await listenOnRandomPort((req, res) => {
      switch (req.url) {
        case "/docs/":
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
          res.end("Boom")
          return

        default:
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
      }
    })

    try {
      await withCapturedConsole(async (calls) => {
        await runCrawl([{
          seedUrl: `${server.baseUrl}/docs/`,
          scopePrefix: `${server.baseUrl}/docs/`,
          additionalScopePrefixes: [],
          localPrefix: "",
        }])

        const errorLines = calls
          .filter(call => call.method === "error")
          .map(call => String(call.args[0] ?? ""))
        const giveUpLines = errorLines.filter(line => line.startsWith("[ERROR] fetch.give_up "))

        assert.strictEqual(giveUpLines.length, 1)
        assert.ok(giveUpLines[0]?.includes(`url=${server.baseUrl}/docs/`))
        assert.ok(giveUpLines[0]?.includes("terminal_reason=500"))
        assert.ok(giveUpLines[0]?.includes("retry_count=3"))
        assert.ok(giveUpLines[0]?.includes("next_action=mark_failed"))
      })
    } finally {
      await server.close()
    }
  })

  it("emits one grouped NOTICE event when a markdown guess succeeds", async () => {
    cleanup()

    const server = await listenOnRandomPort((req, res) => {
      switch (req.url) {
        case "/docs/":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end("[Foo](/docs/foo/)\n")
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
          setTimeout(() => {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
            res.end("Not Found")
          }, 50)
          return

        default:
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
      }
    })

    try {
      await withCapturedConsole(async (calls) => {
        await runCrawl([{
          seedUrl: `${server.baseUrl}/docs/`,
          scopePrefix: `${server.baseUrl}/docs/`,
          additionalScopePrefixes: [],
          localPrefix: "",
        }], 2)

        const logLines = calls
          .filter(call => call.method === "log")
          .map(call => String(call.args[0] ?? ""))
        const errorLines = calls
          .filter(call => call.method === "error")
          .map(call => String(call.args[0] ?? ""))
        const groupedLines = logLines.filter(line => line.startsWith("[NOTICE] fetch.guess_resolved "))

        assert.strictEqual(groupedLines.length, 1)
        assert.ok(groupedLines[0]?.includes(`original_url=${server.baseUrl}/docs/foo/`))
        assert.ok(groupedLines[0]?.includes(`winner_url=${server.baseUrl}/docs/foo.md`))
        assert.ok(groupedLines[0]?.includes(`${server.baseUrl}/docs/foo/index.md`))
        assert.ok(groupedLines[0]?.includes("404"))
        assert.ok(
          errorLines.every(line =>
            !line.includes(`${server.baseUrl}/docs/foo/index.md`) && !line.includes(`${server.baseUrl}/docs/foo.md`)),
        )
      })
    } finally {
      await server.close()
    }
  })

  it("emits one grouped ERROR event when the original URL and all markdown guesses fail", async () => {
    cleanup()

    const server = await listenOnRandomPort((req, res) => {
      switch (req.url) {
        case "/docs/":
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
          res.end("[Foo](/docs/foo/)\n")
          return

        case "/docs/foo/":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
          res.end("<html><body>Foo</body></html>")
          return

        case "/docs/foo/index.md":
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
          return

        case "/docs/foo.md":
          res.writeHead(406, { "content-type": "text/plain; charset=utf-8" })
          res.end("Nope")
          return

        default:
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
          res.end("Not Found")
      }
    })

    try {
      await withCapturedConsole(async (calls) => {
        await runCrawl([{
          seedUrl: `${server.baseUrl}/docs/`,
          scopePrefix: `${server.baseUrl}/docs/`,
          additionalScopePrefixes: [],
          localPrefix: "",
        }])

        const errorLines = calls
          .filter(call => call.method === "error")
          .map(call => String(call.args[0] ?? ""))
        const groupedLines = errorLines.filter(line => line.startsWith("[ERROR] fetch.guess_failed "))

        assert.strictEqual(groupedLines.length, 1)
        assert.ok(groupedLines[0]?.includes(`original_url=${server.baseUrl}/docs/foo/`))
        assert.ok(groupedLines[0]?.includes(`${server.baseUrl}/docs/foo/index.md`))
        assert.ok(groupedLines[0]?.includes(`${server.baseUrl}/docs/foo.md`))
        assert.ok(groupedLines[0]?.includes("404"))
        assert.ok(groupedLines[0]?.includes("406"))
        assert.strictEqual(
          errorLines.filter(line =>
            line.includes(`${server.baseUrl}/docs/foo/`)
            || line.includes(`${server.baseUrl}/docs/foo/index.md`)
            || line.includes(`${server.baseUrl}/docs/foo.md`)).length,
          1,
        )
      })
    } finally {
      await server.close()
    }
  })
})
