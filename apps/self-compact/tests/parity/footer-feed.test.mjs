import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Pi's install layout differs per machine: a global install puts the package
// under `npm root -g`, a managed install under ~/.pi. PI_DIR is the same
// override scripts/typecheck.sh understands.
const piDir = process.env.PI_DIR
  ?? join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
// The extension reads selfCompact settings from the agent dir as well as the project.
// Point the agent dir at an empty temp path so a developer's ~/.pi/agent/settings.json
// cannot decide what these assertions see.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'self-compact-agent-'));
const { loadExtensions } = await import(pathToFileURL(join(piDir, 'dist/core/extensions/loader.js')));
const entry = resolve('extensions/self-compact/self-compact.ts');

const FEED_EVENT = 'self-compact:updated';
const STATUS_KEY = 'self-compact';

/**
 * A second extension that records what the first one publishes.
 *
 * `loadExtensions` hands back the runtime, not the `pi` api, so the only way to
 * subscribe to the event bus from a test is to load something that does.
 */
function writeSpy(cwd) {
  const path = join(cwd, 'feed-spy.mjs');
  writeFileSync(path, `export default function spy(pi) {
  const feeds = (globalThis.__selfCompactFeeds ??= []);
  pi.events.on(${JSON.stringify(FEED_EVENT)}, (data) => feeds.push(data));
}`);
  return path;
}

async function host(t, { settings, flags, tokens = 0 } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'self-compact-footer-'));
  mkdirSync(join(cwd, '.pi'), { recursive: true });
  if (settings) writeFileSync(join(cwd, '.pi', 'settings.json'), JSON.stringify(settings));

  const feeds = [];
  globalThis.__selfCompactFeeds = feeds;

  const loaded = await loadExtensions([entry, writeSpy(cwd)], cwd);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const entries = [];
  const statuses = [];
  let footerInstalled = false;
  // Exactly the flags given, so a test can reach the settings route with no flag
  // at all — the case a Pi launched from a package is in, since packages cannot
  // pass flags.
  const flagValues = flags ?? {};
  for (const [key, value] of Object.entries(flagValues)) {
    loaded.runtime.flagValues.set(key, value);
  }
  loaded.runtime.appendEntry = (customType, data) => entries.push({ type: 'custom', customType, data });
  loaded.runtime.sendMessage = () => undefined;

  const ctx = {
    cwd, mode: 'tui', hasUI: true, thinkingLevel: 'off',
    model: { id: 'footer-model', provider: 'fake', contextWindow: 200000, maxTokens: 8192, api: 'openai-completions', reasoning: true },
    sessionManager: { getBranch: () => entries },
    getContextUsage: () => ({ tokens, contextWindow: ctx.model.contextWindow, percent: (tokens / ctx.model.contextWindow) * 100 }),
    isIdle: () => true,
    ui: {
      notify: () => undefined,
      setFooter: (factory) => { footerInstalled = factory !== undefined; },
      setStatus: (key, text) => statuses.push({ key, text }),
    },
  };

  const emit = async (name, event = {}) => {
    let result;
    for (const handler of extension.handlers.get(name) ?? []) result = await handler(event, ctx);
    return result;
  };
  t.after(async () => {
    globalThis.__selfCompactFeeds = undefined;
    await emit('session_shutdown');
    rmSync(cwd, { recursive: true, force: true });
  });
  await emit('session_start', { reason: 'start' });

  return { feeds, statuses, entries, ctx, emit, footer: () => footerInstalled };
}

test('F1: the footer still installs by default, so upstream behaviour is unchanged', async t => {
  const h = await host(t);
  assert.equal(h.footer(), true);
});

test('F2: selfCompact.footer false leaves the footer to another extension', async t => {
  const h = await host(t, { settings: { selfCompact: { footer: false } } });
  assert.equal(h.footer(), false);
  // Pi's built-in footer draws the extension status line, so the readout survives
  // when nothing else claims the footer.
  assert.ok(h.statuses.some(status => status.key === STATUS_KEY && status.text.length > 0));
});

