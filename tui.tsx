/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { ThroughputStore, type ThroughputSnapshot } from "./tracker.ts"

function formatTps(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0.0"
  return value.toFixed(1)
}

function ThroughputFooter(props: { store: ThroughputStore; sessionID?: string }) {
  const context = usePlugin()
  const [snapshot, setSnapshot] = createSignal<ThroughputSnapshot>()

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) {
      setSnapshot(undefined)
      return
    }
    const stop = props.store.watch(sessionID, (value) => setSnapshot(value))
    onCleanup(stop)
  })

  return (
    <Show when={snapshot()?.active && (snapshot()?.tokens ?? 0) > 0 ? snapshot() : undefined}>
      {(value) => (
        <text
          fg={value().estimated ? context.theme.text.muted : context.theme.text.feedback.success.base}
          flexShrink={0}
        >
          {value().estimated ? "~" : ""}
          {formatTps(value().tps)} tok/s
        </text>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "local.token-throughput",
  setup(context) {
    const options = context.options
    const store = new ThroughputStore({
      windowMs: typeof options.windowMs === "number" ? options.windowMs : undefined,
      charsPerToken: typeof options.charsPerToken === "number" ? options.charsPerToken : undefined,
    })
    const stop = context.data.listen(({ details }) => store.handle(details))

    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <ThroughputFooter store={store} sessionID={input.sessionID} />,
    })

    return () => {
      stop()
      store.dispose()
    }
  },
})
