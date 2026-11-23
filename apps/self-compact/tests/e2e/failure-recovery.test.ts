/**
 * Failure and recovery: a failing summarizer keeps the note and the lock while retries remain, every automatic
 * attempt is spent inside the run that saved the note, /self-compact-now includes the saved note verbatim, a restart
 * with --session restores the handoff and finishes it once the summarizer works again, and when every attempt fails
 * with lockTools off the note comes back uncompacted so the work goes on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcClient, eventsOfType, messageText, type RpcEvent } from "../harness/rpc-client.ts";
import { DEFAULT_FAKE_ENV, latestSessionFile, makeTestDir, scriptedArgs } from "../harness/env.ts";

const PERCENT_FLAGS = ["--compact-soft-at", "20%", "--compact-at", "50%", "--compact-buffer", "10%"];

function notifies(events: RpcEvent[], pattern: RegExp): RpcEvent[] {
	return eventsOfType(events, "extension_ui_request").filter((e) => e.method === "notify" && pattern.test(String(e.message ?? "")));
}

/** The handoff as the run commits it: an appended entry, not a message pushed into a new run. */
const isHandoffEntry = (e: RpcEvent): boolean =>
	e.type === "entry_appended" && (e.entry as { customType?: string } | undefined)?.customType === "self-compact-handoff";

/** A handoff pushed with pi.sendMessage(..., { triggerTurn: true }), which starts a second run. */
function handoffMessages(events: RpcEvent[]): RpcEvent[] {
	return eventsOfType(events, "message_end").filter((e) => (e.message as { customType?: string })?.customType === "self-compact-handoff");
}

function traceNotes(traceFile: string): string[] {
	return readFileSync(traceFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { kind: string; plan?: { toolCall?: { name: string; arguments?: { note_to_self?: string } } } })
		.filter((r) => r.kind === "turn" && r.plan?.toolCall?.name === "self_compact")
		.map((r) => r.plan!.toolCall!.arguments!.note_to_self!);
}

