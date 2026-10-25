import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_SPECS,
	levelFor,
	parseTokenSpec,
	resolveThresholds,
	validateSpecs,
	type ResolvedThresholds,
} from "../../extensions/self-compact/thresholds.ts";

const MILLION = 1_000_000;

function resolveOk(specs: { softAt: string; at: string; buffer: string }, window: number, fromDefaults = false): ResolvedThresholds {
	const result = resolveThresholds(specs, window, { fromDefaults });
	if (!result.ok) throw new Error(result.error);
	return result.thresholds;
}

test("parseTokenSpec accepts whole tokens, k/m suffixes, and percentages", () => {
	assert.deepEqual(parseTokenSpec("270000", "x"), { kind: "tokens", value: 270000, raw: "270000" });
	assert.deepEqual(parseTokenSpec("100k", "x"), { kind: "tokens", value: 100000, raw: "100k" });
	assert.deepEqual(parseTokenSpec("1.5m", "x"), { kind: "tokens", value: 1500000, raw: "1.5m" });
	assert.deepEqual(parseTokenSpec(" 20% ", "x"), { kind: "percent", value: 20, raw: "20%" });
	assert.deepEqual(parseTokenSpec("0", "x"), { kind: "tokens", value: 0, raw: "0" });
	assert.deepEqual(parseTokenSpec("250K", "x"), { kind: "tokens", value: 250000, raw: "250K" });
});

test("parseTokenSpec rejects invalid values", () => {
	for (const bad of ["", "   ", "-1", "abc", "1.5", "150%", "10kk", "k", "%"]) {
		assert.throws(() => parseTokenSpec(bad, "--compact-at"), /Invalid --compact-at/, `expected rejection for ${JSON.stringify(bad)}`);
	}
});

test("shipped defaults are 100k / 140k / 170k tokens, the same absolute lines on every model", () => {
	assert.deepEqual(DEFAULT_SPECS, { softAt: "100k", at: "140k", buffer: "30k" });
	for (const window of [MILLION, 272_000, 200_000]) {
		const t = resolveOk(DEFAULT_SPECS, window, true);
		assert.equal(t.softTokens, 100_000);
		assert.equal(t.warnTokens, 140_000);
		assert.equal(t.bufferTokens, 30_000);
		assert.equal(t.forcedTokens, 170_000);
		assert.equal(t.clamped, false, `no clamp on a ${window}-token window`);
	}
	// Below that the numbers cannot fit: they clamp to the 90% cap instead of rejecting, because being wrong
	// about the window must never block every tool.
	const small = resolveOk(DEFAULT_SPECS, 128_000, true);
	assert.equal(small.softTokens, 100_000);
	assert.equal(small.warnTokens, 115_200);
	assert.equal(small.forcedTokens, 115_200);
	assert.equal(small.clamped, true);
});

test("token launch 100k / 200k / 50k on 1M resolves to 100k / 200k / 250k (10% / 20% / 25%)", () => {
	const t = resolveOk({ softAt: "100k", at: "200k", buffer: "50k" }, MILLION);
	assert.equal(t.softTokens, 100_000);
	assert.equal(t.warnTokens, 200_000);
	assert.equal(t.forcedTokens, 250_000);
	assert.equal(t.softPct, 10);
	assert.equal(t.warnPct, 20);
	assert.equal(t.forcedPct, 25);
});

test("percent launch 20% / 50% / 10% on 1M resolves to 200k / 500k / 600k", () => {
	const t = resolveOk({ softAt: "20%", at: "50%", buffer: "10%" }, MILLION);
	assert.equal(t.softTokens, 200_000);
	assert.equal(t.warnTokens, 500_000);
	assert.equal(t.forcedTokens, 600_000);
});

test("zero buffer makes forced coincide with warning (immediate enforcement)", () => {
	const t = resolveOk({ softAt: "20%", at: "50%", buffer: "0" }, MILLION);
	assert.equal(t.forcedTokens, t.warnTokens);
	assert.equal(levelFor(500_000, t), "forced");
	assert.equal(levelFor(499_999, t), "notice");
});

test("hard limit is capped at 90% of the window", () => {
	const t = resolveOk({ softAt: "50%", at: "85%", buffer: "10%" }, MILLION);
	assert.equal(t.capTokens, 900_000);
	assert.equal(t.forcedTokens, 900_000);
	assert.ok(t.notes.some((n) => n.includes("capped")));
});

test("an explicit warning percentage above the cap is rejected at load", () => {
	assert.throws(() => validateSpecs({ softAt: "20%", at: "95%", buffer: "0" }), /above the 90% hard cap/);
});

test("explicit token settings above the cap of this window are clamped, not rejected", () => {
	const t = resolveOk({ softAt: "100k", at: "950k", buffer: "0" }, MILLION);
	assert.equal(t.warnTokens, 900_000);
	assert.equal(t.forcedTokens, 900_000);
	assert.equal(t.clamped, true);
	assert.ok(t.notes.some((n) => /^--compact-at \(950k\) exceeds the 90% cap .* clamped to 900000/.test(n)));
});

test("fixed token settings written for a big window fit a smaller model", () => {
	const t = resolveOk({ softAt: "160k", at: "200k", buffer: "40k" }, 200_000);
	assert.equal(t.warnTokens, 180_000);
	assert.equal(t.softTokens, 160_000);
	assert.equal(t.forcedTokens, 180_000);
});

test("explicit soft above warning: rejected at load in the same units, clamped at resolve in mixed units", () => {
	assert.throws(() => validateSpecs({ softAt: "60%", at: "50%", buffer: "0" }), /must not exceed/);
	assert.throws(() => validateSpecs({ softAt: "300k", at: "200k", buffer: "0" }), /must not exceed/);
	const t = resolveOk({ softAt: "60%", at: "500k", buffer: "0" }, MILLION);
	assert.equal(t.softTokens, 500_000);
	assert.ok(t.notes.some((n) => /--compact-soft-at \(60%\) exceeds the warning threshold; clamped to 500000/.test(n)));
});

test("token defaults larger than a small window are clamped instead of rejected", () => {
	const t = resolveOk({ softAt: "225k", at: "250k", buffer: "20k" }, 200_000, true);
	assert.equal(t.capTokens, 180_000);
	assert.equal(t.warnTokens, 180_000);
	assert.equal(t.softTokens, 180_000);
	assert.equal(t.forcedTokens, 180_000);
	assert.equal(t.clamped, true);
	assert.ok(t.notes.length >= 1);
});

test("levelFor maps tokens to levels and unknown for null", () => {
	const t = resolveOk({ softAt: "20%", at: "50%", buffer: "10%" }, 100_000);
	assert.equal(levelFor(null, t), "unknown");
	assert.equal(levelFor(0, t), "idle");
	assert.equal(levelFor(19_999, t), "idle");
	assert.equal(levelFor(20_000, t), "notice");
	assert.equal(levelFor(50_000, t), "warning");
	assert.equal(levelFor(59_999, t), "warning");
	assert.equal(levelFor(60_000, t), "forced");
	assert.equal(levelFor(100_000, t), "forced");
});
