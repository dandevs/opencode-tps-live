import type { OpenCodeEvent } from "@opencode/client"
import { CALIBRATION } from "./calibration.ts"

export type ThroughputSnapshot = {
  readonly active: boolean
  readonly tps: number
  readonly tokens: number
  readonly estimated: boolean
  /** Wall-clock rate including time to first token, when it can be measured. */
  readonly wallTps?: number
}

type Sample = {
  readonly at: number
  readonly tokens: number
}

type Tracker = {
  readonly sessionID: string
  active: boolean
  /** Server epoch-ms timestamp of the step start. Only used for wall-clock rate. */
  stepStartedAt?: number
  /** Server epoch-ms timestamp of the moment the message finished streaming. */
  streamedAt?: number
  chars: number
  tokens: number
  ratio: number
  modelKey?: string
  samples: Sample[]
  /** Local monotonic timestamps of the first and last output deltas. */
  firstOutputAt?: number
  lastOutputAt?: number
  generationTps?: number
  wallTps?: number
  /** True only when this step was observed from its `step.started` event. */
  calibratable: boolean
  estimated: boolean
  readonly listeners: Set<(snapshot: ThroughputSnapshot) => void>
}

type TokenCounts = {
  readonly output: number
  readonly reasoning: number
}

const DEFAULT_WINDOW_MS = 2_000
const DEFAULT_TICK_MS = 250
const DEFAULT_CHARS_PER_TOKEN = 4
const MIN_RATIO = 0.5
const MAX_RATIO = 8
const CALIBRATION_FLOOR = 0.5
const CALIBRATION_CEILING = 8
/** Below this many characters a step is too short to teach the estimator anything. */
const MIN_CALIBRATION_CHARS = 200
/** Rates measured over shorter windows are noise, not throughput. */
const MIN_GENERATION_SECONDS = 0.05

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const positive = (value: number | undefined, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback

/** Monotonic arrival clock, so live samples do not depend on the server's wall clock. */
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now())

/**
 * Estimates live output throughput from streamed text, reasoning, and tool
 * input deltas. OpenCode only reports real token counts when a step ends, so
 * the live value uses a chars-per-token ratio that is seeded from the offline
 * calibration table and recalibrated after each completed step.
 *
 * Two clocks are in play and must never be mixed:
 * - `clock()` (monotonic) times the live window and the final generation rate.
 * - Server epoch-ms timestamps are only used for the wall-clock rate.
 */
export class ThroughputStore {
  private readonly trackers = new Map<string, Tracker>()
  private readonly ratios = new Map<string, number>()
  private readonly windowMs: number
  private readonly tickMs: number
  private readonly charsPerToken: number
  private readonly timer: ReturnType<typeof setInterval> & { unref?: () => void }
  private disposed = false

  constructor(options: { windowMs?: number; tickMs?: number; charsPerToken?: number } = {}) {
    this.windowMs = positive(options.windowMs, DEFAULT_WINDOW_MS, 250, 60_000)
    this.tickMs = positive(options.tickMs, DEFAULT_TICK_MS, 50, 5_000)
    this.charsPerToken = positive(options.charsPerToken, DEFAULT_CHARS_PER_TOKEN, 0.2, 32)
    for (const [modelKey, ratio] of Object.entries(CALIBRATION)) {
      if (!Number.isFinite(ratio) || ratio <= 0) continue
      this.ratios.set(modelKey, clamp(ratio, CALIBRATION_FLOOR, CALIBRATION_CEILING))
    }
    this.timer = setInterval(() => this.tick(), this.tickMs) as ReturnType<typeof setInterval> & {
      unref?: () => void
    }
    this.timer.unref?.()
  }

  watch(sessionID: string, listener: (snapshot: ThroughputSnapshot) => void) {
    const tracker = this.ensure(sessionID)
    tracker.listeners.add(listener)
    listener(this.snapshot(tracker))
    return () => {
      tracker.listeners.delete(listener)
    }
  }

