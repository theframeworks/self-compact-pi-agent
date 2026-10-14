# Where the thresholds come from

The shipped defaults (10% / 20% / +10%) are percentages of whatever window the
active model has. On a 1M-token model that is a hard cutoff at 300k, and the
research says the useful part of a 1M window ends far earlier. This note collects
what the sources actually recommend, so the numbers in a settings file can be
argued rather than guessed.

## The main finding: onset is absolute, not proportional

Degradation onset tracks an **absolute token count**, not a fraction of the
window. "The original heuristic — complete tasks within 50% of the context
window — assumed degradation scales with window size. It does not. Degradation
onset sits closer to an absolute token threshold (roughly 32K to 100K) than a
fixed percentage, and it varies by task type."

That is the argument for token thresholds over percentages, and it is why the
same three numbers are reasonable across a whole model fleet.

| Source | Finding |
| --- | --- |
| RULER (17 models) | Multi-hop retrieval reaches 16–50% of the advertised window; larger claimed windows do not degrade proportionally later. Yi-34B claims 200K and holds 32K. |
| BABILong | Reasoning uses 10–20% of the context window. |
| LongCodeBench | Code bug fixing: 29% accuracy at 32K → 3% at 256K. Severe collapse. |
| Chroma context rot | All 18 frontier models tested degrade with input length, as "a performance gradient rather than a hard cliff". |
| LangWatch (162 days, 287,748 calls) | Two unrelated optimisations converge at **220k** and **240k**. A 200k window reaches **94% of everything any window can reach**; coverage per unit cost peaks at **240k**. "Above approximately 200k the post-compaction degraded region begins to consume a large fraction of working time." |
| WorkOS (pi-specific) | Compact at **~256k**; `reserveTokens: 64000`, `keepRecentTokens: 40000`, with the effective window capped to ~320k. |

Cost is the other half of the argument, and it is steep: cumulative tokens
consumed by the time a session first reaches a given size follows a power law
with an exponent of 2.55. Reaching 100k of context costs a median of 1.4M tokens;
reaching 200k costs 9M; reaching 800k costs 338M — 250× the 100k figure for 8×
the window. Sessions get less efficient at growing as they grow, because context
added per step shrinks (≈3,200 tokens/step below 50k, ≈1,470 above 200k) while
each step pays for the whole window beneath it.

## The dominant lever is not the threshold

LangWatch §8.1 measured post-compaction degradation directly and found the harm
concentrated at the compaction discontinuity — which is severe because only 0.8%
of the window survives it as verbatim text. Preserving a **verbatim tail of
30k–60k tokens** addresses that interval directly; the study's cycle model puts a
350k threshold with a 60k preserved tail at **25% less per unit** than a smaller
threshold with a small digest.

In pi that lever is `keepRecentTokens` (default 20000), not the compaction
threshold. WorkOS recommends 40000 for the same reason. If only one thing is
changed, change this.

## What that implies for the three lines

| Line | Token value | Why |
| --- | --- | --- |
| notice | 160,000 | The quality wall. Degradation is already under way by the models' own effective-context ceilings, so this line is a heads-up, not a decision. |
| warning | 200,000 | The cost/degradation optimum. Two independent optimisations in the largest published corpus converge at 220k/240k; WorkOS lands at 256k for pi; 200k is where the degraded region starts eating working time, and it is the number the study's proposed experiment varies. |
| hard cutoff (warning + buffer) | 240,000 | The coverage-per-cost peak. Also 32k under Anthropic's 272k long-context pricing cliff, which is the response runway the buffer exists to provide. |

On a 1M window: notice at 16%, warning at 20%, cutoff at 24%. Every model in this
fleet holds 1M, so none of the three is clamped by the 90%-of-window cap.

## Capping the effective window

The bar, pi's native auto-compaction, and the percentages in any older config all
scale to `contextWindow`. Leaving it at 1M means a threshold at 240k is drawn in
the first quarter of a bar whose remaining three quarters are unusable, and pi's
own auto-compaction sits at 984k as a backstop that will never usefully fire.

Capping the window makes every one of those agree on the range the evidence
supports. It is a per-model override in `~/.pi/agent/models.json`, and
`scripts/pi-context-window.sh` in the Pi config flips it:

```bash
~/.pi/agent/scripts/pi-context-window.sh          # what is set now
~/.pi/agent/scripts/pi-context-window.sh off      # real windows
~/.pi/agent/scripts/pi-context-window.sh 320000   # cap at 320000
```

At 320k the three lines land at 50%, 62.5% and 75%, two dots on the bar stay
four cells apart, and Pi's own auto-compaction becomes a backstop at 303,616
tokens rather than a number that can never be reached.

### Why this cannot be an extension setting

The cap has to live in Pi's model metadata, because that is the only copy every
reader shares: Pi core for `contextTokens > contextWindow - reserveTokens`, this
extension for the 90% ceiling, pi-statusline for the bar's scale and percentage,
and the `contextWindow` field of the feed — which a consumer validates against to
drop a stale payload. Two extensions each holding their own idea of the window is
exactly the drift that validation exists to catch.

An extension cannot write it either. `registerProvider` is the only model-facing
API and its `ProviderConfig` has no `modelOverrides`: passing `models` replaces
the provider's entire model list, so patching one entry means redefining all of
them. `modelOverrides` in `models.json` is declarative, per-model,
non-destructive, and applied before any extension reads `ctx.model`.

### The trade-off

This is WorkOS's recommendation and it costs nothing the research can measure —
but it does foreclose the fidelity position, which holds that summarisation is
lossy in ways invisible at the moment of loss. Practitioners in that camp
"routinely run thresholds at 500,000 tokens and above, arrived at by trial and
error". Hence a switch rather than a default: the cap is on here because the
gauge is worth reading, and it is one command to drop.

## Sources

- LangWatch, *Finding the Optimal Context Window for Coding Agents: A Case Study* — <https://langwatch.ai/research/finding-the-optimal-context-window>
- WorkOS, *Stop giving your coding agent a million-token context window* — <https://workos.com/blog/coding-agent-context-window-compaction-settings>
- Agent Patterns, *Context Window Management: Understanding the Dumb Zone* (citing RULER, BABILong, LongCodeBench, NoLiMa, Chroma) — <https://agentpatterns.ai/context-engineering/context-window-dumb-zone/>
- Anthropic, *Effective context engineering for AI agents* — <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Pi, *Compaction Reference* (`reserveTokens` 16384, `keepRecentTokens` 20000 defaults) — <https://pi.dev/docs/latest/compaction>
