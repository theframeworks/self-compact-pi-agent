import { randomUUID } from "node:crypto";
import {
	compact,
	convertToLlm,
	findCutPoint,
	serializeConversation,
	sessionEntryToContextMessages,
	SettingsManager,
	type CompactionEntry,
	type ExtensionContext,
	type ProjectedSessionEntry,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from "@earendil-works/pi-ai";
import type { LoadedPrompt } from "./prompts.ts";

type Preparation = Parameters<typeof compact>[0];
type CompactionSettings = Preparation["settings"];
type FileOperations = Preparation["fileOps"];

/** Tokens the summary input leaves free for the answer (thinking included). The request still asks for the model's
 * full output ceiling; Pi clamps that to the room actually left. */
const SUMMARY_OUTPUT_RESERVE = 16_384;

/** Characters per token when sizing the summary input. 4 is the usual estimate for prose; code and JSON run closer to
 * 3, and overestimating the room would push the input past the window, leaving Pi no room to clamp the output into. */
const CHARS_PER_TOKEN = 3;

/** The summary was cut off by the output cap even with thinking off. Sending the same request again would be cut off
 * the same way, so callers should not retry it. */
export class SummaryCutOffError extends Error {
	constructor() {
		super("Summary generation hit the output token cap even with thinking off, so the summary is incomplete.");
		this.name = "SummaryCutOffError";
	}
}

type StreamSimple = ExtensionContext["modelRegistry"]["streamSimple"];

/**
 * One summary request, as both summaries send it. streamSimple is the path Pi's own summary takes: it maps `reasoning`
 * per provider and clamps maxTokens to the room the input leaves, and it resolves credentials and routing from inside a
 * hook. Caching is pointless for a one-off summary, and the routing id is fresh.
 */
export function requestSummary(ctx: ExtensionContext, model: Parameters<StreamSimple>[0], context: Context, options: Parameters<StreamSimple>[2], signal: AbortSignal): Promise<AssistantMessage> {
	return ctx.modelRegistry.streamSimple(model, context, { ...options, signal, cacheRetention: "none", sessionId: randomUUID() }).result();
}

/** The finished response as the stream compact() expects back, unless the summary was cancelled. */
export function summaryStream(response: AssistantMessage, signal: AbortSignal) {
	if (signal.aborted || response.stopReason === "aborted") throw new Error("Compaction summary cancelled.");
	const stream = createAssistantMessageEventStream();
	stream.end(response);
	return stream;
}

/** The files a message's tool calls read, wrote or edited, as Pi records them in a compaction (calls made from a
 * codemode script are recorded on the script's tool result). */
function addFileOps(message: AgentMessage, fileOps: FileOperations) {
	const calls: Array<{ name: string; arguments?: unknown }> =
		message.role === "toolResult" ? (message.nestedCalls?.calls ?? [])
			: message.role === "assistant" ? message.content.filter((block) => block.type === "toolCall")
				: [];
	for (const call of calls) {
		const path = (call.arguments as { path?: unknown } | undefined)?.path;
		if (typeof path !== "string") continue;
		if (call.name === "read") fileOps.read.add(path);
		else if (call.name === "write") fileOps.written.add(path);
		else if (call.name === "edit") fileOps.edited.add(path);
	}
}

/** An entry's model-visible conversation; system messages are prompt state, which the compaction entry carries. */
const conversationOf = (entry: SessionEntry): AgentMessage[] =>
	entry.type === "compaction" ? [] : sessionEntryToContextMessages(entry).filter((message) => message.role !== "system");

interface CutPlan {
	/** First entry after the previous compaction's kept history (0 without one). */
	boundaryStart: number;
	previous?: CompactionEntry;
	firstKeptEntryIndex: number;
	historyEnd: number;
	/** Start of the split turn, or -1. */
	turnStartIndex: number;
}

/**
 * Where a compaction of these entries would cut, the way Pi's prepareCompaction() finds it. Undefined when the last
 * entry is already a compaction. Pi doesn't export prepareCompaction(), so this uses the exported findCutPoint();
 * Pi walks the session projection, so callers pass projected entries (see prepareHandoffCompaction).
 */
function planCut(entries: SessionEntry[], keepRecentTokens: number): CutPlan | undefined {
	if (entries.length === 0 || entries[entries.length - 1]!.type === "compaction") return undefined;
	let previous: CompactionEntry | undefined;
	let boundaryStart = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type !== "compaction") continue;
		previous = entry;
		const firstKept = entries.findIndex((e) => e.id === entry.firstKeptEntryId);
		boundaryStart = firstKept >= 0 ? firstKept : i + 1;
		break;
	}
	const cut = findCutPoint(entries, boundaryStart, entries.length, keepRecentTokens);
	return {
		boundaryStart,
		previous,
		firstKeptEntryIndex: cut.firstKeptEntryIndex,
		historyEnd: cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex,
		turnStartIndex: cut.isSplitTurn ? cut.turnStartIndex : -1,
	};
}

