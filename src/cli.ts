import { parseArgs } from "node:util"

const DEFAULT_CONCURRENCY = 10

export interface CliArgs {
  showGitDiff: boolean
  concurrency: number
}

export function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      "show-diff": { type: "boolean", default: false },
      diff: { type: "boolean", default: false },
      "show-git-diff": { type: "boolean", default: false },
      concurrency: { type: "string" },
    },
    strict: false,
  })

  const showGitDiff = values["show-diff"] === true
    || values.diff === true
    || values["show-git-diff"] === true

  let concurrency = DEFAULT_CONCURRENCY
  if (values.concurrency !== undefined) {
    const parsed = Number(values.concurrency)
    if (Number.isFinite(parsed) && parsed > 0) {
      concurrency = Math.floor(parsed)
    }
  }

  return { showGitDiff, concurrency }
}
