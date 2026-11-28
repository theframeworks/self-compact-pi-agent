# self-compact

The Pi (v1.3.0) extension. The story, the demo, and the install steps are in the [root README](../../README.md). This page is the reference.

## Run

```bash
pi -e extensions/self-compact/self-compact.ts                                                  # shipped defaults: 100k / 140k / 170k tokens
pi -e extensions/self-compact/self-compact.ts --compact-soft-at 15% --compact-at 40% --compact-buffer 5%
pi -e extensions/self-compact/self-compact.ts --compact-soft-at 100k --compact-at 200k --compact-buffer 50k
```

| Flag | Meaning | Default |
| --- | --- | --- |
| `--compact-soft-at` | notice line: awareness only, nothing changes | `100k` tokens |
| `--compact-at` | warning line: time to write a note and compact soon | `140k` tokens |
| `--compact-buffer` | allowance above the warning before every other tool is blocked (`0` = block at the warning) | `30k` (hard cutoff 170k) |
| `--compact-prompt` | literal text that replaces the compaction summary system prompt | unset |

Values are token counts (`270000`, `100k`, `1.5m`) or, where a share of the window is what you mean, percentages of it (`20%`). The shipped defaults are absolute tokens because degradation onset tracks the number of tokens in context rather than the fraction of the window. The hard cutoff is `min(warning + buffer, 90% of the window)`. Defaults live in `extensions/self-compact/defaults.ts`. Token counts that don't fit the current model (a warning above 90% of a smaller window, say) are clamped to fit, with a note. Settings that are wrong whatever the model (bad syntax, a percentage above 90%, soft above warning in the same units) are rejected: `/self-compact-info` reports the error and every tool is blocked until they are fixed.

## Tools and commands

- `self_compact(note_to_self)`: saves the note (1 to 24,000 chars), ends the turn, compacts before the run settles, returns the note verbatim as the next message in the same run. While it compacts, Pi's working row reads `Self-compact: compacting (attempt N/3)…` (Pi hides that row at the end of the turn, so without it the session would look idle) (a failed compaction is retried in that same run before it settles, the last time with Pi's built-in summary; if every attempt fails, `lockTools` decides: on, the tools stay locked at the cutoff with the note saved; off, the note comes back uncompacted and the tools unlock). Refuses when Pi would find nothing to compact (the session still fits inside `keepRecentTokens`).
- `view_context()`: the agent's own gauge as JSON: used tokens, percent, window, level, the three thresholds, tokens left before each, lock state, cycle count. Allowed even while other tools are locked.
- `/self-compact-info`: settings, resolved thresholds, usage, state, cycles, prompt sources, pending note. No model turn.
- `/self-compact on|off`: turns the nudges off for the rest of the session — guidance, threshold entries, notifications and the tool lock all stand down, and a lock already in force is released. The footer keeps publishing the real numbers and its phase tag reads `OFF`, so a muted session is not a silent one. Runtime only: `/reload` or a new session re-arms them, and the setting stays available as `selfCompact.lockTools: false` for a permanently advisory setup.
- `/self-compact-now`: asks the agent to write its note and call `self_compact` (reuses a saved note on retry). Built-in `/compact` is untouched and uses the same summary prompt. Pi's automatic compaction also uses it, and is held back only while a saved note waits for its own compaction.

## Prompt files

`.pi/self-compact/` is looked up in the current directory first, then next to this app. Files are read fresh on every use.

| File | When the model sees it |
| --- | --- |
| `USER_PROMPT_SOFT_SELF_COMPACT.md` | message sent once when the notice line is crossed |
| `USER_PROMPT_WARNING_SELF_COMPACT.md` | message sent once when the warning line is crossed |
| `USER_PROMPT_COMPACTION_MESSAGE.md` | system prompt of the summary call (`--compact-prompt` overrides it) |
| `USER_PROMPT_SUMMARY_INSTRUCTIONS.md` | optional: replaces Pi's user instructions for the summary call |

Placeholders: `{{used_tokens}}`, `{{used_percent}}`, `{{context_window}}`, `{{cached_tokens}}`, `{{soft_tokens}}`, `{{soft_percent}}`, `{{warning_tokens}}`, `{{warning_percent}}`, `{{forced_tokens}}`, `{{forced_percent}}`, `{{remaining_to_forced}}`, `{{cycle}}`, `{{note_max_chars}}`. Each threshold crossing also prints the rendered message once in the TUI, collapsed to one line of numbers until Ctrl+O expands it; the handoff collapses the same way, to its header and the note's NEXT ACTION. Empty or unreadable override files report an error instead of silently falling back.

## Tests

```bash
npm run test:unit            # thresholds, bar, prompts, recovery reducer
npm run test:parity          # the extension through Pi's loader with a fake session
npm run test:e2e             # real `pi --mode rpc` with a scripted provider, zero API cost
SC_REAL=1 npm run test:real  # live model; SC_REAL_MODEL picks it (just real uses openrouter/deepseek/deepseek-v4.1-flash)
bash scripts/verify.sh       # all of the above plus a tmux footer capture; logs in verification/ (gitignored)
```

No npm dependencies: Pi's loader supplies its packages at runtime and Node 24 strips types for the tests.

## Layout

```
extensions/self-compact/
  self-compact.ts    entry: flags, tools, commands, events, footer, handoff
  defaults.ts        shipped thresholds (100k / 140k / 170k tokens) and the 90% cap
  thresholds.ts      parse (tokens / k / m / %), validate, resolve against the window, level
  context-bar.ts     20-cell bar renderer
  prompts.ts         prompt lookup, templating, precedence, built-in fallbacks
  summary.ts         native compaction call with the replacement prompt; nothing-to-compact check
  builtin-summary.ts Pi's own compaction summary, from inside a hook (the last attempt)
  state.ts           state snapshot, durable handoff id, recovery reducer
.pi/self-compact/    the prompt files above
tests/               unit, parity, harness (scripted provider, RPC client), e2e
scripts/             verify.sh, tui-smoke.sh
```