/**
 * True when a compaction of this branch would have at least one message to summarize, false when Pi would fail
 * with "Nothing to compact" (everything fits inside keepRecentTokens, or the last entry is already a compaction).
 * Runs before every model call, so it stops at the first message.
 */
export function hasCompactionMaterial(entries: SessionEntry[], keepRecentTokens: number): boolean {
	const plan = planCut(entries, keepRecentTokens);
	if (!plan) return false;
	const has = (from: number, to: number) => entries.slice(from, to).some((entry) => conversationOf(entry).length > 0);
	return has(plan.boundaryStart, plan.historyEnd) || (plan.turnStartIndex >= 0 && has(plan.turnStartIndex, plan.firstKeptEntryIndex));
}

/**
 * The compaction a handoff commits inside the run that saved the note, prepared as Pi's prepareCompaction() would.
 * Undefined when there is nothing to compact. tokensBefore is left at 0: compact() only copies it into its result,
 * which the boundary entry doesn't carry, and Pi computes it when it appends the entry.
 *
 * Takes the boundary's projected entries, not the raw branch: after a context edit an entry's model-visible messages
 * are not the ones on disk, so the cut can only be found on the projection. findCutPoint() still reads the source
 * entries, which is why a projection carrying a context edit is left to the idle path (Pi's own prepareCompaction)
 * rather than cutting in the wrong place.
 *
 * The projection starts with the newest compaction and then its kept entries, which can include an older compaction
 * whose summary the newest one already replaced. Pi projects that older entry as nothing, so it is dropped here too;
 * left in, planCut() would take it for the previous compaction and summarize from the wrong boundary.
 */
export function prepareHandoffCompaction(projection: ProjectedSessionEntry[], settings: CompactionSettings): Preparation | undefined {
	if (projection.some((entry) => entry.sourceEntry.type === "context_edit")) return undefined;
	const entries = projection.filter((entry, i) => i === 0 || entry.sourceEntry.type !== "compaction").map((entry) => entry.sourceEntry);
	const plan = planCut(entries, settings.keepRecentTokens);
	const firstKeptEntryId = plan && entries[plan.firstKeptEntryIndex]?.id;
	if (!plan || !firstKeptEntryId) return undefined;
	const messagesToSummarize = entries.slice(plan.boundaryStart, plan.historyEnd).flatMap(conversationOf);
	const turnPrefixMessages = plan.turnStartIndex >= 0 ? entries.slice(plan.turnStartIndex, plan.firstKeptEntryIndex).flatMap(conversationOf) : [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;
	const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	const previousFiles = plan.previous && !plan.previous.fromHook ? (plan.previous.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined) : undefined;
	if (Array.isArray(previousFiles?.readFiles)) for (const f of previousFiles.readFiles) fileOps.read.add(String(f));
	if (Array.isArray(previousFiles?.modifiedFiles)) for (const f of previousFiles.modifiedFiles) fileOps.edited.add(String(f));
	for (const message of [...messagesToSummarize, ...turnPrefixMessages]) addFileOps(message, fileOps);
	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: plan.turnStartIndex >= 0,
		tokensBefore: 0,
		previousSummary: plan.previous?.summary,
		fileOps,
		settings,
	};
}

