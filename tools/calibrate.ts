#!/usr/bin/env bun
/**
 * Offline calibration for the live throughput estimator.
 *
 * The OpenCode database stores, for every finished assistant message, both the
 * real token counts reported by the provider and the text that was streamed.
 * That is enough to measure how many characters this machine's models emit per
 * output token, per model, without running a tokenizer at runtime.
 *
 * Usage:
 *   bun tools/calibrate.ts                       # write calibration.ts
 *   bun tools/calibrate.ts --min-steps 20        # require more evidence
 *   bun tools/calibrate.ts --out src/cal.ts      # custom destination
 *   bun tools/calibrate.ts --stdout              # print instead of writing
 *   bun tools/calibrate.ts --db /path/to/opencode.db
 *
 * Only models with at least `--min-steps` usable steps are emitted; everything
 * else falls back to DEFAULT_CHARS_PER_TOKEN in the tracker.
 */

import { Database } from "bun:sqlite"
import { existsSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type Args = {
  db: string
  out: string
  minSteps: number
  stdout: boolean
}

type ModelStats = {
  steps: number
  chars: number
  tokens: number
}

const DEFAULT_CHARS_PER_TOKEN = 4
const MIN_STEP_CHARS = 200
const RATIO_FLOOR = 0.4
const RATIO_CEILING = 8

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: join(homedir(), ".local", "share", "opencode", "opencode.db"),
    out: join(import.meta.dir, "..", "calibration.ts"),
    minSteps: 30,
    stdout: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = () => {
      const value = argv[++i]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      return value
    }
    if (arg === "--db") args.db = next()
    else if (arg === "--out") args.out = next()
    else if (arg === "--min-steps") args.minSteps = Number(next())
    else if (arg === "--stdout") args.stdout = true
    else if (arg === "--help" || arg === "-h") {
      console.log("bun tools/calibrate.ts [--db PATH] [--out PATH] [--min-steps N] [--stdout]")
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }

  if (!Number.isFinite(args.minSteps) || args.minSteps < 1) {
    throw new Error("--min-steps must be a positive integer")
  }
  return args
}

/**
 * Characters the live tracker would have counted for this step:
 * text and reasoning deltas verbatim, plus tool-input deltas approximated by
 * the serialized input. Reasoning text is absent for models that do not stream
 * it (encrypted reasoning), which is exactly how the live counter sees them.
 */
function stepChars(content: unknown): number {
  let chars = 0
  if (!Array.isArray(content)) return chars
  for (const part of content as any[]) {
    if (part.type === "text") chars += (part.text ?? "").length
    else if (part.type === "reasoning") chars += (part.text ?? "").length
    else if (part.type === "tool") {
      try {
        chars += JSON.stringify(part.state?.input ?? {}).length
      } catch {}
    }
  }
  return chars
}

function mape(steps: { chars: number; tokens: number }[], ratio: number) {
  let sum = 0
  let n = 0
  for (const step of steps) {
    if (step.tokens <= 0 || step.chars <= 0) continue
    const predicted = step.chars / ratio
    sum += Math.abs(predicted - step.tokens) / step.tokens
    n++
  }
  return n === 0 ? 0 : (100 * sum) / n
}

/**
 * Pick the constant that minimises mean absolute percentage error over the
 * observed steps. The per-step ratio distribution is skewed (short steps with
 * hidden reasoning dominate), so neither the median nor the aggregate is the
 * best single constant; a coarse grid search is cheap and direct.
 */
function bestRatio(steps: { chars: number; tokens: number }[]) {
  let best = DEFAULT_CHARS_PER_TOKEN
  let bestScore = Number.POSITIVE_INFINITY
  for (let ratio = RATIO_FLOOR; ratio <= RATIO_CEILING; ratio += 0.01) {
    const score = mape(steps, ratio)
    if (score < bestScore) {
      bestScore = score
      best = ratio
    }
  }
  return { ratio: best, score: bestScore }
}

