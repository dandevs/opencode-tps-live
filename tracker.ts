import type { OpenCodeEvent } from "@opencode/client"
import { CALIBRATION } from "./calibration.ts"

export type ThroughputSnapshot = {
  readonly active: boolean
  readonly tps: number
  readonly tokens: number
  readonly estimated: boolean
}

type Sample = {
  readonly at: number
  readonly tokens: number
}

type Tracker = {
  readonly sessionID: string
  active: boolean
  startedAt: number
  streamedAt?: number
  chars: number
  tokens: number
  ratio: number
  modelKey?: string
  samples: Sample[]
  actualTps?: number
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

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** Monotonic arrival clock, so live samples do not depend on the server's wall clock. */
const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now())

/**
 * Estimates live output throughput from streamed text, reasoning, and tool
 * input deltas. OpenCode only reports real token counts when a step ends, so
 * the live value uses a chars-per-token ratio that is seeded from the offline
 * calibration table and recalibrated after each completed step.
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
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS
    this.charsPerToken = options.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
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
        tracker.active = true
        tracker.startedAt = event.data.started
        tracker.streamedAt = undefined
        tracker.chars = 0
        tracker.tokens = 0
        tracker.actualTps = undefined
        tracker.estimated = true
        tracker.modelKey = `${event.data.model.providerID}/${event.data.model.id}`
        tracker.ratio = this.ratios.get(tracker.modelKey) ?? this.charsPerToken
        tracker.samples = [{ at: now, tokens: 0 }]
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
        if (event.data.tokens) this.finishStep(tracker, event.data.tokens, event.created)
        else {
          this.emit(tracker)
        }
        return
      }

      case "session.execution.started": {
        const tracker = this.ensure(event.data.sessionID)
        const now = clock()
        tracker.active = true
        tracker.startedAt = event.created
        tracker.streamedAt = undefined
        tracker.chars = 0
        tracker.tokens = 0
        tracker.actualTps = undefined
        tracker.estimated = true
        tracker.samples = [{ at: now, tokens: 0 }]
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
          tracker.active = true
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
        startedAt: Date.now(),
        chars: 0,
        tokens: 0,
        ratio: this.charsPerToken,
        samples: [],
        estimated: true,
        listeners: new Set(),
      }
      this.trackers.set(sessionID, tracker)
    }
    return tracker
  }

  private beginFallback(tracker: Tracker) {
    const now = clock()
    tracker.active = true
    tracker.startedAt = now
    tracker.streamedAt = undefined
    tracker.chars = 0
    tracker.tokens = 0
    tracker.actualTps = undefined
    tracker.estimated = true
    tracker.samples = [{ at: now, tokens: 0 }]
  }

  private addChars(tracker: Tracker, chars: number) {
    if (chars <= 0) return
    const now = clock()
    // Start the rolling window at the first output, so a long time-to-first-token
    // does not depress the live generation rate.
    if (tracker.chars === 0) tracker.samples = [{ at: now, tokens: 0 }]
    tracker.chars += chars
    tracker.tokens = tracker.chars / tracker.ratio
    tracker.samples.push({ at: now, tokens: tracker.tokens })
    this.prune(tracker, now)
    this.emit(tracker)
  }

  private finishStep(tracker: Tracker, tokens: TokenCounts, at: number) {
    const actual = tokens.output + tokens.reasoning
    if (actual > 0 && tracker.chars > 0) {
      const ratio = clamp(tracker.chars / actual, MIN_RATIO, MAX_RATIO)
      if (tracker.modelKey) {
        const previous = this.ratios.get(tracker.modelKey)
        this.ratios.set(tracker.modelKey, previous === undefined ? ratio : previous * 0.7 + ratio * 0.3)
      }
      tracker.ratio = ratio
    }
    if (actual > 0) tracker.tokens = actual
    tracker.estimated = false
    const seconds = Math.max(0.001, ((tracker.streamedAt ?? at) - tracker.startedAt) / 1_000)
    tracker.actualTps = actual > 0 ? actual / seconds : 0
    this.emit(tracker)
  }

  private tick() {
    if (this.disposed) return
    const now = clock()
    for (const tracker of this.trackers.values()) {
      if (!tracker.active || !tracker.estimated) continue
      this.prune(tracker, now)
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
      return { active: true, tps: tracker.actualTps ?? 0, tokens: tracker.tokens, estimated: false }
    }
    const base = tracker.samples[0]
    if (!base) return { active: true, tps: 0, tokens: tracker.tokens, estimated: true }
    const seconds = (clock() - base.at) / 1_000
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