/** Pi's compaction settings for this working directory and model (per-model overrides included). */
export function compactionSettings(cwd: string, model?: { provider: string; id: string }): CompactionSettings {
	return SettingsManager.create(cwd).getCompactionSettings(model);
}

/** Pi's retained recent history, in tokens: what a compaction never summarizes. */
export function keepRecentTokens(cwd: string, model?: { provider: string; id: string }): number {
	return compactionSettings(cwd, model).keepRecentTokens;
}

function historyInput(messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"], previous?: string): string {
	const conversation = serializeConversation(convertToLlm(messages));
	return `<conversation>\n${conversation}\n</conversation>\n\n${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}`;
}

/**
 * The block Pi wraps the turn prefix of a split turn in.
 *
 * Pi 1.2 changed this one from the `<conversation>` tags the history uses to a
 * `# Conversation` heading, adding its own `# Instructions` after it. Matching
 * only the history shape meant a split turn could never be replaced, and a split
 * turn is exactly when a long user message has to be summarized — so compaction
 * failed whenever it mattered most. The candidate ends at the serialized
 * conversation, leaving Pi's `# Instructions` block in place.
 */
function turnPrefixInput(messages: SessionBeforeCompactEvent["preparation"]["messagesToSummarize"]): string {
	return `# Conversation\n${serializeConversation(convertToLlm(messages))}`;
}

/** What a summary needs: the compaction Pi asked for, or one the extension prepared itself. */
export type SummaryInput = Pick<SessionBeforeCompactEvent, "preparation" | "customInstructions" | "signal">;

function summaryInstructions(event: SummaryInput, prompt: LoadedPrompt): string {
	return [
		"Summarize the supplied historical data. Do not continue the task, simulate tools, or claim actions without tool-result evidence. Keep pending actions pending.",
		prompt.text,
		event.preparation.isSplitTurn ? "This is a split turn. Summarize only the supplied history or turn prefix; the recent suffix remains available." : "",
		event.customInstructions ? `Additional summarization instructions from the operator: ${event.customInstructions}` : "",
	].filter(Boolean).join("\n\n");
}

/** Match complete known inputs, so tag-like text inside history cannot cut the conversation short. */
function replaceInstructions(context: Context, inputs: string[], instructions: string, budgetChars: number) {
	let truncated = false;
	const messages = context.messages.map(message => {
		if (message.role !== "user") return message;
		const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		return {
			...message,
			content: content.map(block => {
				if (block.type !== "text") return block;
				let input = inputs.find(candidate => block.text.startsWith(candidate));
				// Name what was seen: an unmatched block means Pi changed the shape of its
				// summary input, and the preview is what identifies which shape it is now.
				if (input === undefined) {
					throw new Error(`Unrecognized Pi summary input; cannot replace instructions safely. Block starts with: ${JSON.stringify(block.text.slice(0, 120))}`);
				}
				if (input.length > budgetChars) {
					input = `[earlier conversation truncated to fit summary budget]\n${input.slice(-budgetChars)}`;
					truncated = true;
				}
				return { ...block, text: `${input}${instructions}` };
			}),
		};
	});
	return { messages, truncated };
}

