import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SETTINGS, readSettings, type SelfCompactSettings } from "../../extensions/self-compact/settings.ts";

function paths(t: { after(fn: () => void): void }): { global: string; project: string } {
	const dir = mkdtempSync(join(tmpdir(), "self-compact-settings-"));
	t.after(() => {});
	return { global: join(dir, "settings.json"), project: join(dir, "project.json") };
}

function write(path: string, body: string) {
	writeFileSync(path, body);
}

/** Nothing was asked for: the footer is on and every threshold is unset, so each falls back to its flag or default. */
function assertDefaults(settings: SelfCompactSettings) {
	assert.equal(settings.footer, DEFAULT_SETTINGS.footer);
	assert.equal(settings.softTokens, undefined);
	assert.equal(settings.warnTokens, undefined);
	assert.equal(settings.bufferTokens, undefined);
}

function settingsFile(body: unknown): string {
	return JSON.stringify(body);
}

test("missing files -> the footer stays on", (t) => {
	const { global, project } = paths(t);
	assertDefaults(readSettings(global, project));
});

test("selfCompact.footer false turns the footer off", (t) => {
	const { global, project } = paths(t);
	write(global, JSON.stringify({ selfCompact: { footer: false } }));
	assert.equal(readSettings(global, project).footer, false);
});

test("the project value wins over the global one", (t) => {
	const { global, project } = paths(t);
	write(global, JSON.stringify({ selfCompact: { footer: false } }));
	write(project, JSON.stringify({ selfCompact: { footer: true } }));
	assert.equal(readSettings(global, project).footer, true);
});

test("a non-boolean footer falls back to the default", (t) => {
	const { global, project } = paths(t);
	write(global, JSON.stringify({ selfCompact: { footer: "no" } }));
	assert.equal(readSettings(global, project).footer, true);
});

test("malformed JSON, a JSON array and an unrelated key are all ignored", (t) => {
	const { global, project } = paths(t);
	write(global, "{ not json");
	write(project, "[1,2,3]");
	assertDefaults(readSettings(global, project));

	write(global, JSON.stringify({ piTokenCount: { dumbZoneStartTokens: 160000 } }));
	assertDefaults(readSettings(global, project));
});

test("the footer default is on, so upstream behaviour is unchanged", () => {
	assert.equal(DEFAULT_SETTINGS.footer, true);
});

test("token thresholds are read as plain token counts", (t) => {
	const { global, project } = paths(t);
	write(global, settingsFile({ selfCompact: { footer: false, softTokens: 60000, warnTokens: 120000, bufferTokens: 40000 } }));
	const settings = readSettings(global, project);
	assert.equal(settings.footer, false);
	assert.equal(settings.softTokens, 60000);
	assert.equal(settings.warnTokens, 120000);
	// The hard cutoff is warn + buffer = 160k, the same arithmetic as the flags.
	assert.equal(settings.bufferTokens, 40000);
});

test("a project threshold wins over a global one, one key at a time", (t) => {
	const { global, project } = paths(t);
	write(global, settingsFile({ selfCompact: { softTokens: 60000, warnTokens: 120000 } }));
	write(project, settingsFile({ selfCompact: { warnTokens: 100000 } }));
	const settings = readSettings(global, project);
	assert.equal(settings.warnTokens, 100000);
	// Merging is per key, so the global soft threshold is still in force.
	assert.equal(settings.softTokens, 60000);
});

test("a zero buffer is a real value, not a missing one", (t) => {
	const { global, project } = paths(t);
	write(global, settingsFile({ selfCompact: { bufferTokens: 0 } }));
	assert.equal(readSettings(global, project).bufferTokens, 0);
});

test("thresholds that are not whole token counts are ignored, never fatal", (t) => {
	const { global, project } = paths(t);
	// A percentage is what these settings exist to replace, "60k" is flag syntax,
	// and the rest are simply not token counts. Each one falls back on its own.
	for (const bad of ["60k", "20%", -1, 1.5, null, true, [], {}]) {
		write(global, settingsFile({ selfCompact: { softTokens: bad, warnTokens: bad, bufferTokens: bad } }));
		assertDefaults(readSettings(global, project));
	}
});

test("a good threshold survives a sibling that is not", (t) => {
	const { global, project } = paths(t);
	write(global, settingsFile({ selfCompact: { softTokens: "60k", warnTokens: 120000, bufferTokens: true } }));
	const settings = readSettings(global, project);
	assert.equal(settings.softTokens, undefined);
	assert.equal(settings.warnTokens, 120000);
	assert.equal(settings.bufferTokens, undefined);
});
