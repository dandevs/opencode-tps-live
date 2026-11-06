# opencode-tps-live

A live **tokens-per-second** readout for [OpenCode](https://opencode.ai)'s TUI
prompt footer. It shows throughput while a model is generating, then settles on
the measured rate once the step finishes.

```
~12.3 tok/s   while streaming (estimate, muted colour)
 12.3 tok/s   after the step ends (real rate, success colour)
```

The footer hides itself when the session is idle, so it only takes up space
when there is something to measure.

## How it works

OpenCode only reports real token counts when a step **ends**, so there is
nothing to divide by while text is still arriving. The plugin bridges that gap:

1. It counts characters from streamed text, reasoning, and tool-input deltas.
2. It converts them to tokens with a chars-per-token ratio and computes a
   rolling average over the last 2 seconds. The ratio starts from a table
   measured offline per model (`calibration.ts`), not a global constant.
3. When the step ends it compares the character count with the real
   `output + reasoning` token count, and feeds the derived ratio back as the
   starting ratio for the next step. The ratio is kept **per model**, smoothed
   with a 70/30 exponential moving average, so the estimate converges on your
   models quickly.
4. The final value is computed from the real token count over the streamed
   duration, not from the estimate.

That is why the live number is prefixed with `~`: it is an estimate. The value
without `~` is measured.

## Calibration

`calibration.ts` holds a chars-per-token value for each model, fitted offline
from data OpenCode already stores: every finished assistant message records the
provider-reported token counts alongside the text that was streamed. No
tokenizer runs at runtime, so the footer stays O(1) per delta.

The shipped table was generated from one developer's local history; your
content mix may differ, so regenerate it periodically:

```sh
bun run calibrate                                  # writes calibration.ts
bun run calibrate -- --min-steps 50                # require more evidence
bun run calibrate -- --db /path/to/opencode.db     # non-default database
bun run calibrate -- --stdout                      # preview, do not write
```

The tool prints the fit for each model:

```
"opencode-go/deepseek-v4.1-flash": 3.390, // n=514, agg=3.48, MAPE 21.0% -> 14.7%
```

`n` is the number of steps used, `agg` the aggregate chars/token, and the two
percentages are mean absolute percentage error before and after calibration.
Models below `--min-steps` are omitted and the tracker falls back to 4.

Known limitation: models that report reasoning tokens without streaming the
reasoning text (for example GPT-5.x behind Copilot) have almost no characters
per token and no single ratio fits them well. They are calibrated anyway, but
expect a much larger error until the step ends and real counts arrive.

## Installation

### Requirements

- OpenCode **v2+** with the TUI (`opencode v2.2.5` and newer are known to work).
- `git` (only to fetch the plugin; no build step and no `npm install` needed —
  the TUI runtime supplies `solid-js`, `@opentui/*`, and `@opencode/plugin/tui`
  at load time).

### 1. Put the plugin in your OpenCode config

Clone it into the global plugins directory, which OpenCode creates if missing:

```sh
git clone https://github.com/dandevs/opencode-tps-live.git \
  ~/.config/opencode/plugins/token-throughput
```

Any other location works too — see the note below — but this is the path used
in the examples.

> OpenCode resolves plugin paths relative to the config directory
> (`~/.config/opencode` by default, or `$XDG_CONFIG_HOME/opencode`). Keep that
> in mind if you clone somewhere else.

### 2. Enable it in `cli.json`

Add the plugin to the `plugins` array in `~/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["./plugins/token-throughput"]
}
```

If you already have plugins listed there, append to the existing array instead
of replacing it. Do not add a trailing `/tui.tsx` — point at the directory; the
`exports` field in `package.json` resolves `./tui`.

### 3. Restart OpenCode

Quit and relaunch the TUI. Start a session, send a prompt, and the footer will
show `~N tok/s` while the reply streams, then `N tok/s` when it completes.

If nothing appears:

- Confirm the file exists: `ls ~/.config/opencode/plugins/token-throughput/tui.tsx`
- Confirm the entry in `cli.json` matches the directory name exactly.
- Check that you are on OpenCode v2 — v1 does not support this plugin API.
- Verify the JSON is valid (no comments, no trailing commas).

### Updating

```sh
git -C ~/.config/opencode/plugins/token-throughput pull
```

then restart OpenCode.

## Configuration

The defaults are fine for most use. To override them, use the object form:

```json
{
  "plugins": [
    {
      "package": "./plugins/token-throughput",
      "options": {
        "windowMs": 2000,
        "charsPerToken": 4
      }
    }
  ]
}
```

| Option | Default | Meaning |
|---|---|---|
| `windowMs` | `2000` | Rolling averaging window for the live estimate, in milliseconds. Lower is twitchier and more responsive; higher is smoother. |
| `charsPerToken` | `4` | Fallback for models missing from `calibration.ts`. Models in the table start from their measured value instead. |

The plugin id is `local.token-throughput`, useful if you need to confirm which
plugins loaded.

## Repository layout

| File | Role |
|---|---|
| `tui.tsx` | Plugin entry point. Registers the plugin, owns the store, and renders the footer via a `prompt.footer.status` slot. |
| `tracker.ts` | `ThroughputStore` — event handling, the rolling window, and per-model ratio calibration. Framework-independent. |
| `calibration.ts` | Generated table of chars-per-token per model. Regenerate with `bun run calibrate`. |
| `tools/calibrate.ts` | Offline fitter: reads the OpenCode database and writes `calibration.ts`. Never loaded at runtime. |
| `package.json` | Exports map that tells OpenCode where the TUI entry point lives. |

## License

[The Unlicense](LICENSE) — released into the public domain. Copy it, strip the
license off, vendor it, sell it, relicense it: no attribution and no notice
required.