function loadSteps(db: Database) {
  const rows = db
    .query(
      `select json_extract(data, '$.model.providerID') as provider,
              json_extract(data, '$.model.id') as model,
              data
         from session_message
        where type = 'assistant'
          and json_extract(data, '$.tokens.output') is not null`,
    )
    .all() as { provider: string | null; model: string | null; data: string }[]

  const byModel = new Map<string, ModelStats>()
  const stepPairs = new Map<string, { chars: number; tokens: number }[]>()
  let skipped = 0

  for (const row of rows) {
    if (!row.provider || !row.model) {
      skipped++
      continue
    }
    let parsed: any
    try {
      parsed = JSON.parse(row.data)
    } catch {
      skipped++
      continue
    }

    const output = parsed?.tokens?.output ?? 0
    const reasoning = parsed?.tokens?.reasoning ?? 0
    const tokens = output + reasoning
    const chars = stepChars(parsed?.content)
    if (tokens <= 0 || chars < MIN_STEP_CHARS) {
      skipped++
      continue
    }

    const key = `${row.provider}/${row.model}`
    const stats = byModel.get(key) ?? { steps: 0, chars: 0, tokens: 0 }
    stats.steps++
    stats.chars += chars
    stats.tokens += tokens
    byModel.set(key, stats)

    const pairs = stepPairs.get(key) ?? []
    pairs.push({ chars, tokens })
    stepPairs.set(key, pairs)
  }

  return { byModel, stepPairs, skipped }
}

const args = parseArgs(process.argv.slice(2))

if (!existsSync(args.db)) {
  console.error(`database not found: ${args.db}`)
  process.exit(1)
}

const db = new Database(args.db, { readonly: true })
const { byModel, stepPairs, skipped } = loadSteps(db)
db.close()

const entries = [...byModel.entries()]
  .filter(([, stats]) => stats.steps >= args.minSteps)
  .map(([model, stats]) => {
    const pairs = stepPairs.get(model) ?? []
    const { ratio, score } = bestRatio(pairs)
    return {
      model,
      steps: stats.steps,
      ratio,
      aggregate: stats.chars / stats.tokens,
      mapeDefault: mape(pairs, DEFAULT_CHARS_PER_TOKEN),
      mapeModel: score,
    }
  })
  .sort((a, b) => a.model.localeCompare(b.model))

if (entries.length === 0) {
  console.error(
    `no model had at least ${args.minSteps} usable steps; nothing to calibrate`,
  )
  process.exit(1)
}

const generatedAt = new Date().toISOString().slice(0, 10)
const body = entries
  .map((entry) => {
    const note =
      `n=${entry.steps}, agg=${entry.aggregate.toFixed(2)}, ` +
      `MAPE ${entry.mapeDefault.toFixed(1)}% -> ${entry.mapeModel.toFixed(1)}%`
    return `  "${entry.model}": ${entry.ratio.toFixed(3)}, // ${note}`
  })
  .join("\n")

const source = `// Generated by tools/calibrate.ts on ${generatedAt}. Do not edit by hand.
//
// Characters per output token, measured per model from the provider-reported
// token counts of finished steps. The live tracker starts from these values and
// keeps refining them online as new steps complete.
//
// Regenerate with: bun tools/calibrate.ts

export const CALIBRATION: Record<string, number> = {
${body}
}
`

if (args.stdout) {
  process.stdout.write(source)
} else {
  writeFileSync(args.out, source)
  console.log(`wrote ${args.out} (${entries.length} models, ${skipped} steps skipped)`)
}

const totalSteps = entries.reduce((sum, entry) => sum + entry.steps, 0)
const meanDefault = entries.reduce((sum, entry) => sum + entry.mapeDefault, 0) / entries.length
const meanModel = entries.reduce((sum, entry) => sum + entry.mapeModel, 0) / entries.length
console.log(
  `models=${entries.length} steps=${totalSteps} ` +
    `mean MAPE: default(4)=${meanDefault.toFixed(1)}% calibrated=${meanModel.toFixed(1)}%`,
)