  handle(event: OpenCodeEvent) {
    if (this.disposed) return

    switch (event.type) {
      case "session.step.started": {
        const tracker = this.ensure(event.data.sessionID)
        const now = clock()
        this.resetStep(tracker, now)
        tracker.active = true
        tracker.calibratable = true
        tracker.stepStartedAt =
          Number.isFinite(event.data.started) && event.data.started > 0
            ? event.data.started
            : undefined
        tracker.modelKey = `${event.data.model.providerID}/${event.data.model.id}`
        tracker.ratio = this.ratios.get(tracker.modelKey) ?? this.charsPerToken
        this.emit(tracker)
        return
      }

      case "session.text.delta":
      case "session.reasoning.delta":
      case "session.tool.input.delta": {
        const tracker = this.ensure(event.data.sessionID)
        if (!tracker.active) this.beginFallback(tracker)
        this.addChars(tracker, event.data.delta.length)
        return
      }

      case "session.step.streamed": {
        const tracker = this.trackers.get(event.data.sessionID)
        if (tracker) tracker.streamedAt = event.created
        return
      }

      case "session.step.ended": {
        const tracker = this.trackers.get(event.data.sessionID)
        if (tracker) this.finishStep(tracker, event.data.tokens, event.created)
        return
      }

      case "session.step.failed": {
        const tracker = this.trackers.get(event.data.sessionID)
        if (!tracker) return
        if (event.data.tokens) {
          this.finishStep(tracker, event.data.tokens, event.created)
        } else {
          // No usage to report: stop claiming that generation is ongoing.
          tracker.active = false
          tracker.estimated = false
          this.emit(tracker)
        }
        return
      }

      case "session.retry.scheduled": {
        const tracker = this.trackers.get(event.data.sessionID)
        if (!tracker) return
        // The previous attempt's characters would double-count against the
        // retried attempt's token total, so start the measurement over.
        this.resetStep(tracker, clock())
        tracker.active = true
        // Approximate the retry's start with the moment it was scheduled.
        tracker.stepStartedAt = event.created > 0 ? event.created : undefined
        this.emit(tracker)
        return
      }

      case "session.execution.started": {
        const tracker = this.ensure(event.data.sessionID)
        this.resetStep(tracker, clock())
        tracker.active = true
        // A session execution spans several steps and tool calls, so its start
        // is not a step start and cannot anchor a step's wall-clock rate.
        tracker.stepStartedAt = undefined
        tracker.calibratable = false
        this.emit(tracker)
        return
      }

      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
      case "session.idle": {
        const tracker = this.trackers.get(event.data.sessionID)
        if (!tracker) return
        tracker.active = false
        this.emit(tracker)
        return
      }

      case "session.status": {
        const tracker = this.trackers.get(event.data.sessionID)
        if (!tracker) return
        if (event.data.status.type === "idle") {
          tracker.active = false
          this.emit(tracker)
        } else if (event.data.status.type === "busy") {
          if (!tracker.active) {
            // Coming back from idle: drop the previous step's samples so they
            // cannot produce a phantom rate before the next step announces itself.
            this.resetStep(tracker, clock())
            tracker.active = true
            tracker.stepStartedAt = undefined
            tracker.calibratable = false
          }
          this.emit(tracker)
        }
        return
      }

      case "session.deleted": {
        this.trackers.delete(event.data.sessionID)
        return
      }
    }
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.timer)
    for (const tracker of this.trackers.values()) tracker.listeners.clear()
    this.trackers.clear()
  }

  private ensure(sessionID: string): Tracker {
    let tracker = this.trackers.get(sessionID)
    if (!tracker) {
      tracker = {
        sessionID,
        active: false,
        chars: 0,
        tokens: 0,
        ratio: this.charsPerToken,
        samples: [],
        calibratable: false,
        estimated: true,
        listeners: new Set(),
      }
      this.trackers.set(sessionID, tracker)
    }
    return tracker
  }

  private resetStep(tracker: Tracker, now: number) {
    tracker.chars = 0
    tracker.tokens = 0
    tracker.samples = [{ at: now, tokens: 0 }]
    tracker.firstOutputAt = undefined
    tracker.lastOutputAt = undefined
    tracker.streamedAt = undefined
    tracker.generationTps = undefined
    tracker.wallTps = undefined
    tracker.estimated = true
  }

  private beginFallback(tracker: Tracker) {
    this.resetStep(tracker, clock())
    tracker.active = true
    // We missed the step's start event, so the wall-clock window is unknown and
    // the character count may be partial. Both make the step a bad teacher.
    tracker.stepStartedAt = undefined
    tracker.calibratable = false
  }

  private addChars(tracker: Tracker, chars: number) {
    if (chars <= 0) return
    const now = clock()
    // Start the rolling window at the first output, so a long time-to-first-token
    // does not depress the live generation rate.
    if (tracker.chars === 0) {
      tracker.samples = [{ at: now, tokens: 0 }]
      tracker.firstOutputAt = now
    }
    tracker.lastOutputAt = now
    tracker.chars += chars
    tracker.tokens = tracker.chars / tracker.ratio
    tracker.samples.push({ at: now, tokens: tracker.tokens })
  }

  private finishStep(tracker: Tracker, tokens: TokenCounts, at: number) {
    const actual = tokens.output + tokens.reasoning
    const canCalibrate =
      tracker.calibratable && tracker.chars >= MIN_CALIBRATION_CHARS && actual > 0
    if (canCalibrate) {
      const ratio = clamp(tracker.chars / actual, MIN_RATIO, MAX_RATIO)
      if (tracker.modelKey) {
        const previous = this.ratios.get(tracker.modelKey)
        this.ratios.set(
          tracker.modelKey,
          previous === undefined ? ratio : previous * 0.7 + ratio * 0.3,
        )
      }
      tracker.ratio = ratio
    }
    if (actual > 0) tracker.tokens = actual
    tracker.estimated = false
    tracker.generationTps = this.generationRate(tracker, actual)
    tracker.wallTps = this.wallRate(tracker, actual, at)
    this.emit(tracker)
  }

  /** Real tokens over the first-to-last delta window. Matches what the live value measures. */
  private generationRate(tracker: Tracker, actual: number) {
    if (actual <= 0) return undefined
    const { firstOutputAt, lastOutputAt } = tracker
    if (firstOutputAt === undefined || lastOutputAt === undefined) return undefined
    const seconds = (lastOutputAt - firstOutputAt) / 1_000
    if (seconds < MIN_GENERATION_SECONDS) return undefined
    return actual / seconds
  }

  /** Real tokens over the server-side step window, including time to first token. */
  private wallRate(tracker: Tracker, actual: number, at: number) {
    if (actual <= 0 || tracker.stepStartedAt === undefined) return undefined
    const seconds = ((tracker.streamedAt ?? at) - tracker.stepStartedAt) / 1_000
    if (!Number.isFinite(seconds) || seconds < MIN_GENERATION_SECONDS) return undefined
    if (seconds > 3_600) return undefined
    return actual / seconds
  }

  private tick() {
    if (this.disposed) return
    for (const tracker of this.trackers.values()) {
      if (!tracker.active || !tracker.estimated) continue
      this.emit(tracker)
    }
  }

  private prune(tracker: Tracker, now: number) {
    const cutoff = now - this.windowMs
    while (tracker.samples.length > 1 && tracker.samples[1]!.at <= cutoff) tracker.samples.shift()
  }

  private snapshot(tracker: Tracker): ThroughputSnapshot {
    if (!tracker.active) return { active: false, tps: 0, tokens: 0, estimated: false }
    if (!tracker.estimated) {
      return {
        active: true,
        tps: tracker.generationTps ?? tracker.wallTps ?? 0,
        tokens: tracker.tokens,
        estimated: false,
        wallTps: tracker.wallTps,
      }
    }
    const now = clock()
    this.prune(tracker, now)
    const base = tracker.samples[0]
    if (!base) return { active: true, tps: 0, tokens: tracker.tokens, estimated: true }
    const seconds = (now - base.at) / 1_000
    if (seconds < 0.1) return { active: true, tps: 0, tokens: tracker.tokens, estimated: true }
    const tps = Math.max(0, tracker.tokens - base.tokens) / seconds
    return { active: true, tps, tokens: tracker.tokens, estimated: true }
  }

  private emit(tracker: Tracker) {
    if (tracker.listeners.size === 0) return
    const snapshot = this.snapshot(tracker)
    for (const listener of tracker.listeners) listener(snapshot)
  }
}
