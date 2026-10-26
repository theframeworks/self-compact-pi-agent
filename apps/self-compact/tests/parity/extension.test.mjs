import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const globalModules = process.env.PI_DIR
  ? resolve(process.env.PI_DIR, '..', '..')
  : execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
// The extension reads selfCompact settings from the agent dir as well as the project, and
// Pi reads compaction settings from both. Point the agent dir at an empty temp path so the
// assertions describe the extension and this branch, not whatever ~/.pi/agent/settings.json
// the machine running the suite happens to have.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'self-compact-agent-'));
const { loadExtensions } = await import(pathToFileURL(join(globalModules, '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')));
const entry = resolve('extensions/self-compact/self-compact.ts');
const piVersion = JSON.parse(readFileSync(join(globalModules, '@earendil-works/pi-coding-agent/package.json'), 'utf8')).version;
// Pi 1.4 stopped capping summaries at a share of reserveTokens (#9512) and asks for the model's output limit.
const reserveCapsSummary = Number(piVersion.split('.')[0]) === 1 && Number(piVersion.split('.')[1]) < 4;

function seedEntries(chars = 2000) {
  // A minimal real-shaped branch: one finished turn plus the current user prompt, so Pi's cut-point
  // arithmetic (the same one prepareCompaction uses) finds material to summarize.
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return [
    { type: 'message', id: 'seed-1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'seed prompt '.repeat(chars / 12), timestamp: 1 } },
    { type: 'message', id: 'seed-2', parentId: 'seed-1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'seed answer '.repeat(chars / 12) }], api: 'openai-completions', provider: 'fake', model: 'parity-model', usage, stopReason: 'stop', timestamp: 2 } },
    { type: 'message', id: 'seed-3', parentId: 'seed-2', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'current prompt', timestamp: 3 } },
  ];
}

async function host(t, flags = {}, settings = { compaction: { keepRecentTokens: 100 } }) {
  const cwd = mkdtempSync(join(tmpdir(), 'self-compact-parity-'));
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(settings));
  const loaded = await loadExtensions([entry], cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const entries = seedEntries(), messages = [], notices = [], compactions = [], requests = [];
  let tokens = 0;
  let footer;
  for (const [key, value] of Object.entries({ 'compact-soft-at': '20%', 'compact-at': '50%', 'compact-buffer': '10%', ...flags })) loaded.runtime.flagValues.set(key, value);
  loaded.runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  loaded.runtime.sendMessage = (message, options) => messages.push({ ...message, options });
  const ctx = {
    cwd, mode: 'tui', hasUI: true, thinkingLevel: 'off',
    model: { id: 'parity-model', provider: 'fake', contextWindow: 200000, maxTokens: 8192, api: 'openai-completions', reasoning: true },
    sessionManager: { getBranch: () => entries },
    getContextUsage: () => ({ tokens, contextWindow: ctx.model.contextWindow, percent: tokens / ctx.model.contextWindow * 100 }),
    isIdle: () => true,
    compact: options => compactions.push(options),
    ui: { notify: (message, type) => notices.push({ message, type }), setFooter: factory => { footer = factory; }, setStatus() {} },
    modelRegistry: { complete: async (_model, request, options) => {
      requests.push({ request, options });
      return { role: 'assistant', api: 'openai-completions', provider: 'fake', model: 'parity-model', timestamp: 1, stopReason: 'stop', content: [{ type: 'text', text: 'Verified summary.' }], usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    } },
  };
  // The projection Pi hands a boundary hook: the entries, each with the messages the model would see.
  const projection = () => entries.map(entry => ({
    sourceEntry: entry,
    messages: entry.type === 'message' ? [entry.message]
      : entry.type === 'custom_message' ? [{ role: 'custom', ...entry }]
        : [],
  }));
  const emit = async (name, event = {}) => {
    // Boundary hooks are handed Pi's proposed state, projection included; a test may override it.
    const payload = name === 'agent_before_settle' || name === 'turn_end'
      ? { entries: [], continue: false, outcome: 'completed', context: { contextEntries: projection(), contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false }, ...event }
      : event;
    let result;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(payload, ctx);
    return result;
  };
  t.after(async () => { await emit('session_shutdown'); rmSync(cwd, { recursive: true, force: true }); });
  await emit('session_start', { reason: 'start' });
  return {
    ctx, entries, messages, notices, compactions, requests, emit,
    usage: value => { tokens = value; },
    prompt: (kind, text) => {
      const dir = join(cwd, '.pi/self-compact');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `USER_PROMPT_${kind}.md`), text);
    },
    execute: (note = 'NEXT ACTION: continue', signal) => extension.tools.get('self_compact').definition.execute('call', { note_to_self: note }, signal, undefined, ctx),
    view: () => extension.tools.get('view_context').definition.execute('view', {}, undefined, undefined, ctx),
    info: () => extension.commands.get('self-compact-info').handler('', ctx),
    footer: () => footer({ requestRender() {} }, { fg: (_color, text) => text, bold: text => text }).render(100)[0],
  };
}

