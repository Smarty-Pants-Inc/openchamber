import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { act } from 'react';
import { mountedNativeComposer, errors } from './nativeComposer.fixture';
import { session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';

// smarty-code#126 (Paul's 2026-09-25 attempt): on a new-session draft a person types and presses Send. The real
// composer starts the session and sends once; a failed or unknown start sends nothing and keeps the text.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await sleep(1); });
const cold = () => undefined;

test('typing and pressing Send on a new draft starts the session and sends the text once', async () => {
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, cold);
  expect(c.creates()).toHaveLength(0);
  await c.replace('Hello from a new session'); await c.submit(); await settle();
  expect(c.creates()).toHaveLength(1); expect(c.prompts()).toHaveLength(1);
  const body = await c.prompts()[0].json();
  expect(body.parts.some((part: { type: string; text?: string }) => part.type === 'text' && part.text === 'Hello from a new session')).toBe(true);
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(errors).toEqual([]);
});

for (const outcome of ['refused', 'unknown'] as const) test(`a ${outcome} start sends nothing and keeps the text; Send never creates twice`, async () => {
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, cold);
  if (outcome === 'refused') c.handlers.health = async () => Response.json({ message: 'down' }, { status: 503 });
  else c.handlers.create = async () => { throw new Error('connection reset after the request'); };
  await c.replace('Keep this text'); await c.submit(); await settle();
  await c.submit(); await settle();
  expect(c.creates()).toHaveLength(outcome === 'refused' ? 0 : 1); expect(c.prompts()).toHaveLength(0);
  expect(c.text()).toBe('Keep this text');
  expect(useSessionUIStore.getState().currentSessionId).toBeNull();
});

test('Enter on an empty or blank new draft starts no session and sends nothing', async () => {
  const c = mounted = await mountedNativeComposer(false, undefined, undefined, undefined, cold);
  const { useInputStore } = await import('@/sync/input-store');
  await act(async () => { useInputStore.setState({ attachedFiles: [], pendingSyntheticParts: null }); });
  for (const text of ['', '   \n ']) {
    await c.replace(text);
    await act(async () => { c.editor().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    await c.submit(); await settle();
  }
  expect(c.creates()).toHaveLength(0); expect(c.prompts()).toHaveLength(0);
  expect(c.requests.filter(request => new URL(request.url).pathname.includes('/creation'))).toHaveLength(0);
});
