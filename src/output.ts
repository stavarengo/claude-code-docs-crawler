import pc from "picocolors"

export type OutputLevel = "INFO" | "NOTICE" | "WARN" | "ERROR" | "SUMMARY"
export type OutputValue = boolean | number | string | null | undefined
export type OutputFields = Record<string, OutputValue>

interface OutputStreams {
  log: Console["log"]
  warn: Console["warn"]
  error: Console["error"]
}

const PLAIN_VALUE_RE = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]+$/
const SECTION_WIDTH = 80

function quoteOutputValue(value: string): string {
  return JSON.stringify(value)
}

export function formatOutputValue(value: OutputValue): string {
  if (value === null) return "null"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (typeof value !== "string") return String(value)
  if (value.length === 0) return "\"\""
  if (PLAIN_VALUE_RE.test(value)) return value
  return quoteOutputValue(value)
}

export function formatOutputEvent(level: OutputLevel, event: string, fields: OutputFields = {}): string {
  const parts = [`[${level}]`, event]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    parts.push(`${key}=${formatOutputValue(value)}`)
  }
  return parts.join(" ")
}

function getStreams(): OutputStreams {
  return {
    log: console.log,
    warn: console.warn,
    error: console.error,
  }
}

function shouldUseColor(level: OutputLevel): boolean {
  if (process.env["NO_COLOR"] !== undefined) return false
  const stream = level === "ERROR" || level === "WARN" ? process.stderr : process.stdout
  return stream.isTTY === true
}

function shouldShowSections(): boolean {
  if (process.env["CRAWLER_PLAIN_OUTPUT"] === "1") return false
  if (process.env["NO_COLOR"] !== undefined) return false
  return process.stdout.isTTY === true
}

function colorLevel(level: OutputLevel, value: string): string {
  const colors = pc.createColors(shouldUseColor(level))
  switch (level) {
    case "ERROR":
      return colors.red(colors.bold(value))
    case "WARN":
      return colors.yellow(colors.bold(value))
    case "NOTICE":
      return colors.cyan(colors.bold(value))
    case "SUMMARY":
      return colors.green(colors.bold(value))
    case "INFO":
      return colors.blue(colors.bold(value))
  }
}

function colorSection(value: string): string {
  return pc.createColors(shouldUseColor("INFO")).dim(value)
}

function route(level: OutputLevel, message: string): void {
  const streams = getStreams()
  switch (level) {
    case "WARN":
      streams.warn(message)
      return
    case "ERROR":
      streams.error(message)
      return
    default:
      streams.log(message)
  }
}

export function logEvent(level: OutputLevel, event: string, fields: OutputFields = {}): void {
  const message = formatOutputEvent(level, event, fields)
  if (!shouldUseColor(level)) {
    route(level, message)
    return
  }

  route(level, message.replace(`[${level}]`, colorLevel(level, `[${level}]`)))
}

function makeSectionRule(title: string): string {
  const label = ` ${title} `
  const sideWidth = Math.max(3, Math.floor((SECTION_WIDTH - label.length - 2) / 2))
  const left = "-".repeat(sideWidth)
  const right = "-".repeat(Math.max(3, SECTION_WIDTH - left.length - label.length - 2))
  return `+${left}${label}${right}+`
}

export function logSection(title: string, fields: OutputFields = {}): void {
  if (!shouldShowSections()) return

  const lines = [
    "",
    makeSectionRule(title),
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `| ${key.padEnd(22)} ${formatOutputValue(value)}`),
  ]

  for (const line of lines) {
    console.log(colorSection(line))
  }
}
