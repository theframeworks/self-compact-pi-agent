import { randomUUID } from "node:crypto";
import {
	compact,
	convertToLlm,
	estimateTokens,
	findCutPoint,
	serializeConversation,
	sessionEntryToContextMessages,
	SettingsManager,
	type CompactionEntry,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import type { LoadedPrompt } from "./prompts.ts";

type Preparation = Parameters<typeof compact>[0];
type CompactionSettings = Preparation["settings"];
type FileOperations = Preparation["fileOps"];

/** The files a message's tool calls read, wrote or edited, as Pi records them in a compaction. */
function addFileOps(message: AgentMessage, fileOps: FileOperations) {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const path = (block.arguments as { path?: unknown } | undefined)?.path;
		if (typeof path !== "string") continue;
		if (block.name === "read") fileOps.read.add(path);
		else if (block.name === "write") fileOps.written.add(path);
		else if (block.name === "edit") fileOps.edited.add(path);
	}
}

/** An entry's model-visible conversation; system messages are prompt state, which the compaction entry carries. */
const conversationOf = (entry: SessionEntry): AgentMessage[] =>
	entry.type === "compaction" ? [] : sessionEntryToContextMessages(entry).filter((message) => message.role !== "system");

/**
 * Mirrors Pi's prepareCompaction(), which Pi doesn't export: what a compaction of this branch would summarize
 * and where the kept history starts. Undefined when Pi would answer "Nothing to compact" (everything fits inside
 * keepRecentTokens, or the last entry is already a compaction). The extension prepares its own compaction for a
 * handoff, which it commits inside the run that saved the note.
 */
export function prepareHandoffCompaction(entries: SessionEntry[], settings: CompactionSettings): Preparation | undefined {
	if (entries.length === 0 || entries[entries.length - 1]!.type === "compaction") return undefined;
	let previous = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.type === "compaction") {
			previous = i;
			break;
		}
	}
	let boundaryStart = 0;
	let previousEntry: CompactionEntry | undefined;
	if (previous >= 0) {
		previousEntry = entries[previous] as CompactionEntry;
		const firstKept = entries.findIndex((entry) => entry.id === previousEntry!.firstKeptEntryId);
		boundaryStart = firstKept >= 0 ? firstKept : previous + 1;
	}
	const cut = findCutPoint(entries, boundaryStart, entries.length, settings.keepRecentTokens);
	const firstKeptEntryId = entries[cut.firstKeptEntryIndex]?.id;
	if (!firstKeptEntryId) return undefined;
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const messagesToSummarize = entries.slice(boundaryStart, historyEnd).flatMap(conversationOf);
	const turnPrefixMessages = cut.isSplitTurn ? entries.slice(cut.turnStartIndex, cut.firstKeptEntryIndex).flatMap(conversationOf) : [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;
	const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
	const previousFiles = previousEntry && !previousEntry.fromHook ? (previousEntry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined) : undefined;
	if (Array.isArray(previousFiles?.readFiles)) for (const f of previousFiles.readFiles) fileOps.read.add(String(f));
	if (Array.isArray(previousFiles?.modifiedFiles)) for (const f of previousFiles.modifiedFiles) fileOps.edited.add(String(f));
	for (const message of [...messagesToSummarize, ...turnPrefixMessages]) addFileOps(message, fileOps);
	const tokensBefore = entries.slice(boundaryStart).flatMap(conversationOf).reduce((sum, message) => sum + estimateTokens(message), 0);
	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cut.isSplitTurn,
		tokensBefore,
		previousSummary: previousEntry?.summary,
		fileOps,
		settings,
	};
}

/** True when a compaction of this branch would have at least one message to summarize. */
export function hasCompactionMaterial(entries: SessionEntry[], keepRecentTokens: number): boolean {
	return prepareHandoffCompaction(entries, { enabled: true, reserveTokens: 0, keepRecentTokens }) !== undefined;
}

/** Pi's compaction settings for this working directory (global settings merged with the project's). */
export function compactionSettings(cwd: string): CompactionSettings {
	return SettingsManager.create(cwd).getCompactionSettings();
}

/** Pi's retained recent history for this working directory (global settings merged with the project's). */
export function keepRecentTokens(cwd: string): number {
	return SettingsManager.create(cwd).getCompactionKeepRecentTokens();
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
			const maxTokens = Math.min(options?.maxTokens ?? 8192, model.maxTokens || 8192, 8192);
			const budgetChars = Math.max(8000, (model.contextWindow - maxTokens - 2000) * 4 - system.text.length - userInstructions.length);
			const { messages, truncated } = replaceInstructions(context, inputs, userInstructions, budgetChars);
			truncatedInput ||= truncated;
			// Pi 1.2 folds its own system prompt into the message list as messages[0] before it
			// calls us, and replaceInstructions leaves non-user messages alone, so Pi's
			// summarization prompt would ride along next to the override we were asked to use.
			// That prompt is the one carrying the "Use this EXACT format" instructions ours
			// exist to replace, so drop it and let systemPrompt below be the only one.
			const requestMessages = messages[0]?.role === "system" ? messages.slice(1) : messages;
			const response = await ctx.modelRegistry.complete(model, { ...context, systemPrompt: system.text, messages: requestMessages }, {
				...options, maxTokens, signal: event.signal, cacheRetention: "none", sessionId: randomUUID(),
				...(model.api === "openai-completions" && model.reasoning ? { reasoningEffort: "low" as const } : {}),
			});
			if (event.signal.aborted || response.stopReason === "aborted") throw new Error("Compaction summary cancelled.");
			if (response.stopReason !== "error" && !response.content.some(block => block.type === "text" && block.text.trim())) throw new Error("Summary response was empty.");
			const stream = createAssistantMessageEventStream();
			stream.end(response);
			return stream;
		},
		undefined, SettingsManager.create(ctx.cwd).getRetrySettings(),
	);
	if (event.signal.aborted) throw new Error("Compaction summary cancelled.");
	return { result, truncatedInput };
}