/** Pi owns split turns, summary updates, file tracking and configured transport retries. */
export async function generateSummary(event: SummaryInput, ctx: ExtensionContext, system: LoadedPrompt, instructions: LoadedPrompt) {
	if (!ctx.model) throw new Error("No model available for compaction.");
	// Longest first, so the history candidate carrying a previous summary wins over the
	// one without it when both could match the same block. The turn-prefix candidate is
	// separate because Pi wraps that block differently from the history.
	const inputs = [
		historyInput(event.preparation.messagesToSummarize, event.preparation.previousSummary),
		historyInput(event.preparation.turnPrefixMessages),
		turnPrefixInput(event.preparation.turnPrefixMessages),
	].sort((a, b) => b.length - a.length);
	const userInstructions = summaryInstructions(event, instructions);
	let truncatedInput = false;
	const result = await compact(
		event.preparation, ctx.model, undefined, undefined, event.customInstructions, event.signal, ctx.thinkingLevel,
		async (model, context, options) => {
			// Pi's own default is the model's real output ceiling, not a fixed number (#9512).
			// compact() never sets options.maxTokens itself, so an arbitrary floor here was the cap:
			// a model whose real ceiling is far above 8192 (the common case) was held to it
			// regardless, and a split-turn summary of a large session hit stopReason "length" well
			// before it was capable of finishing. streamSimple clamps it to whatever room the input
			// leaves (pi-ai's buildBaseOptions/clampMaxTokensToContext).
			const requestedMaxTokens = options?.maxTokens ?? (model.maxTokens || SUMMARY_OUTPUT_RESERVE);
			// The input budget reserves a fixed share for the answer, not the whole output ceiling:
			// that ceiling is 64k-128k on current models (on some close to the context window), and
			// reserving all of it would cut the session down to a sliver before the summarizer saw it.
			const outputReserve = Math.min(requestedMaxTokens, SUMMARY_OUTPUT_RESERVE);
			const budgetChars = Math.max(8000, (model.contextWindow - outputReserve - 2000) * CHARS_PER_TOKEN - system.text.length - userInstructions.length);
			// Reasoning models on openai-completions summarize at low effort whatever the session's level (a summary
			// is not worth a long thinking pass); every other model follows the session, as Pi's own summary does.
			const reasoning = model.api === "openai-completions" && model.reasoning ? "low" as const : options?.reasoning;
			const attempt = async (allowReasoning: boolean) => {
				const { messages, truncated } = replaceInstructions(context, inputs, userInstructions, budgetChars);
				truncatedInput ||= truncated;
				// Pi 1.2 folds its own system prompt into the message list as messages[0] before it
				// calls us, and replaceInstructions leaves non-user messages alone, so Pi's
				// summarization prompt would ride along next to the override we were asked to use.
				// That prompt is the one carrying the "Use this EXACT format" instructions ours
				// exist to replace, so drop it and let systemPrompt below be the only one.
				const requestMessages = messages[0]?.role === "system" ? messages.slice(1) : messages;
				// streamSimple, not complete(): compact() hands us provider-neutral options (`reasoning`,
				// an unclamped maxTokens), and only the simple path maps them per provider. The raw path
				// ignores `reasoning` and sends maxTokens as is, past the context window if need be.
				// Leaving `reasoning` out is Pi's own "thinking off" for every provider.
				const { reasoning: _reasoning, ...rest } = options ?? {};
				return requestSummary(ctx, model, { ...context, systemPrompt: system.text, messages: requestMessages }, {
					...rest, maxTokens: requestedMaxTokens, ...(allowReasoning && reasoning ? { reasoning } : {}),
				}, event.signal);
			};
			let response = await attempt(true);
			// Thinking shares the same output ceiling as the summary text on most providers (pi-ai's
			// adjustMaxTokensForThinking/clampMaxTokensToContext in api/simple-options.js), so with
			// reasoning on, a long thinking pass can exhaust maxTokens before any summary text comes
			// out, surfacing as stopReason "length" (getSummarizationFailure in Pi's compaction.js:
			// "hit the token cap and the summary is incomplete"). Retrying the identical request is
			// pointless: it is deterministic. Retry once with reasoning off instead, which is a
			// different request and leaves the whole budget to the summary text.
			if (!event.signal.aborted && response.stopReason === "length" && reasoning) {
				response = await attempt(false);
			}
			const stream = summaryStream(response, event.signal);
			if (response.stopReason === "length") throw new SummaryCutOffError();
			if (response.stopReason !== "error" && !response.content.some(block => block.type === "text" && block.text.trim())) throw new Error("Summary response was empty.");
			return stream;
		},
		undefined, SettingsManager.create(ctx.cwd).getRetrySettings(),
	);
	if (event.signal.aborted) throw new Error("Compaction summary cancelled.");
	return { result, truncatedInput };
}