function summaryEvent(overrides = {}) {
  return {
    reason: 'manual', signal: new AbortController().signal,
    preparation: {
      messagesToSummarize: [{ role: 'user', content: 'Implement parser. Tests remain pending.', timestamp: 1 }],
      turnPrefixMessages: [], isSplitTurn: false, firstKeptEntryId: 'keep', tokensBefore: 80000,
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1500 },
      fileOps: { read: new Set(['README.md']), written: new Set(['parser.ts']), edited: new Set() },
      ...overrides,
    },
  };
}

test('P1: automatic compaction without a note goes ahead with our summary', async t => {
  const h = await host(t);
  for (const reason of ['threshold', 'overflow']) {
    const result = await h.emit('session_before_compact', { ...summaryEvent(), reason });
    assert.equal(result.compaction.summary.includes('Verified summary.'), true, reason);
    assert.equal(result.compaction.details.selfCompact.reason, reason);
  }
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined, 'no lock: the context is being compacted');
});

test('P1: automatic compaction falls back to Pi\'s own summary when ours cannot be written', async t => {
  const h = await host(t);
  h.prompt('COMPACTION_MESSAGE', '  ');
  assert.equal(await h.emit('session_before_compact', { ...summaryEvent(), reason: 'threshold' }), undefined);
});

test('P1: automatic compaction cannot bypass the note, including before settlement', async t => {
  const h = await host(t);
  await h.execute();
  assert.deepEqual(await h.emit('session_before_compact', { reason: 'threshold' }), { cancel: true });
  await h.emit('session_compact_failed', { reason: 'threshold', aborted: true });
  assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data.handoff.status, 'pending');
  await h.emit('agent_settled');
  assert.equal(h.compactions.length, 1);
  const result = await h.emit('session_before_compact', summaryEvent());
  assert.ok(result.compaction);
  assert.equal(h.requests[0].options.reasoningEffort, 'low');
});

