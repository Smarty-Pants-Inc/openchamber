import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { reloadHeld, reloadIfNewBuild } from '@/lib/newBuildReload';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { directory, session } from '@/sync/native-draft-fixture';
import { clearChatDraft, consumeChatDraft, getChatDraftIdentityKey, readChatDraft } from '@/lib/chatDraftPersistence';

// smarty-code#713 (openchamber#333 reviews): a new-build reload waits while the mounted composer holds any text, and
// for the whole send (the composer is cleared before its prompt is sent). Through the real ChatInput, not a manual hold.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

const reconnect = async () => {
  let reloaded = 0;
  const result = await reloadIfNewBuild({
    running: () => '/assets/main-OLD.js',
    fetchIndex: async () => '<script type="module" src="/assets/main-NEW.js"></script>',
    busy: () => reloadHeld() || useInputStore.getState().hasReloadBlockingInput(),
    reload: () => { reloaded += 1; },
    jitterMs: () => 30_000,
    sleep: async () => undefined,
  });
  return { result, reloaded };
};

test('the complete production reconnect callback stays byte-pinned to the scheduler admission under test', () => {
  const source = readFileSync(new URL('../../../../../sync/sync-context.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('      onReconnect: ({ replayReset }) => {');
  const end = source.indexOf('      onDisconnect: (reason) => {', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const callback = source.slice(start, end);
  expect(createHash('sha256').update(callback).digest('hex')).toBe('0b1e8d71a4f4a7b9f5a719707713c779e03e86c210a2c03e049d4a7de2d942da');
  expect(callback).toContain('void reloadIfNewBuild({');
  expect(callback).toContain('busy: () => reloadHeld() || useInputStore.getState().hasReloadBlockingInput(),');
  expect(callback).toContain('reload: () => window.location.reload(),');
});

test('text in the mounted composer holds a reload; an empty composer does not', async () => {
  const c = mounted = await mountedNativeComposer(false); // Persistence off: the live text is the only copy.
  await act(async () => useInputStore.setState({ attachedFiles: [] }));
  await c.replace('');
  expect(reloadHeld()).toBe(false);
  await c.replace('unsent words');
  expect(reloadHeld()).toBe(true);
  await c.replace(' ');
  expect(reloadHeld()).toBe(true);
  await c.replace('');
  expect(reloadHeld()).toBe(false);
});

test('a saved draft still holds the automatic reload while its text is in the mounted editor', async () => {
  const c = mounted = await mountedNativeComposer(true);
  await act(async () => useInputStore.getState().clearAttachedFiles());
  await c.replace('durable unsent words');
  await act(() => sleep(550));
  const identity = { runtimeKey: c.runtimeA, directory, sessionId: null };
  expect(readChatDraft(identity).text).toBe('durable unsent words');
  expect(useInputStore.getState().hasReloadBlockingInput()).toBe(false);
  expect(reloadHeld()).toBe(true);
  expect(await reconnect()).toEqual({ result: false, reloaded: 0 });
  await c.replace('');
  expect(await reconnect()).toEqual({ result: true, reloaded: 1 });
});

test('persistence-off text-only A stays held while empty B is mounted, then releases after A is cleared', async () => {
  const c = mounted = await mountedNativeComposer(false);
  await act(async () => useInputStore.getState().clearAttachedFiles());
  await c.replace('A-only unsent text');
  await act(async () => c.target('b', '/native-project-b'));
  expect(c.text()).toBe('');
  expect(await reconnect()).toEqual({ result: false, reloaded: 0 });
  expect(reloadHeld()).toBe(true);

  await act(async () => c.target('a', directory));
  expect(c.text()).toBe('A-only unsent text');
  await c.replace('');
  await act(async () => c.target('b', '/native-project-b'));
  expect(reloadHeld()).toBe(false);
  expect(await reconnect()).toEqual({ result: true, reloaded: 1 });
});

test('text retained off-screen during jitter is rechecked, then clearing the last copy releases reload', async () => {
  const c = mounted = await mountedNativeComposer(false);
  await act(async () => useInputStore.getState().clearAttachedFiles());
  await c.replace('');

  let reloaded = 0;
  const result = await reloadIfNewBuild({
    running: () => '/assets/main-OLD.js',
    fetchIndex: async () => '<script type="module" src="/assets/main-NEW.js"></script>',
    busy: () => reloadHeld() || useInputStore.getState().hasReloadBlockingInput(),
    reload: () => { reloaded += 1; },
    jitterMs: () => 30_000,
    sleep: async () => {
      await c.replace('A-only unsent text');
      await act(async () => c.target('b', '/native-project-b'));
    },
  });
  expect(c.text()).toBe('');
  expect({ result, reloaded }).toEqual({ result: false, reloaded: 0 });
  await act(async () => c.target('a', directory));
  expect(c.text()).toBe('A-only unsent text');
  await c.replace('');
  await act(async () => c.target('b', '/native-project-b'));
  expect(await reconnect()).toEqual({ result: true, reloaded: 1 });
});

test('consuming an exact off-screen copy releases it without clearing newer or unrelated text', async () => {
  const c = mounted = await mountedNativeComposer(false);
  await act(async () => useInputStore.getState().clearAttachedFiles());
  const source = { runtimeKey: c.runtimeA, directory, sessionId: null, draftId: useSessionUIStore.getState().newSessionDraft.draftId };
  await c.replace('A accepted text');
  await act(async () => c.target('b', '/native-project-b'));
  await act(async () => consumeChatDraft(source, 'different text'));
  expect(await reconnect()).toEqual({ result: false, reloaded: 0 });
  await act(async () => consumeChatDraft(source, 'A accepted text', 0));
  expect(await reconnect()).toEqual({ result: false, reloaded: 0 });
  await act(async () => consumeChatDraft(source, 'A accepted text'));
  expect(await reconnect()).toEqual({ result: true, reloaded: 1 });
  await act(async () => c.target('a', directory));
  expect(c.text()).toBe('');
});

test('enabling persistence does not certify an existing off-screen memory copy as durable', async () => {
  const c = mounted = await mountedNativeComposer(false);
  await act(async () => useInputStore.getState().clearAttachedFiles());
  const source = { runtimeKey: c.runtimeA, directory, sessionId: null, draftId: useSessionUIStore.getState().newSessionDraft.draftId };
  await c.replace('A not saved');
  await act(async () => c.target('b', '/native-project-b'));
  await act(async () => useUIStore.setState({ persistChatDraft: true }));
  expect(c.text()).toBe('');
  expect(readChatDraft(source).text).toBe('');
  expect(await reconnect()).toEqual({ result: false, reloaded: 0 });
  await act(async () => consumeChatDraft(source, 'A not saved'));
  expect(await reconnect()).toEqual({ result: true, reloaded: 1 });
});

test('durably saved off-screen text permits reload while persistence-off text does not', async () => {
  const c = mounted = await mountedNativeComposer(true);
  await act(async () => useInputStore.getState().clearAttachedFiles());
  await c.replace('durable A');
  await act(async () => c.target('b', '/native-project-b'));
  expect(c.text()).toBe('');
  expect(readChatDraft({ runtimeKey: c.runtimeA, directory, sessionId: null }).text).toBe('durable A');
  expect(await reconnect()).toEqual({ result: true, reloaded: 1 });
});

test('losing the shared backing envelope invalidates an off-screen durable draft reload exemption', () => {
  // Storage is a module singleton: isolate its initial native backing from the composer fixture's bootstrap.
  const moduleUrl = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const source = `
    import assert from 'node:assert/strict';
    const { nativeComposerDom } = await import(${moduleUrl('./nativeComposer-dom.ts')});
    const dom = nativeComposerDom(), backing = dom.window.localStorage;
    let fail = false;
    Object.defineProperty(dom.window, 'localStorage', { configurable: true, value: {
      getItem: key => backing.getItem(key),
      setItem: (key, value) => { if (fail) throw new DOMException('synthetic quota', 'QuotaExceededError'); backing.setItem(key, value); },
      removeItem: key => backing.removeItem(key), clear: () => backing.clear(), key: index => backing.key(index),
      get length() { return backing.length; }
    } });
    globalThis.fetch = async () => new Response(null, { status: 404 });
    const React = await import('react'), { act } = React;
    const { createRoot } = await import('react-dom/client');
    const { useComposerDraft } = await import(${moduleUrl('../../state/useComposerDraft.ts')});
    const { readChatDraft, isChatDraftEphemeral } = await import(${moduleUrl('../../../../../lib/chatDraftPersistence.ts')});
    const { holdReload, reloadHeld, reloadIfNewBuild } = await import(${moduleUrl('../../../../../lib/newBuildReload.ts')});
    const a = { runtimeKey: 'quota-reload', directory: '/quota/a', sessionId: 'a' }, b = { ...a, directory: '/quota/b', sessionId: 'b' };
    const messageRef = { current: '' }, mentions = { current: new Set() };
    let replace;
    function Owner({ identity }) {
      const [message, setMessage] = React.useState('');
      replace = text => { messageRef.current = text; setMessage(text); };
      const controls = useComposerDraft({ message, messageRef, setMessage: replace, confirmedMentionsRef: mentions,
        identity, persistEnabled: true, initialDraft: { text: '', identity: a } });
      React.useEffect(() => holdReload(() => messageRef.current !== ''), []);
      React.useEffect(() => holdReload(controls.hasReloadBlockingText), [controls.hasReloadBlockingText]);
      return React.createElement('output', null, message);
    }
    const owner = createRoot(dom.container);
    const reconnect = async () => {
      let reloads = 0;
      const result = await reloadIfNewBuild({ running: () => '/assets/old.js', fetchIndex: async () => '<script type="module" src="/assets/new.js"></script>',
        busy: reloadHeld, reload: () => reloads++, jitterMs: () => 1, sleep: async () => undefined });
      return { result, reloads };
    };
    try {
      await act(async () => owner.render(React.createElement(Owner, { identity: a })));
      await act(async () => replace('A surviving text'));
      await act(async () => window.dispatchEvent(new Event('pagehide')));
      assert.match(backing.getItem('openchamber.chatDrafts.v2'), /A surviving text/);
      assert.equal(isChatDraftEphemeral(), false);
      await act(async () => owner.render(React.createElement(Owner, { identity: b })));
      assert.equal(messageRef.current, '');
      assert.deepEqual(await reconnect(), { result: true, reloads: 1 });
      fail = true;
      await act(async () => { replace('B transient'); window.dispatchEvent(new Event('pagehide')); });
      await act(async () => { replace(''); window.dispatchEvent(new Event('pagehide')); });
      assert.equal(backing.getItem('openchamber.chatDrafts.v2'), null);
      assert.equal(readChatDraft(a).text, 'A surviving text');
      assert.equal(isChatDraftEphemeral(), true);
      assert.deepEqual(await reconnect(), { result: false, reloads: 0 });
    } finally {
      fail = false;
      await act(async () => owner.unmount());
      await dom.restore();
    }
  `;
  const result = spawnSync(process.execPath, ['--eval', source], { encoding: 'utf8', timeout: 10_000 });
  expect({ status: result.status, error: result.error, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
});

test('clearing the last retained text owner releases it and does not resurrect on return', async () => {
  const c = mounted = await mountedNativeComposer(false);
  await act(async () => useInputStore.getState().clearAttachedFiles());
  await c.replace('A retained');
  const source = { runtimeKey: c.runtimeA, directory, sessionId: null, draftId: useSessionUIStore.getState().newSessionDraft.draftId };
  await act(async () => c.target('b', '/native-project-b'));
  await c.replace('B retained');
  const other = { ...source, directory: '/native-project-b' };
  await act(async () => c.target('a', directory));
  await c.replace('');
  await act(async () => clearChatDraft(source, true));
  expect(await reconnect()).toEqual({ result: false, reloaded: 0 });
  await act(async () => clearChatDraft(other, true));
  expect(await reconnect()).toEqual({ result: true, reloaded: 1 });
  await act(async () => c.target('b', '/native-project-b'));
  expect(c.text()).toBe('');
});

test('the mounted draft switch retains A files while empty B waits for a newer build', async () => {
  const c = mounted = await mountedNativeComposer(false);
  await c.replace('');
  const source = { runtimeKey: c.runtimeA, directory, sessionId: null };
  expect(useInputStore.getState().attachmentDraftKey).toBe(getChatDraftIdentityKey(source));
  await act(async () => {
    useInputStore.getState().clearAttachedFiles();
    useInputStore.getState().addRestoredAttachment({
      url: 'data:text/plain;base64,aGVsbG8=', mimeType: 'text/plain', filename: 'A.txt',
    });
    c.target('b', '/native-project-b');
  });
  expect(c.text()).toBe('');
  expect(useInputStore.getState().attachedFiles).toEqual([]);
  expect(reloadHeld()).toBe(false);
  expect(await reconnect()).toEqual({ result: false, reloaded: 0 });
  await act(async () => useInputStore.getState().clearAttachedFiles(source));
  expect(await reconnect()).toEqual({ result: true, reloaded: 1 });
});

test('pending replay holds reload until the mounted destination restores and clears its files', async () => {
  const c = mounted = await mountedNativeComposer(false);
  await c.replace('');
  const target = { runtimeKey: c.runtimeA, directory: '/native-project-b', sessionId: null };
  await act(async () => {
    useInputStore.getState().clearAttachedFiles();
    useInputStore.setState({ pendingComposerRestore: {
      target, text: '', files: [{ url: 'data:text/plain;base64,aGVsbG8=', mimeType: 'text/plain', filename: 'replay.txt' }],
    } });
  });
  expect(useInputStore.getState().attachedFiles).toEqual([]);
  expect(reloadHeld()).toBe(false);
  expect(await reconnect()).toEqual({ result: false, reloaded: 0 });
  await act(async () => c.target('b', target.directory));
  expect(useInputStore.getState().pendingComposerRestore).toBeNull();
  expect(useInputStore.getState().attachedFiles.map(file => file.filename)).toEqual(['replay.txt']);
  expect(await reconnect()).toEqual({ result: false, reloaded: 0 });
  await act(async () => useInputStore.getState().clearAttachedFiles(target));
  expect(await reconnect()).toEqual({ result: true, reloaded: 1 });
});

test('a send holds a reload until its request settles, after the composer is cleared', async () => {
  const c = mounted = await mountedNativeComposer(true);
  await c.replace('start'); await c.submit(); await act(() => sleep(0)); // The session exists; the next send is ordinary.
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(reloadHeld()).toBe(false);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  c.handlers.prompt = async () => { await held; return new Response(null, { status: 204 }); };
  await c.replace('send me');
  await c.submit(); await act(() => sleep(0));
  expect(c.prompts().length).toBe(2);
  expect(c.text()).toBe('');
  expect(reloadHeld()).toBe(true);
  await act(async () => { release(); await sleep(0); await sleep(0); });
  expect(reloadHeld()).toBe(false);
});
