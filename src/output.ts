import blessed from "blessed"
import pc from "picocolors"

export type OutputLevel = "INFO" | "NOTICE" | "WARN" | "ERROR" | "SUMMARY"
export type OutputValue = boolean | number | string | null | undefined
export type OutputFields = Record<string, OutputValue>

interface OutputStreams {
  log: Console["log"]
  warn: Console["warn"]
  error: Console["error"]
}

interface TuiState {
  title: string
  startedAt: number
  fields: OutputFields
  counters: Record<string, number>
  seedSummaries: string[]
  recentEvents: string[]
  detail: string
  finalSummary?: OutputFields
}

interface TuiSession {
  screen: blessed.Widgets.Screen
  header: blessed.Widgets.BoxElement
  counters: blessed.Widgets.BoxElement
  details: blessed.Widgets.BoxElement
  seeds: blessed.Widgets.BoxElement
  events: blessed.Widgets.BoxElement
  footer: blessed.Widgets.BoxElement
  state: TuiState
}

const PLAIN_VALUE_RE = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=-]+$/
const MAX_RECENT_EVENTS = 18
const MAX_SEED_SUMMARIES = 12

let tuiSession: TuiSession | null = null

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

function shouldUseTui(): boolean {
  if (process.env["CRAWLER_PLAIN_OUTPUT"] === "1") return false
  if (process.env["CI"] !== undefined) return false
  if (process.env["TERM"] === "dumb") return false
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

function styleForLevel(level: OutputLevel): blessed.Widgets.Types.TStyle {
  switch (level) {
    case "ERROR":
      return { fg: "red", bold: true }
    case "WARN":
      return { fg: "yellow", bold: true }
    case "NOTICE":
      return { fg: "cyan", bold: true }
    case "SUMMARY":
      return { fg: "green", bold: true }
    case "INFO":
      return { fg: "blue", bold: true }
  }
}

function compactUrl(value: OutputValue, maxLength = 70): string {
  if (typeof value !== "string") return formatOutputValue(value)
  if (value.length <= maxLength) return value
  return `...${value.slice(-(maxLength - 3))}`
}

function formatFieldRows(fields: OutputFields): string {
  const rows = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key.padEnd(22)} ${compactUrl(value)}`)

  return rows.length > 0 ? rows.join("\n") : "No details yet."
}

function formatDuration(startedAt: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`
}

function incrementCounter(state: TuiState, key: string, by = 1): void {
  state.counters[key] = (state.counters[key] ?? 0) + by
}

function createPanel(options: blessed.Widgets.BoxOptions): blessed.Widgets.BoxElement {
  return blessed.box({
    border: "line",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
    vi: true,
    style: {
      border: { fg: "gray" },
      label: { fg: "white", bold: true },
    },
    ...options,
  })
}

function createTuiSession(): TuiSession {
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "Docs Crawler",
  })
  screen.key(["C-c", "q", "escape"], () => {
    finishOutput()
    process.exit(0)
  })

  const header = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    style: { fg: "white", bg: "black" },
  })
  const counters = createPanel({
    top: 3,
    left: 0,
    width: "36%",
    height: 12,
    label: " Run ",
  })
  const details = createPanel({
    top: 15,
    left: 0,
    width: "36%",
    bottom: 3,
    label: " Current Event ",
  })
  const seeds = createPanel({
    top: 3,
    left: "36%",
    width: "64%",
    height: 12,
    label: " Seeds ",
  })
  const events = createPanel({
    top: 15,
    left: "36%",
    width: "64%",
    bottom: 3,
    label: " Activity ",
  })
  const footer = blessed.box({
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    style: { fg: "gray", bg: "black" },
  })

  screen.append(header)
  screen.append(counters)
  screen.append(details)
  screen.append(seeds)
  screen.append(events)
  screen.append(footer)

  return {
    screen,
    header,
    counters,
    details,
    seeds,
    events,
    footer,
    state: {
      title: "Crawl Run",
      startedAt: Date.now(),
      fields: {},
      counters: {},
      seedSummaries: [],
      recentEvents: [],
      detail: "Waiting for crawl events.",
    },
  }
}

function getTuiSession(): TuiSession | null {
  if (!shouldUseTui()) return null
  tuiSession ??= createTuiSession()
  return tuiSession
}

