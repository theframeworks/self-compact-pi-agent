# What the evidence says about context size and code quality (2026)

Written for one configuration: autonomous agents producing code unattended, where
nobody is watching the footer and no human can interrupt a degraded turn. The
question is therefore not "how large a window will the vendor sell me" but "at
what point does the work itself get worse in a way nobody will notice".

`compaction-thresholds.md` collects the 2024–25 evidence behind the shipped
defaults. This note adds what has been published since, the model-specific
numbers for the fleet in use, and the two findings that change the argument.

## The fleet

| model | window | max output | list price (in / out per MTok) | position |
| --- | --- | --- | --- | --- |
| `claude-opus-5-5` | 1M | 128k | $4 / $20 | the model that writes the code |
| `claude-sonnet-5-5` | 1M | 128k | $2 / $10 | lighter implementation work |
| `claude-haiku-5-5` | 1M | 128k | from $0.10 / $0.50 | classification, routing, subagents |
| `deepseek-v4.1-flash` | 1M | — | — | 14-word recaps, never threshold-bound |

Anthropic's own guidance states the general case plainly: "As token count grows,
accuracy and recall degrade" ([context windows][aw]). For Opus 5.5 specifically,
the prompting guide reports it "sustains long-running autonomous work better
than Claude Opus 5" and carries a change through a large repository until tests
pass ([prompting Opus 5.5][ap]). Capability at a given context length is
generation-specific; no single threshold is right for every model indefinitely.

## Finding 1: code degrades at lengths far below the window

The most task-relevant study is [The Limits of Long-Context Reasoning in
Automated Bug Fixing][bf] (arXiv 2602.16069, March 2026). It pre-places the
relevant files in the prompt — **retrieval is perfect by construction**, so
nothing can be blamed on a missed file — and still finds performance "degrades
sharply" at **64k tokens** of context:

| model | single-shot resolve rate at 64k |
| --- | --- |
| Qwen3-Coder-30B-A3B | 7% |
| GPT-5-nano | 0% |

Failure modes are the ones an unattended run cannot catch by eye: hallucinated
diffs, patches applied to the wrong file, malformed patch headers. The authors
attribute them to usable context capacity, not to retrieval.

Its agentic half is more useful still: GPT-5-nano reaches up to 31% resolve on
100 samples, and **successful trajectories typically stay under 20k–30k tokens**,
with longer accumulated context correlating with lower success.

[LongCodeBench][lcb] (2025) found the same shape on the earlier generation:
accuracy peaks at **64k–128k** for nearly every model, and bug-fixing accuracy
falls from 29% at 32k to 3% at 256k.

## Finding 2: the 2026 frontier has moved, but mostly on retrieval tasks

Two newer results point the other way, and both have narrow scope:

- A controlled cross-provider test ([Is Context Rot Real?][cr], June 2026) found
  **no measurable length-driven degradation up to 150k tokens** on gpt-5.5,
  gpt-5.4, gpt-5.4-mini and claude-sonnet-4-6. Its own caveats matter: the
  probes are controlled tasks rather than multi-turn agentic work, and the
  frontier arms had coarse per-condition power.
- A field report on Opus 5.5 puts noticeable degradation **past ~700k**, with no
  loss of quality up to ~500k ([r/ClaudeAI][rd], September 2026). This is one
  user's impression of a long pipeline build, not a measured resolve rate, and
  writing long files is not the same task as landing a correct patch.

Read together: retrieval and prose stay usable far longer than one might fear,
while code changes that depend on exact state degrade much earlier. The older
[RULER/BABILong/Chroma][chroma] onset figures of "roughly 32k to 100k" describe
2024-era models; the direction is unchanged, the absolute length is not.

## Finding 3: the token counts are not comparable across tokenizer generations

Haiku 5.5 and the 4.7+ generation use a newer tokenizer in which **the same text
counts as roughly 30% more tokens** than on the models the defaults were chosen
against ([what's new in Haiku 5.5][tn]). Every threshold in this extension is an
absolute token count, so on the current fleet `170k` holds less text than `170k`
did when the number was picked — about three quarters of it. The drift is
conservative, but it means the effective text budget is not what the number
looks like, and it moves again with the next tokenizer.

## Finding 4: the harm concentrates at the compaction discontinuity

The [LangWatch corpus study][lw] (in `compaction-thresholds.md`) measured
post-compaction degradation directly: only ~0.8% of the window survives a
compaction as verbatim text, and the harm is concentrated in that interval. Its
cycle model puts a 350k threshold with a **60k verbatim tail** at 25% less cost
per unit than a smaller threshold with a small digest. In pi that lever is
`compaction.keepRecentTokens`, not the threshold.

## What this implies for unattended code work

1. **Place the cutoff by task, not by window.** For code, the published accuracy
   curves still peak under ~128k and break down by ~256k. 100k / 140k / 170k
   sits inside that band, and the 2026 evidence does not justify moving it out
   while the goal is patches that compile and tests that pass.
2. **The threshold is not the main safeguard.** Successful agentic trajectories
   in the bug-fixing study were under 20k–30k tokens. An agent that needs 150k of
   exploration to land one change is already outside the regime where the
   evidence says it works; no threshold fixes that, task decomposition does.
3. **Verification beats self-assessment.** Hallucinated diffs and wrong-file
   patches are silent. An unattended agent needs a loop that runs the tests and
   reads the failure, not one that reports success.
4. **Keep the verbatim tail large.** 60k (`keepRecentTokens`) over 20k, because
   the summary carries intent while the tail carries signatures and diffs.
5. **A new session beats a compaction** when the task changes: a fresh prompt has
   no lossy summary in it at all.
6. **Re-open this note when the fleet changes.** Capability per token and the
   tokenizer both moved in the last twelve months; a threshold argued in 2025 is
   an assumption in 2026.

[aw]: https://platform.claude.com/docs/en/build-with-claude/context-windows
[ap]: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5
[bf]: https://arxiv.org/abs/2602.16069
[lcb]: https://arxiv.org/html/2505.07897v3
[cr]: https://doi.org/10.5281/zenodo.20753848
[rd]: https://www.reddit.com/r/ClaudeAI/comments/1wobx5g/opus_55_context_degradation/
[chroma]: https://www.trychroma.com/research/context-rot
[tn]: https://platform.claude.com/docs/en/models/haiku-5-5/whats-new-haiku-5-5
[lw]: ./compaction-thresholds.md