test('P1: compaction that keeps failing falls back to Pi\'s summary, then returns the note uncompacted', async t => {
  // lockTools off is the operator saying the run matters more than the cutoff.
  const h = await host(t, {}, { compaction: { keepRecentTokens: 100 }, selfCompact: { lockTools: false } });
  h.usage(120000);
  await h.emit('turn_end');
  await h.execute();
  h.prompt('COMPACTION_MESSAGE', '  ');
  const state = () => h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data;
  // Attempts 1 and 2: our summary fails and the compaction is cancelled.
  for (const attempt of [1, 2]) {
    await h.emit('agent_settled');
    assert.deepEqual(await h.emit('session_before_compact', summaryEvent()), { cancel: true }, `attempt ${attempt}`);
    await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
    assert.equal(state().handoff.attempts, attempt);
    assert.equal(state().locked, true);
  }
  // Attempt 3: Pi writes its built-in summary instead.
  await h.emit('agent_settled');
  assert.equal(await h.emit('session_before_compact', summaryEvent()), undefined);
  assert.ok(h.notices.some(n => /uses Pi's built-in summary/.test(n.message)));
  // Pi's summary fails too: the note comes back uncompacted and the tools are unlocked.
  await h.emit('session_compact_failed', { reason: 'manual', aborted: false, errorMessage: 'provider down' });
  assert.equal(state().locked, false);
  assert.equal(state().handoff.status, 'ready');
  const handoff = h.messages.filter(m => m.customType === 'self-compact-handoff');
  assert.equal(handoff.length, 1);
  assert.equal(handoff[0].content, 'NEXT ACTION: continue');
  // The lock and guidance stand down at the hard cutoff until a compaction succeeds.
  await h.emit('message_end', { message: { role: 'custom', customType: 'self-compact-handoff', details: handoff[0].details } });
  await h.emit('turn_end');
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined);
  assert.equal((await h.emit('context', { messages: [] })).messages.length, 0);
  await h.emit('session_compact', { reason: 'threshold' });
  await h.emit('turn_end');
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined, 'lockTools off: the cutoff no longer blocks after a give-up');
});

test('P1: with lockTools on, a summarizer that fails every way stops the session instead of sliding past the cutoff', async t => {
  // The shipped default: the lock is the contract, so a session that cannot compact does not keep working.
  const h = await host(t);
  h.usage(120000);
  await h.emit('turn_end');
  await h.execute();
  h.prompt('COMPACTION_MESSAGE', '  ');
  const state = () => h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data;
  for (const attempt of [1, 2]) {
    await h.emit('agent_settled');
    assert.deepEqual(await h.emit('session_before_compact', summaryEvent()), { cancel: true }, `attempt ${attempt}`);
    await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
    assert.equal(state().handoff.attempts, attempt);
  }
  await h.emit('agent_settled');
  assert.equal(await h.emit('session_before_compact', summaryEvent()), undefined, 'the last attempt is Pi\'s summary');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: false, errorMessage: 'provider down' });
  assert.equal(state().locked, true, 'the tools stay locked');
  assert.equal(state().handoff.status, 'failed', 'the note is kept for a retry');
  assert.ok(h.notices.some(n => /Tools stay locked \(selfCompact\.lockTools\)/.test(n.message)), 'and it says why');
  assert.equal(h.messages.filter(m => m.customType === 'self-compact-handoff').length, 0, 'the note is not returned');
  assert.equal((await h.emit('tool_call', { toolName: 'read' })).block, true, 'no work continues past the cutoff');
  assert.equal(await h.emit('tool_call', { toolName: 'self_compact' }), undefined, 'retrying the handoff always is');
  // A compaction that finally succeeds through another path releases the lock and returns the note.
  await h.emit('session_compact', { reason: 'threshold' });
  assert.equal(state().locked, false);
  assert.equal(state().handoff.status, 'ready');
  const returned = h.messages.filter(m => m.customType === 'self-compact-handoff');
  assert.equal(returned.length, 1);
  // The model reads the note, and past the cutoff again the lock is the contract once more.
  await h.emit('message_end', { message: { role: 'custom', customType: 'self-compact-handoff', details: returned[0].details } });
  await h.emit('turn_end');
  assert.equal((await h.emit('tool_call', { toolName: 'read' })).block, true, 'the lock re-arms once a compaction succeeded');
});

test('P1: the in-run handoff commits the compaction and the note, and re-arms after a give-up', async t => {
  const h = await host(t);
  h.usage(120000);
  await h.emit('turn_end');
  await h.execute();
  const settle = () => h.emit('agent_before_settle', { entries: [], continue: false, outcome: 'completed' });
  const state = () => h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data;
  const result = await settle();
  assert.equal(result.continue, true);
  assert.deepEqual(result.entries.map(e => e.type), ['compaction', 'custom_message']);
  assert.equal(result.entries[1].content, 'NEXT ACTION: continue');
  assert.equal(state().handoff.status, 'ready');
  assert.equal(state().locked, false);
  assert.equal(await settle(), undefined, 'a delivered note is not compacted again');
});

