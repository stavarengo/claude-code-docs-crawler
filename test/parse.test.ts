import { describe, it } from "node:test"
import assert from "node:assert"
import { parseUrls } from "../src/parse.ts"

const BASE = "https://docs.example.com/site/"
const SCOPE = "https://docs.example.com/"

describe("US-002: parseUrls", () => {
  it("extracts markdown inline links", () => {
    const body = "See [the guide](https://docs.example.com/site/guide.html) for details."
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, ["https://docs.example.com/site/guide.html"])
  })

  it("extracts markdown reference links", () => {
    const body = "[ref]: https://docs.example.com/site/ref.html\n\nUse [ref]."
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, ["https://docs.example.com/site/ref.html"])
  })

  it("extracts HTML href attributes", () => {
    const body = `<a href="https://docs.example.com/site/page.html">link</a>`
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, ["https://docs.example.com/site/page.html"])
  })

  it("extracts bare https:// URLs", () => {
    const body = "Visit https://docs.example.com/site/bare.html now."
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, ["https://docs.example.com/site/bare.html"])
  })

  it("resolves relative URLs against baseUrl", () => {
    const body = "[click](subpage.html)"
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, ["https://docs.example.com/site/subpage.html"])
  })

  it("strips fragment identifiers", () => {
    const body = "[anchor](https://docs.example.com/site/page.html#section)"
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, ["https://docs.example.com/site/page.html"])
  })

  it("filters out-of-scope URLs", () => {
    const body = "[ext](https://other.example.com/page.html) [in](https://docs.example.com/site/in.html)"
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, ["https://docs.example.com/site/in.html"])
  })

  it("deduplicates URLs", () => {
    const body = [
      "[a](https://docs.example.com/site/page.html)",
      "[b](https://docs.example.com/site/page.html)",
      "https://docs.example.com/site/page.html",
    ].join("\n")
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, ["https://docs.example.com/site/page.html"])
  })

  it("deduplicates URLs that become identical after fragment stripping", () => {
    const body = [
      "[a](https://docs.example.com/site/page.html#one)",
      "[b](https://docs.example.com/site/page.html#two)",
    ].join("\n")
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, ["https://docs.example.com/site/page.html"])
  })

  it("silently skips invalid/malformed URLs without throwing", () => {
    const body = "[bad](://not a url at all) [good](https://docs.example.com/site/ok.html)"
    assert.doesNotThrow(() => {
      const urls = parseUrls(body, BASE, SCOPE)
      assert.deepStrictEqual(urls, ["https://docs.example.com/site/ok.html"])
    })
  })

  it("returns empty array when no URLs are present", () => {
    const body = "Just some plain text with no links."
    const urls = parseUrls(body, BASE, SCOPE)
    assert.deepStrictEqual(urls, [])
  })
})
