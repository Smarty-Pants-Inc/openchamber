import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { reloadHeld, reloadIfNewBuild } from '@/lib/newBuildReload';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { directory, session } from '@/sync/native-draft-fixture';
import { getChatDraftIdentityKey, readChatDraft } from '@/lib/chatDraftPersistence';

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
