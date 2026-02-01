import { describe, it } from "node:test"
import assert from "node:assert"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { rewriteMarkdownLinks, rewriteMarkdownLinksInContent } from "../src/rewrite-links.ts"

function p(...parts: string[]): string {
  return parts.join("/")
}

describe("US-007: rewriteMarkdownLinks", () => {
  it("rewrites absolute http(s) links when mapped file exists", () => {
    const contentDir = path.resolve("tmp/test-rewrite-links")
    rmSync(contentDir, { recursive: true, force: true })
    mkdirSync(contentDir, { recursive: true })

    const fromSavedPath = p("code.claude.com", "docs", "en", "monitoring-usage.md")
    const targetSavedPath = p(
      "raw.githubusercontent.com",
      "aws-solutions-library-samples",
      "guidance-for-claude-code-with-amazon-bedrock",
      "main",
      "assets",
      "docs",
      "MONITORING.md",
    )

    const absTarget = path.join(contentDir, targetSavedPath)
    mkdirSync(path.dirname(absTarget), { recursive: true })
    writeFileSync(absTarget, "# Monitoring", "utf-8")

    const blobUrl = "https://github.com/aws-solutions-library-samples/guidance-for-claude-code-with-amazon-bedrock/blob/main/assets/docs/MONITORING.md"

    const markdown = [
      "For details, see [Claude Code Monitoring Implementation (Bedrock)](" + blobUrl + ").",
    ].join("\n")

    const { output, changed } = rewriteMarkdownLinks(markdown, {
      fromSavedPath,
      urlResolution: {
        [blobUrl]: {
          finalUrl: "https://raw.githubusercontent.com/aws-solutions-library-samples/guidance-for-claude-code-with-amazon-bedrock/main/assets/docs/MONITORING.md",
          savedPath: targetSavedPath,
        },
      },
      contentDir,
    })

    assert.ok(changed, "expected rewrite to occur")
    assert.match(
      output,
      /\(\.\.\/\.\.\/\.\.\/raw\.githubusercontent\.com\/aws-solutions-library-samples\/guidance-for-claude-code-with-amazon-bedrock\/main\/assets\/docs\/MONITORING\.md\)/,
    )

    rmSync(contentDir, { recursive: true, force: true })
  })

  it("does not rewrite relative links or links without a mapping", () => {
    const contentDir = path.resolve("tmp/test-rewrite-links")
    rmSync(contentDir, { recursive: true, force: true })
    mkdirSync(contentDir, { recursive: true })

    const fromSavedPath = p("code.claude.com", "docs", "en", "page.md")
    const markdown = [
      "[Rel](./other.md)",
      "[AbsNoMap](https://example.com/nope)",
    ].join("\n")

    const { output, changed } = rewriteMarkdownLinks(markdown, {
      fromSavedPath,
      urlResolution: {},
      contentDir,
    })

    assert.strictEqual(changed, false)
    assert.strictEqual(output, markdown)

    rmSync(contentDir, { recursive: true, force: true })
  })

  it("preserves fragments and titles when rewriting", () => {
    const contentDir = path.resolve("tmp/test-rewrite-links")
    rmSync(contentDir, { recursive: true, force: true })
    mkdirSync(contentDir, { recursive: true })

    const fromSavedPath = p("example.com", "docs", "a", "page.md")
    const targetSavedPath = p("example.com", "docs", "b", "target.md")

    const absTarget = path.join(contentDir, targetSavedPath)
    mkdirSync(path.dirname(absTarget), { recursive: true })
    writeFileSync(absTarget, "# Target", "utf-8")

    const url = "https://example.com/docs/b/target.md"
    const markdown = "See [Target](" + url + "#section \"Title\")."

    const { output, changed } = rewriteMarkdownLinks(markdown, {
      fromSavedPath,
      urlResolution: {
        [url]: { finalUrl: url, savedPath: targetSavedPath },
      },
      contentDir,
    })

    assert.ok(changed)
    assert.match(output, /\(\.\.\/b\/target\.md#section\s+"Title"\)/)

    rmSync(contentDir, { recursive: true, force: true })
  })

  it("does not rewrite links inside fenced code blocks", () => {
    const contentDir = path.resolve("tmp/test-rewrite-links")
    rmSync(contentDir, { recursive: true, force: true })
    mkdirSync(contentDir, { recursive: true })

    const fromSavedPath = p("example.com", "docs", "page.md")
    const targetSavedPath = p("example.com", "docs", "target.md")

    const absTarget = path.join(contentDir, targetSavedPath)
    mkdirSync(path.dirname(absTarget), { recursive: true })
    writeFileSync(absTarget, "# Target", "utf-8")

    const url = "https://example.com/docs/target.md"

    const markdown = [
      "```",
      "[DoNotRewrite](" + url + ")",
      "```",
      "[Rewrite](" + url + ")",
    ].join("\n")

    const { output, changed } = rewriteMarkdownLinks(markdown, {
      fromSavedPath,
      urlResolution: {
        [url]: { finalUrl: url, savedPath: targetSavedPath },
      },
      contentDir,
    })

    assert.ok(changed)
    const lines = output.split("\n")
    assert.strictEqual(lines[1], "[DoNotRewrite](" + url + ")")
    assert.match(lines[3] ?? "", /\(\.\/target\.md\)/)

    rmSync(contentDir, { recursive: true, force: true })
  })
})

describe("US-007: rewriteMarkdownLinksInContent", () => {
  it("rewrites .md files in-place and returns changed paths", async () => {
    const contentDir = path.resolve("tmp/test-rewrite-links-in-content")
    rmSync(contentDir, { recursive: true, force: true })

    const fromSavedPath = p("example.com", "docs", "page.md")
    const absFrom = path.join(contentDir, fromSavedPath)
    mkdirSync(path.dirname(absFrom), { recursive: true })

    const targetSavedPath = p("example.com", "docs", "target.md")
    const absTarget = path.join(contentDir, targetSavedPath)
    mkdirSync(path.dirname(absTarget), { recursive: true })
    writeFileSync(absTarget, "# Target", "utf-8")

    const url = "https://example.com/docs/target.md"
    writeFileSync(absFrom, "[Target](" + url + ")\n", "utf-8")

    const result = await rewriteMarkdownLinksInContent(contentDir, {
      [url]: { finalUrl: url, savedPath: targetSavedPath },
    })

    assert.deepStrictEqual(result.changedSavedPaths, [fromSavedPath])
    assert.strictEqual(result.stats.scannedFiles, 2)
    assert.strictEqual(result.stats.changedFiles, 1)

    rmSync(contentDir, { recursive: true, force: true })
  })
})
