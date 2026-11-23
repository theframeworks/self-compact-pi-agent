/**
 * Pi's own compaction summary, produced from inside a hook.
 *
 * The last automatic attempt of a handoff drops the replacement prompt and lets Pi write the summary it would write
 * for `/compact`: when our prompt is what the summarizer keeps choking on, Pi's built-in one is the different thing
 * left to try. Pi normally reaches it through `AgentSession.compact()`, which settles the run first — the one thing
 * the handoff must not do — so this calls the exported `compact()` with no prompt replacement and returns the result
 * as a `compaction` draft entry the boundary hook commits itself.
 *
 * The only thing it supplies is the transport: `ctx.modelRegistry.streamSimple()` resolves credentials and routing the
 * way the rest of the extension does, since a hook has no access to Pi's internal summarization auth. Everything
 * else — the summarization prompts, the split-turn handling, the file lists, the configured retry policy — is Pi's.
 */
import { compact, SettingsManager, type CompactionResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestSummary, summaryStream, type SummaryInput } from "./summary.ts";

export async function generateBuiltinSummary(input: SummaryInput, ctx: ExtensionContext): Promise<CompactionResult> {
	if (!ctx.model) throw new Error("No model available for compaction.");
	const result = await compact(
		input.preparation, ctx.model, undefined, undefined, input.customInstructions, input.signal, ctx.thinkingLevel,
		// Pi built this context from its own prompts: pass it through untouched, which is what makes the summary "built-in".
		async (model, context, options) => summaryStream(await requestSummary(ctx, model, context, options, input.signal), input.signal),
		undefined, SettingsManager.create(ctx.cwd).getRetrySettings(),
	);
	if (input.signal.aborted) throw new Error("Compaction summary cancelled.");
	return result;
}