test('P1: the in-run handoff builds on the newest compaction, not an older one kept in its tail', async t => {
  const h = await host(t);
  h.usage(120000);
  await h.emit('turn_end');
  await h.execute();
  const [first, answer] = seedEntries();
  const [next, nextAnswer, current] = seedEntries().map(entry => ({ ...entry, id: `next-${entry.id}` }));
  const compaction = (id, summary, firstKeptEntryId) => ({ type: 'compaction', id, parentId: null, timestamp: '2026-01-01T00:00:00.000Z', summary, firstKeptEntryId, tokensBefore: 1000 });
  // Pi's projection: the newest compaction first, then its kept entries, where an older compaction whose id lies
  // inside the kept range is retained but projected as nothing.
  const contextEntries = [
    { sourceEntry: compaction('c-new', 'NEWEST-SUMMARY', first.id), messages: [{ role: 'compactionSummary', summary: 'NEWEST-SUMMARY', tokensBefore: 1000, timestamp: 1 }] },
    { sourceEntry: first, messages: [first.message] },
    { sourceEntry: compaction('c-old', 'OLDER-SUMMARY', first.id), messages: [] },
    { sourceEntry: answer, messages: [answer.message] },
    { sourceEntry: next, messages: [next.message] },
    { sourceEntry: nextAnswer, messages: [nextAnswer.message] },
    { sourceEntry: current, messages: [current.message] },
  ];
  const result = await h.emit('agent_before_settle', { entries: [], continue: false, outcome: 'completed', context: { contextEntries, contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false } });
  assert.deepEqual(result.entries.map(e => e.type), ['compaction', 'custom_message']);
  const sent = JSON.stringify(h.requests.map(({ request }) => request));
  assert.match(sent, /NEWEST-SUMMARY/, 'the newest summary is the one built on');
  assert.doesNotMatch(sent, /OLDER-SUMMARY/, 'the replaced summary is not brought back');
  assert.match(sent, /seed prompt/, 'and the kept history after it is summarized');
});

test('P1: a projection carrying a context edit is left to Pi\'s own preparation', async t => {
  const h = await host(t);
  h.usage(120000);
  await h.emit('turn_end');
  await h.execute();
  const state = () => h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data;
  const edited = {
    entries: [], continue: false, outcome: 'completed',
    context: {
      // Pi cuts a context-edited projection, which findCutPoint() over the raw branch cannot see, so the
      // in-run path stands down rather than commit a compaction whose kept tail disagrees with the summary.
      contextEntries: [
        { sourceEntry: { type: 'message', id: 'seed-1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'keep working', timestamp: 1 } }, messages: [{ role: 'user', content: 'keep working', timestamp: 1 }] },
        { sourceEntry: { type: 'context_edit', id: 'edit-1', parentId: 'seed-1', timestamp: '2026-01-01T00:00:01.000Z', targetId: 'seed-1', replacement: null }, messages: [] },
      ],
      contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false,
    },
  };
  assert.equal(await h.emit('agent_before_settle', edited), undefined);
  assert.equal(state().handoff.status, 'pending', 'the note is kept for the idle path');
  assert.equal(h.compactions.length, 0, 'and no compaction was committed in the run');
});

test('P1: a failed in-run handoff is retried once idle, and leaves the last attempt to that path', async t => {
  const h = await host(t);
  h.usage(120000);
  await h.emit('turn_end');
  await h.execute();
  h.prompt('COMPACTION_MESSAGE', '  ');
  const settle = () => h.emit('agent_before_settle', { entries: [], continue: false, outcome: 'completed' });
  const state = () => h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data;
  assert.equal(await settle(), undefined);
  assert.equal(state().handoff.status, 'failed');
  await h.emit('agent_settled');
  assert.equal(h.compactions.length, 1, 'the idle retry started');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
  assert.equal(state().handoff.attempts, 2);
  assert.equal(await settle(), undefined, 'the in-run path skips the last attempt');
  assert.equal(state().handoff.attempts, 2, 'and does not use it up');
});

test('P1: a successful in-run handoff after a give-up re-arms the guidance', async t => {
  const h = await host(t, {}, { compaction: { keepRecentTokens: 100 }, selfCompact: { lockTools: false } });
  h.usage(120000);
  await h.emit('turn_end');
  await h.execute();
  h.prompt('COMPACTION_MESSAGE', '  ');
  await h.emit('agent_before_settle', { entries: [], continue: false, outcome: 'completed' });
  await h.emit('agent_settled');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: true });
  await h.emit('agent_settled');
  await h.emit('session_before_compact', summaryEvent());
  await h.emit('session_compact_failed', { reason: 'manual', aborted: false, errorMessage: 'provider down' });
  const given = h.messages.filter(m => m.customType === 'self-compact-handoff').at(-1);
  await h.emit('message_end', { message: { role: 'custom', customType: 'self-compact-handoff', details: given.details } });
  await h.emit('turn_end');
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined, 'standing down after the give-up');
  // The summarizer works again, and the agent hands off on its own.
  h.prompt('COMPACTION_MESSAGE', 'Summarize.');
  await h.execute('NEXT ACTION: second');
  const result = await h.emit('agent_before_settle', { entries: [], continue: false, outcome: 'completed' });
  assert.equal(result.continue, true);
  // Pi commits the drafts to the branch, then the model answers the note.
  h.entries.push(...result.entries.map((draft, i) => ({ ...draft, id: `committed-${i}` })));
  await h.emit('message_end', { message: { role: 'assistant', content: [] } });
  // The work goes on until the context is past the hard cutoff again.
  h.entries.push(...seedEntries().map(entry => ({ ...entry, id: `after-${entry.id}` })));
  await h.emit('turn_end');
  assert.ok((await h.emit('context', { messages: [] })).messages.length > 0, 'the guidance re-arms after the in-run success');
});

