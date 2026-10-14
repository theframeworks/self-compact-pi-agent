/**
 * The extension's own settings, read from the `selfCompact` key of Pi's global
 * and project settings files.
 *
 * Pure module: the caller supplies the two paths, so this stays testable under
 * `node --test` with no Pi import (see ./prompts.ts for the same convention).
 * Malformed or missing settings always fall back to the defaults: a broken
 * settings file must never take the footer down with it.
 */

import { existsSync, readFileSync } from "node:fs";

const SETTINGS_KEY = "selfCompact";

export interface SelfCompactSettings {
	/**
	 * Draw the one-line context footer.
	 *
	 * Turn off when another extension owns the footer (pi-statusline) and draws
	 * these thresholds on its own context bar: Pi has a single custom-footer
	 * slot, so two extensions installing one is last-writer-wins. With the
	 * footer off the extension still publishes its status through
	 * `ctx.ui.setStatus()` — which the built-in footer draws — and emits the
	 * same numbers as a structured feed for a footer that draws them.
	 */
	footer: boolean;
	/**
	 * Block every tool except self_compact at the hard cutoff.
	 *
	 * On by default, and the only setting here that can strand a session. It is safe
	 * only while summary generation can be trusted to finish: at the cutoff with the
	 * lock on and the summarizer failing, the retry cannot succeed, so every other
	 * tool stays blocked and nothing reaches the point where the lock is released.
	 * Turn it off when running a Pi version whose summary input this extension has
	 * not been checked against. The thresholds, the phase tag and the guidance
	 * messages keep working; they just stop being enforced.
	 */
	lockTools: boolean;
	/**
	 * Thresholds in tokens: the same three knobs as the flags, for a Pi launched
	 * through an installed package where no flags can be passed. The flags win
	 * when both are given, so a launch can override a settings file without
	 * editing it. Unset means the flag, else the shipped default.
	 *
	 * Tokens rather than percentages, because a percentage moves with the model:
	 * 20% is 20k tokens of a 100k window and 200k tokens of a 1m one, so the same
	 * number cannot be reasoned about across a model switch. `warnTokens +
	 * bufferTokens` is the hard cutoff, exactly as `--compact-buffer` extends
	 * `--compact-at`.
	 */
	softTokens?: number;
	warnTokens?: number;
	bufferTokens?: number;
}

export const DEFAULT_SETTINGS: SelfCompactSettings = { footer: true, lockTools: true };

function readObject(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function objectValue(source: Record<string, unknown> | undefined, key: string): Record<string, unknown> | undefined {
	const value = source?.[key];
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * A threshold from settings.
 *
 * Only a whole, non-negative number: the `60k` shorthand belongs to the flags,
 * and a percentage would put back the model-relative scale that token
 * thresholds exist to avoid. Anything else is ignored rather than rejected, so
 * a typo falls back to the flag or to the shipped default instead of leaving a
 * session unable to resolve a threshold at all; `/self-compact-info` prints the
 * resolved value and where it came from, so the fallback is visible there.
 */
function tokenValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Global then project: a project value wins over the global one. */
export function readSettings(globalPath: string, projectPath: string): SelfCompactSettings {
	const merged = {
		...objectValue(readObject(globalPath), SETTINGS_KEY),
		...objectValue(readObject(projectPath), SETTINGS_KEY),
	};
	const footer = merged.footer;
	const lockTools = merged.lockTools;
	return {
		footer: typeof footer === "boolean" ? footer : DEFAULT_SETTINGS.footer,
		lockTools: typeof lockTools === "boolean" ? lockTools : DEFAULT_SETTINGS.lockTools,
		softTokens: tokenValue(merged.softTokens),
		warnTokens: tokenValue(merged.warnTokens),
		bufferTokens: tokenValue(merged.bufferTokens),
	};
}