test('F3: the feed carries the thresholds as token counts, not percentages', async t => {
  const h = await host(t, {
    flags: { 'compact-soft-at': '60k', 'compact-at': '120k', 'compact-buffer': '40k' },
    tokens: 130000,
  });
  const feed = h.feeds.at(-1);
  assert.ok(feed, 'the feed is published on session start');
  assert.equal(feed.statusKey, STATUS_KEY);
  assert.equal(feed.contextWindow, 200000);
  assert.equal(feed.tokens, 130000);
  assert.equal(feed.softTokens, 60000);
  assert.equal(feed.warnTokens, 120000);
  // forced = warning + buffer, so a consumer never has to multiply by the window.
  assert.equal(feed.forcedTokens, 160000);
});

test('F3: the feed reports the phase and the level that produced it', async t => {
  const h = await host(t, {
    flags: { 'compact-soft-at': '60k', 'compact-at': '120k', 'compact-buffer': '40k' },
    tokens: 130000,
  });
  const feed = h.feeds.at(-1);
  assert.equal(feed.level, 'warning');
  assert.equal(feed.phase, 'WARNING');
});

test('F4: a rejected threshold reports no cutoff and a REJECTED phase', async t => {
  // 500k does not fit a 200k window, so nothing resolves.
  const h = await host(t, { flags: { 'compact-at': '500k' }, tokens: 130000 });
  const feed = h.feeds.at(-1);
  assert.equal(feed.forcedTokens, null);
  assert.equal(feed.phase, 'REJECTED');
});

test('F5: the feed still publishes with the footer on, so a consumer can always draw it', async t => {
  const h = await host(t, { flags: { 'compact-at': '120k', 'compact-buffer': '40k' }, tokens: 1000 });
  assert.equal(h.footer(), true);
  assert.ok(h.feeds.length > 0);
});

test('F6: settings alone set the thresholds in tokens, with no flags to pass', async t => {
  const h = await host(t, {
    settings: { selfCompact: { footer: false, softTokens: 60000, warnTokens: 120000, bufferTokens: 40000 } },
    tokens: 130000,
  });
  const feed = h.feeds.at(-1);
  assert.equal(feed.softTokens, 60000);
  assert.equal(feed.warnTokens, 120000);
  assert.equal(feed.forcedTokens, 160000);
  // 160k of 200k is the level this session is actually in.
  assert.equal(feed.level, 'warning');
  assert.equal(feed.phase, 'WARNING');
  assert.equal(h.footer(), false);
});

test('F7: a flag overrides the setting for its own key and leaves the others', async t => {
  const h = await host(t, {
    settings: { selfCompact: { softTokens: 60000, warnTokens: 120000, bufferTokens: 40000 } },
    // A zero buffer is the documented "block the moment the warning line is hit".
    flags: { 'compact-buffer': '0' },
    tokens: 130000,
  });
  const feed = h.feeds.at(-1);
  // soft and warn still come from settings; only the buffer was overridden.
  assert.equal(feed.softTokens, 60000);
  assert.equal(feed.warnTokens, 120000);
  assert.equal(feed.forcedTokens, 120000);
});

test('F8: a threshold asked for by a setting is rejected, not clamped, when it cannot fit', async t => {
  // 500k of a 200k window. Only the shipped defaults may be moved silently.
  const h = await host(t, { settings: { selfCompact: { warnTokens: 500000 } }, tokens: 130000 });
  const feed = h.feeds.at(-1);
  assert.equal(feed.forcedTokens, null);
  assert.equal(feed.phase, 'REJECTED');
});

test('F9: a mistyped setting falls back to the default rather than breaking the session', async t => {
  // "60k" is flag syntax; settings take a plain number.
  const h = await host(t, { settings: { selfCompact: { softTokens: '60k', warnTokens: '120k' } }, tokens: 130000 });
  const feed = h.feeds.at(-1);
  assert.ok(feed, 'the extension still resolves and publishes');
  // The shipped defaults on a 200k window: 10%, 20% and a 10% buffer.
  assert.equal(feed.softTokens, 20000);
  assert.equal(feed.warnTokens, 40000);
  assert.equal(feed.forcedTokens, 60000);
});
