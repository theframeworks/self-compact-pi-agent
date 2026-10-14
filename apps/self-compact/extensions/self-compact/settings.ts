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
}

export const DEFAULT_SETTINGS: SelfCompactSettings = { footer: true };

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

/** Global then project: a project value wins over the global one. */
export function readSettings(globalPath: string, projectPath: string): SelfCompactSettings {
	const merged = {
		...objectValue(readObject(globalPath), SETTINGS_KEY),
		...objectValue(readObject(projectPath), SETTINGS_KEY),
	};
	const footer = merged.footer;
	return { footer: typeof footer === "boolean" ? footer : DEFAULT_SETTINGS.footer };
}