function renderTui(session: TuiSession): void {
  const { state } = session
  const finalResult = state.finalSummary?.["result"]
  const status = typeof finalResult === "string" ? finalResult.toUpperCase() : "RUNNING"
  const statusColor = status === "SUCCESS" ? "green" : status === "PARTIAL" ? "yellow" : "cyan"

  session.header.setContent([
    `{bold}Docs Crawler{/bold}  {${statusColor}-fg}${status}{/${statusColor}-fg}`,
    `Phase: ${state.title}    Elapsed: ${formatDuration(state.startedAt)}`,
  ].join("\n"))

  session.counters.setContent([
    formatFieldRows(state.fields),
    "",
    "Counters",
    `saved_new              ${state.counters["saved.new"] ?? 0}`,
    `saved_changed          ${state.counters["saved.changed"] ?? 0}`,
    `saved_unchanged        ${state.counters["saved.unchanged"] ?? 0}`,
    `warnings               ${state.counters["warnings"] ?? 0}`,
    `errors                 ${state.counters["errors"] ?? 0}`,
    `rate_limited           ${state.counters["rate_limited"] ?? 0}`,
  ].join("\n"))

  session.details.setContent(state.detail)
  session.seeds.setContent(state.seedSummaries.length > 0 ? state.seedSummaries.join("\n\n") : "No seed summaries yet.")
  session.events.setContent(state.recentEvents.join("\n"))
  session.events.setScrollPerc(100)
  session.footer.setContent(" q / esc / ctrl-c exits   |   Set CRAWLER_PLAIN_OUTPUT=1 for structured line output")
  session.screen.render()
}

function recordTuiEvent(session: TuiSession, level: OutputLevel, event: string, fields: OutputFields): void {
  const { state } = session
  const rendered = formatOutputEvent(level, event, fields)
  const levelStyle = styleForLevel(level)
  const prefix = `{${String(levelStyle.fg)}-fg}${level.padEnd(7)}{/${String(levelStyle.fg)}-fg}`

  state.detail = [`${level} ${event}`, "", formatFieldRows(fields)].join("\n")
  state.recentEvents.push(`${prefix} ${event} ${compactUrl(fields["url"] ?? fields["seed"] ?? fields["path"] ?? "")}`)
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents.splice(0, state.recentEvents.length - MAX_RECENT_EVENTS)
  }

  if (level === "WARN") incrementCounter(state, "warnings")
  if (level === "ERROR") incrementCounter(state, "errors")

  switch (event) {
    case "run.start":
      state.title = "Crawl Run"
      state.fields = fields
      break
    case "seed.start":
      state.title = "Fetching Seeds"
      break
    case "content.saved": {
      const status = fields["status"]
      if (typeof status === "string") incrementCounter(state, `saved.${status}`)
      break
    }
    case "fetch.rate_limited":
      incrementCounter(state, "rate_limited")
      break
    case "seed.summary":
      state.seedSummaries.push(formatFieldRows(fields))
      if (state.seedSummaries.length > MAX_SEED_SUMMARIES) {
        state.seedSummaries.splice(0, state.seedSummaries.length - MAX_SEED_SUMMARIES)
      }
      break
    case "content.rewrite_completed":
      state.title = "Rewriting Links"
      break
    case "run.summary":
      state.title = "Complete"
      state.finalSummary = fields
      break
  }

  if (event === "run.summary") {
    state.recentEvents.push(rendered)
  }
}

export function logEvent(level: OutputLevel, event: string, fields: OutputFields = {}): void {
  const session = getTuiSession()
  if (session) {
    recordTuiEvent(session, level, event, fields)
    renderTui(session)
    return
  }

  const message = formatOutputEvent(level, event, fields)
  if (!shouldUseColor(level)) {
    route(level, message)
    return
  }

  route(level, message.replace(`[${level}]`, colorLevel(level, `[${level}]`)))
}

export function logSection(title: string, fields: OutputFields = {}): void {
  const session = getTuiSession()
  if (!session) return

  session.state.title = title
  session.state.fields = fields
  session.state.detail = [`${title}`, "", formatFieldRows(fields)].join("\n")
  renderTui(session)
}

export function finishOutput(): void {
  if (!tuiSession) return

  const { screen, state } = tuiSession
  const finalSummary = state.finalSummary
  tuiSession = null
  screen.destroy()
  if (finalSummary) {
    route("SUMMARY", formatOutputEvent("SUMMARY", "run.summary", finalSummary))
  }
}