test('P1: a note that only waits to be read lets Pi\'s automatic compaction through and keeps the tools unlocked', async t => {
  const h = await host(t);
  h.usage(120000);
  await h.emit('turn_end');
  await h.execute();
  await h.emit('agent_before_settle', { entries: [], continue: false, outcome: 'completed' });
  const state = () => h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data;
  assert.equal(state().handoff.status, 'ready');
  const cycle = state().cycle;
  const result = await h.emit('session_before_compact', summaryEvent({ reason: 'threshold' }));
  assert.notEqual(result?.cancel, true);
  assert.equal(state().locked, false);
  await h.emit('session_compact', { reason: 'threshold' });
  assert.equal(state().cycle, cycle, 'a compaction that did not carry the note does not count as a cycle');
});

test('P1: final-answer crossing requests one follow-up, soft advice does not', async t => {
  const h = await host(t);
  h.usage(45000);
  await h.emit('agent_end');
  assert.equal(h.messages.length, 0);
  h.usage(110000);
  await h.emit('agent_end');
  await h.emit('agent_end');
  assert.equal(h.messages.filter(message => message.options?.triggerTurn).length, 1);
  await h.execute();
  await h.emit('agent_end');
  assert.equal(h.messages.length, 1);
});

test('P3: context refreshes one live guidance message and supports harness templates', async t => {
  const h = await host(t);
  h.prompt('SOFT_SELF_COMPACT', '{{context_tokens}} / {{context_window}} ({{context_percent}}%). {{remaining_tokens}} remain, warn {{warning_percent}}%.');
  h.usage(40000);
  const first = await h.emit('context', { messages: [] });
  assert.equal(first.messages.length, 1);
  assert.match(first.messages[0].content, /40,000 \/ 200,000 \(20.0%\).*160,000 remain, warn 50.0%/);
  h.usage(44000);
  const second = await h.emit('context', first);
  assert.equal(second.messages.length, 1);
  assert.match(second.messages[0].content, /44,000.*22.0%/);
  h.prompt('SOFT_SELF_COMPACT', 'UPDATED {{context_tokens}}');
  assert.match((await h.emit('context', second)).messages[0].content, /UPDATED 44,000/);
});