test("compaction that keeps failing falls back to Pi's summary, then returns the note uncompacted and the work goes on", async () => {
	// lockTools off asks for availability over the cutoff: every attempt fails, so the note comes back uncompacted.
	const t = makeTestDir("failure-give-up", { selfCompact: { lockTools: false } });
	const client = new RpcClient({
		args: scriptedArgs(t, PERCENT_FLAGS),
		cwd: t.dir,
		// The script obeys the warning itself: with lockTools off nothing is blocked, so only a cooperative model
		// reaches the give-up path.
		env: { ...DEFAULT_FAKE_ENV, SC_FAKE_SCENARIO: "obey-warning", SC_FAKE_TRACE: t.traceFile, SC_FAKE_SUMMARY_FAIL: "99" },
		logFile: t.logFile,
	});
	try {
		await client.request({ type: "prompt", message: "Start the scripted work." });
		const handoff = await client.waitFor(isHandoffEntry, 90_000);
		await client.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "write" && e.isError === false, 30_000, { since: client.events.indexOf(handoff) });
		const events = client.events;
		assert.ok(notifies(events, /Summary generation failed after 2 attempts: .*fake summary failure/).length >= 2, "our summary was tried twice");
		assert.equal(notifies(events, /uses Pi's built-in summary/).length, 1, "the last attempt used Pi's summary");
		assert.equal(notifies(events, /Returning the note without compacting and restoring tools/).length, 1);
		assert.equal(eventsOfType(events, "compaction_end").filter((e) => e.aborted === false && !e.errorMessage).length, 0, "nothing was compacted");
		assert.equal(handoffMessages(events).length, 0, "the note came back inside the run, not as a new one");
		assert.equal(messageText(handoff.entry), traceNotes(t.traceFile).pop(), "the note came back verbatim");
		assert.equal(readFileSync(join(t.dir, "result.txt"), "utf8").trim(), "done", "the work resumed from the note");
	} finally {
		await client.close();
	}
});

test("a summary that fails once is retried inside the run: nothing settles before the note is back", async () => {
	const t = makeTestDir("failure-in-run-retry");
	const client = new RpcClient({
		args: scriptedArgs(t, PERCENT_FLAGS),
		cwd: t.dir,
		// Two failing summary calls: the first attempt (two tries with our prompt) fails, the retry succeeds.
		env: { ...DEFAULT_FAKE_ENV, SC_FAKE_SCENARIO: "ignore-until-forced", SC_FAKE_TRACE: t.traceFile, SC_FAKE_SUMMARY_FAIL: "2" },
		logFile: t.logFile,
	});
	try {
		await client.request({ type: "prompt", message: "Start the scripted work." });
		const handoff = await client.waitFor(isHandoffEntry, 120_000);
		const handoffIndex = client.events.indexOf(handoff);
		assert.equal(
			eventsOfType(client.events.slice(0, handoffIndex), "agent_settled").length,
			0,
			"the run must not settle while the note waits: the retry belongs to agent_before_settle",
		);
		await client.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "write" && e.isError === false, 60_000, { since: handoffIndex });
		await client.waitFor((e) => e.type === "agent_settled", 60_000, { since: handoffIndex });
		const events = client.events;
		assert.equal(notifies(events, /^self-compact: Summary generation failed after 2 attempts: .*fake summary failure/).length, 1, "the first attempt failed");
		assert.equal(notifies(events, /uses Pi's built-in summary/).length, 0, "the retry still used our prompt");
		assert.equal(handoffMessages(events).length, 0, "the note was never pushed into a second run with sendMessage");
		assert.equal(eventsOfType(events, "agent_settled").length, 1, "one run: compaction, note and continuation all happened inside it");
		assert.equal(eventsOfType(events, "compaction_start").length, 0, "the retry did not go through ctx.compact()");
		const compactions = eventsOfType(events, "entry_appended").filter((e) => (e.entry as { type?: string }).type === "compaction");
		assert.equal(compactions.length, 1, "exactly one compaction entry, committed by the hook");
		assert.equal(messageText(handoff.entry), traceNotes(t.traceFile).pop(), "the note came back verbatim");
		assert.equal(readFileSync(join(t.dir, "result.txt"), "utf8").trim(), "done", "the work resumed from the note");
	} finally {
		await client.close();
	}
});

test("with lockTools on, a summarizer that fails every way stops the run inside the hook with the note saved", async () => {
	const t = makeTestDir("failure-lock-stop");
	const client = new RpcClient({
		args: scriptedArgs(t, PERCENT_FLAGS),
		cwd: t.dir,
		env: { ...DEFAULT_FAKE_ENV, SC_FAKE_SCENARIO: "ignore-until-forced", SC_FAKE_TRACE: t.traceFile, SC_FAKE_SUMMARY_FAIL: "99" },
		logFile: t.logFile,
	});
	try {
		await client.request({ type: "prompt", message: "Start the scripted work." });
		const stopped = await client.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /Tools stay locked \(selfCompact\.lockTools\)/.test(String(e.message)), 120_000);
		const stoppedIndex = client.events.indexOf(stopped);
		assert.equal(eventsOfType(client.events.slice(0, stoppedIndex), "agent_settled").length, 0, "every attempt and the give-up happened before the run settled");
		await client.waitFor((e) => e.type === "agent_settled", 60_000, { since: stoppedIndex });
		const events = client.events;
		assert.equal(notifies(events, /^self-compact: Summary generation failed after 2 attempts: .*fake summary failure/).length, 2, "two attempts with our prompt");
		assert.equal(notifies(events, /uses Pi's built-in summary/).length, 1, "and one with Pi's built-in summary");
		assert.equal(handoffMessages(events).length, 0, "the note is kept, not returned");
		assert.equal(client.events.filter(isHandoffEntry).length, 0);
		assert.equal(eventsOfType(events, "compaction_start").length, 0, "nothing was retried through ctx.compact()");
		const entries = await client.request({ type: "get_entries" });
		const states = ((entries.data as { entries?: Array<{ type: string; customType?: string; data?: { locked?: boolean; handoff?: { status?: string; attempts?: number } } }> })?.entries ?? [])
			.filter((e) => e.type === "custom" && e.customType === "self-compact-state");
		const last = states[states.length - 1]!;
		assert.equal(last.data?.handoff?.status, "failed");
		assert.equal(last.data?.handoff?.attempts, 3, "all three attempts were spent inside the hook");
		assert.equal(last.data?.locked, true, "the tools stay locked with the note saved");
	} finally {
		await client.close();
	}
});

test("failed compaction keeps the note and the lock; /self-compact-now reuses the saved note; reload recovery finishes the handoff", async () => {
	const t = makeTestDir("failure-recovery");
	const env = { ...DEFAULT_FAKE_ENV, SC_FAKE_SCENARIO: "ignore-until-forced", SC_FAKE_TRACE: t.traceFile };

	// ---- Run 1: the summarizer always fails; the session is closed while the automatic retries are still going.
	const first = new RpcClient({ args: scriptedArgs(t, PERCENT_FLAGS), cwd: t.dir, env: { ...env, SC_FAKE_SUMMARY_FAIL: "99" }, logFile: t.logFile });
	let sessionFile: string | undefined;
	try {
		await first.request({ type: "prompt", message: "Start the scripted work." });
		await first.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "self_compact" && e.isError === false, 90_000);
		// Every automatic attempt runs inside the turn that saved the note; the first failure announces the retry,
		// and the lock holds the line once they are all spent.
		await first.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /retrying automatically/.test(String(e.message)), 60_000);
		await first.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /Tools stay locked \(selfCompact\.lockTools\)/.test(String(e.message)), 60_000);
		assert.ok(notifies(first.events, /^self-compact: Summary generation failed after 2 attempts: .*fake summary failure/).length >= 2, "real error recorded");

		// Note retained in the session ledger (latest state snapshot), tools locked.
		const entries = await first.request({ type: "get_entries" });
		const list = ((entries.data as { entries?: Array<{ type: string; customType?: string; data?: { locked?: boolean; handoff?: { status?: string; note?: string; attempts?: number; error?: string } } }> })?.entries ?? []).filter(
			(e) => e.type === "custom" && e.customType === "self-compact-state",
		);
		const lastEntry = list[list.length - 1]!;
		assert.equal(lastEntry.data?.handoff?.status, "failed");
		assert.equal(lastEntry.data?.locked, true);
		assert.ok((lastEntry.data?.handoff?.note ?? "").length > 10, "note retained");
		assert.match(lastEntry.data?.handoff?.error ?? "", /fake summary failure/);
		const savedNote = lastEntry.data!.handoff!.note!;

		// /self-compact-now includes the saved note verbatim and the agent passes it back unchanged.
		const mark2 = first.mark();
		const nowResponse = await first.request({ type: "prompt", message: "/self-compact-now" });
		assert.equal(nowResponse.success, true);
		const userMessage = await first.waitFor((e) => e.type === "message_end" && (e.message as { role?: string }).role === "user", 30_000, { since: mark2 });
		const userText = messageText(userMessage.message);
		assert.match(userText, /A note is already saved from a previous attempt/);
		assert.ok(userText.includes(savedNote), "saved note included verbatim in the /self-compact-now request");
		const retryCall = await first.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "self_compact", 60_000, { since: mark2 });
		assert.equal(retryCall.isError, false);
		const notes = traceNotes(t.traceFile);
		assert.equal(notes[notes.length - 1], savedNote, "agent reused the saved note instead of inventing one");
		assert.equal(eventsOfType(first.events, "message_end").filter((e) => (e.message as { customType?: string })?.customType === "self-compact-handoff").length, 0, "no handoff delivered while compaction keeps failing");
		sessionFile = latestSessionFile(t);
		assert.ok(sessionFile, "session file persisted");
	} finally {
		await first.close();
	}

	// ---- Run 2: same session file, summarizer works again -> recovery completes the handoff.
	const second = new RpcClient({
		args: scriptedArgs(t, PERCENT_FLAGS, { session: sessionFile }),
		cwd: t.dir,
		env: { ...env, SC_FAKE_SUMMARY_FAIL: "0" },
		logFile: t.logFile,
	});
	try {
		const restored = await second.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /restored a saved note/.test(String(e.message)), 30_000);
		assert.match(String(restored.message), /Tools stay locked until compaction succeeds/);
		const compactionEnd = await second.waitFor((e) => e.type === "compaction_end", 60_000);
		assert.equal(compactionEnd.aborted, false);
		assert.match(((compactionEnd.result as { summary?: string })?.summary) ?? "", /FAKE-SUMMARY\[/);
		const handoff = await second.waitFor((e) => e.type === "message_end" && (e.message as { customType?: string })?.customType === "self-compact-handoff", 60_000);
		const savedNote = traceNotes(t.traceFile).pop()!;
		assert.ok(messageText(handoff.message).includes(savedNote), "recovered note returned verbatim after restart");
		await second.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "write" && e.isError === false, 60_000);
		assert.equal(readFileSync(join(t.dir, "result.txt"), "utf8").trim(), "done");
		await second.waitFor((e) => e.type === "agent_settled", 60_000, { since: second.events.indexOf(handoff) });
		const entries = await second.request({ type: "get_entries" });
		const statuses = ((entries.data as { entries?: Array<{ type: string; customType?: string; data?: { handoff?: { status?: string } } }> })?.entries ?? [])
			.filter((e) => e.type === "custom" && e.customType === "self-compact-state")
			.map((e) => e.data?.handoff?.status);
		assert.equal(statuses[statuses.length - 1], "done");
	} finally {
		await second.close();
	}

	// ---- Run 3: an answered handoff never restarts after another reload.
	const third = new RpcClient({ args: scriptedArgs(t, PERCENT_FLAGS, { session: sessionFile }), cwd: t.dir, env: { ...env, SC_FAKE_SUMMARY_FAIL: "0" }, logFile: t.logFile });
	try {
		await third.request({ type: "get_state" });
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		assert.equal(eventsOfType(third.events, "agent_start").length, 0, "no run started on reload after a completed handoff");
		assert.equal(eventsOfType(third.events, "compaction_start").length, 0, "no compaction started on reload after a completed handoff");
		assert.equal(notifies(third.events, /restored a saved note/).length, 0);
		const since = third.mark();
		await third.request({ type: "prompt", message: "/self-compact-info" });
		const info = await third.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /^self-compact info/.test(String(e.message)), 20_000, { since });
		assert.match(String(info.message), /tools unlocked, handoff done/);
		assert.match(String(info.message), /cycles completed: 1/);
	} finally {
		await third.close();
	}

	// ---- Run 4: crash between journaling the handoff and the model's answer -> resume without a user prompt.
	const lines = readFileSync(sessionFile!, "utf8").trim().split("\n");
	const handoffLine = lines.findIndex((line) => line.includes('"type":"custom_message"') && line.includes('"customType":"self-compact-handoff"'));
	assert.ok(handoffLine > 0, "session contains the journaled handoff");
	// Keep the state snapshot appended right after the journaled message, drop everything the model answered.
	let cut = handoffLine + 1;
	while (cut < lines.length && lines[cut]!.includes('"customType":"self-compact-state"')) cut += 1;
	const truncated = sessionFile!.replace(/\.jsonl$/, "-truncated.jsonl");
	writeFileSync(truncated, `${lines.slice(0, cut).join("\n")}\n`);
	rmSync(join(t.dir, "result.txt"), { force: true });
	const fourth = new RpcClient({ args: scriptedArgs(t, PERCENT_FLAGS, { session: truncated }), cwd: t.dir, env: { ...env, SC_FAKE_SUMMARY_FAIL: "0" }, logFile: t.logFile });
	try {
		const nudge = await fourth.waitFor((e) => e.type === "extension_ui_request" && e.method === "notify" && /never answered before/.test(String(e.message)), 30_000);
		assert.ok(nudge);
		const resumed = await fourth.waitFor((e) => e.type === "message_end" && (e.message as { customType?: string; details?: { resumed?: boolean } })?.customType === "self-compact-handoff" && (e.message as { details?: { resumed?: boolean } }).details?.resumed === true, 30_000);
		assert.ok(resumed, "resume nudge sent as a triggered turn");
		await fourth.waitFor((e) => e.type === "tool_execution_end" && e.toolName === "write" && e.isError === false, 60_000, { since: fourth.events.indexOf(resumed) });
		await fourth.waitFor((e) => e.type === "agent_settled", 60_000, { since: fourth.events.indexOf(resumed) });
		assert.equal(existsSync(join(t.dir, "result.txt")), true, "work resumed from the journaled note without a user prompt");
		assert.equal(readFileSync(join(t.dir, "result.txt"), "utf8").trim(), "done");
		assert.equal(eventsOfType(fourth.events, "compaction_start").length, 0, "no second compaction for an already-delivered note");
	} finally {
		await fourth.close();
	}
});
