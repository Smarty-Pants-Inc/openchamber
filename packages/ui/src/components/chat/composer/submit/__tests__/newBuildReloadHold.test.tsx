import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { reloadHeld } from '@/lib/newBuildReload';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { session } from '@/sync/native-draft-fixture';

// smarty-code#713 (openchamber#333 reviews): a new-build reload waits while the mounted composer holds any text, and
// for the whole send (the composer is cleared before its prompt is sent). Through the real ChatInput, not a manual hold.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });

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