test('P3: tool preflight, turn boundary, and model change enforce newly crossed hard cutoff', async t => {
  for (const boundary of ['tool_call', 'turn_end', 'model_select']) {
    const h = await host(t);
    h.usage(120000);
    await h.emit(boundary, { toolName: 'external_tool' });
    assert.equal((await h.emit('tool_call', { toolName: 'external_tool' })).block, true);
  }
});

test('P2: invalid prompt files report errors without replacing the operator input silently', async t => {
  const h = await host(t);
  h.prompt('SOFT_SELF_COMPACT', '  ');
  h.usage(45000);
  assert.equal((await h.emit('context', { messages: [] })).messages.length, 0);
  await h.emit('context', { messages: [] });
  assert.equal(h.notices.filter(notice => /Prompt file is empty/.test(notice.message)).length, 1);
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined);
  h.prompt('COMPACTION_MESSAGE', '  ');
  assert.deepEqual(await h.emit('session_before_compact', summaryEvent()), { cancel: true });
  assert.equal(h.requests.length, 0);
  await h.info();
  assert.match(h.entries.at(-1).data.lines.join('\n'), /ERROR: Prompt file is empty/);
});

test('P1: aborted self_compact never saves a note', async t => {
  const h = await host(t);
  await assert.rejects(h.execute('NEXT ACTION: continue', AbortSignal.abort()), /cancelled before saving/);
  assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').length, 0);
});

test('P1: Nothing to compact is a failure, never a successful note delivery', async t => {
  const h = await host(t);
  await h.execute();
  await h.emit('agent_settled');
  await h.emit('session_compact_failed', { reason: 'manual', aborted: false, errorMessage: 'Nothing to compact' });
  const state = h.entries.filter(entry => entry.customType === 'self-compact-state').at(-1).data;
  assert.equal(state.locked, true);
  assert.equal(state.handoff.status, 'failed');
  assert.equal(state.cycle, 0);
  assert.equal(h.messages.length, 0);
});

test('Footer keeps context percentage and useful phases without idle ok', async t => {
  const h = await host(t);
  assert.match(h.footer(), /\] 0%\s*$/);
  assert.doesNotMatch(h.footer(), /\bok\b/);
  h.usage(45000);
  await h.emit('turn_end');
  assert.match(h.footer(), /NOTICE/);
});

test('P2: native engine preserves split turns, previous summaries, budgets and file metadata', async t => {
  const h = await host(t, { 'compact-prompt': 'EXACT SYSTEM OVERRIDE' });
  h.prompt('SUMMARY_INSTRUCTIONS', 'USER INSTRUCTIONS: preserve evidence.');
  const event = summaryEvent({ previousSummary: 'Previous checkpoint.', isSplitTurn: true, turnPrefixMessages: [{ role: 'user', content: 'Continue parser tests.', timestamp: 2 }], settings: { reserveTokens: 1000, keepRecentTokens: 100 } });
  event.customInstructions = 'Keep the failing test name.';
  const result = await h.emit('session_before_compact', event);
  assert.ok(result.compaction);
  assert.equal(h.requests.length, 2);
  // Pi's budgets (80% and 50% of reserveTokens) before 1.4; from 1.4 the model's limit, capped at 8192 by us.
  assert.deepEqual(h.requests.map(({ options }) => options.maxTokens), reserveCapsSummary ? [800, 500] : [8192, 8192]);
  for (const { request, options } of h.requests) {
    assert.equal(request.systemPrompt, 'EXACT SYSTEM OVERRIDE');
    assert.equal(options.reasoningEffort, 'low');
    assert.match(request.messages[0].content[0].text, /USER INSTRUCTIONS.*preserve evidence/);
    assert.match(request.messages[0].content[0].text, /Keep the failing test name/);
    assert.doesNotMatch(request.messages[0].content[0].text, /Use this EXACT format/);
  }
  assert.match(h.requests[0].request.messages[0].content[0].text, /<previous-summary>\nPrevious checkpoint/);
  assert.match(h.requests[1].request.messages[0].content[0].text, /Continue parser tests/);
  assert.match(result.compaction.summary, /Turn Context \(split turn\)/);
  assert.deepEqual(result.compaction.details.readFiles, ['README.md']);
  assert.deepEqual(result.compaction.details.modifiedFiles, ['parser.ts']);
  assert.equal(result.compaction.firstKeptEntryId, 'keep');
});

