import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_SETTINGS, readSettings } from "../../extensions/self-compact/settings.ts";

function paths(t: { after(fn: () => void): void }): { global: string; project: string } {
	const dir = mkdtempSync(join(tmpdir(), "self-compact-settings-"));
	t.after(() => {});
	return { global: join(dir, "settings.json"), project: join(dir, "project.json") };
}

function write(path: string, body: string) {
	writeFileSync(path, body);
}

test("missing files -> the footer stays on", (t) => {
	const { global, project } = paths(t);
	assert.deepEqual(readSettings(global, project), DEFAULT_SETTINGS);
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
	assert.deepEqual(readSettings(global, project), DEFAULT_SETTINGS);

	write(global, JSON.stringify({ piTokenCount: { dumbZoneStartTokens: 160000 } }));
	assert.deepEqual(readSettings(global, project), DEFAULT_SETTINGS);
});

test("the footer default is on, so upstream behaviour is unchanged", () => {
	assert.equal(DEFAULT_SETTINGS.footer, true);
});
