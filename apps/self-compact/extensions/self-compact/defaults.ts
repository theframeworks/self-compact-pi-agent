/**
 * Default thresholds for the self-compact extension. Edit here to change the shipped defaults.
 *
 * Token counts, not percentages of the window: degradation onset tracks an absolute number of tokens in context,
 * not a fraction of the window, so 20% is 20k tokens on a 100k model and 200k on a 1M one. These keep a session
 * inside the part of the window where the model still works well — the cutoff sits under two thirds of a 272k
 * window and at 17% of a 1M one, and a model whose input price rises above 100k tokens starts paying there,
 * which is where the handoff is first suggested.
 *
 *   notice      100k   soft heads-up, nothing changes            --compact-soft-at 100k
 *   warning     140k   time to write a note and compact soon     --compact-at 140k
 *   hard cutoff 170k   every tool except self_compact is blocked --compact-buffer 30k   (140k + 30k)
 *
 * A window too small to hold them clamps to its 90% cap with a note rather than rejecting; a percentage is still
 * accepted where a share of the window is what you mean.
 *
 * Override at launch with the CLI flags, e.g.
 *   pi -e extensions/self-compact/self-compact.ts --compact-soft-at 150k --compact-at 220k --compact-buffer 40k
 *   just soft=150k warn=220k buffer=40k run
 */
export interface ThresholdSpecs {
	/** --compact-soft-at: notice line. */
	softAt: string;
	/** --compact-at: warning line. */
	at: string;
	/** --compact-buffer: allowance above the warning line before the hard cutoff (0 = cutoff at the warning line). */
	buffer: string;
}

export const DEFAULT_SPECS: ThresholdSpecs = { softAt: "100k", at: "140k", buffer: "30k" };

/** The hard cutoff never sits above this fraction of the model window. */
export const HARD_CAP_FRACTION = 0.9;