test('P2: configured transport retry applies inside each summary attempt', async t => {
  const h = await host(t);
  mkdirSync(join(h.ctx.cwd, '.pi'), { recursive: true });
  writeFileSync(join(h.ctx.cwd, '.pi/settings.json'), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
  const complete = h.ctx.modelRegistry.complete;
  let calls = 0;
  h.ctx.modelRegistry.complete = async (...args) => {
    const response = await complete(...args);
    if (++calls === 1) return { ...response, stopReason: 'error', errorMessage: '503 Service unavailable' };
    return response;
  };
  const result = await h.emit('session_before_compact', summaryEvent());
  assert.equal(calls, 2);
  assert.equal(result.compaction.details.selfCompact.attempt, 1, 'transport retry succeeds within the first logical summary attempt');
});

test('P2: empty, truncated and tool-calling summaries never become checkpoints', async t => {
  for (const response of [
    { content: [], stopReason: 'stop' },
    { content: [{ type: 'text', text: 'Partial summary' }], stopReason: 'length' },
    { content: [{ type: 'toolCall', id: 'bad', name: 'write', arguments: {} }], stopReason: 'toolUse' },
  ]) {
    const h = await host(t);
    h.ctx.modelRegistry.complete = async () => response;
    assert.deepEqual(await h.emit('session_before_compact', summaryEvent()), { cancel: true });
  }
});

test('P4: view_context returns usage, percent, and thresholds as JSON and stays allowed under the lock', async t => {
  const h = await host(t);
  h.usage(45000);
  const view = JSON.parse((await h.view()).content[0].text);
  assert.equal(view.used_tokens, 45000);
  assert.equal(view.used_percent, 22.5);
  assert.equal(view.context_window, 200000);
  assert.equal(view.level, 'notice');
  assert.deepEqual(view.thresholds, { notice: { tokens: 40000, percent: 20 }, warning: { tokens: 100000, percent: 50 }, hard_cutoff: { tokens: 120000, percent: 60 } });
  assert.equal(view.tokens_until_warning, 55000);
  assert.equal(view.tokens_until_hard_cutoff, 75000);
  assert.equal(view.tools_locked, false);
  assert.equal(view.compaction_cycles, 0);
  h.usage(125000);
  await h.emit('turn_end');
  assert.equal((await h.emit('tool_call', { toolName: 'read' })).block, true);
  assert.equal(await h.emit('tool_call', { toolName: 'view_context' }), undefined);
  const locked = JSON.parse((await h.view()).content[0].text);
  assert.equal(locked.level, 'forced');
  assert.equal(locked.tools_locked, true);
  assert.equal(locked.tokens_until_hard_cutoff, 0);
});

test('P5: nothing to compact -> self_compact refuses, no lock, no guidance', async t => {
  const h = await host(t, {}, { compaction: { keepRecentTokens: 10000000 } });
  h.usage(125000);
  await h.emit('turn_end');
  assert.equal(await h.emit('tool_call', { toolName: 'read' }), undefined, 'forced level does not lock when compaction is impossible');
  assert.equal((await h.emit('context', { messages: [] })).messages.length, 0, 'no guidance when there is nothing to cut');
  await assert.rejects(h.execute('NEXT ACTION: continue'), /Nothing to compact yet: Pi keeps the newest 10,000,000 tokens/);
  assert.equal(h.entries.filter(entry => entry.customType === 'self-compact-state').length, 0, 'no note was saved');
  const view = JSON.parse((await h.view()).content[0].text);
  assert.equal(view.tools_locked, false);
});
