import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePromptsInFlight } from '@/sync/prompts-in-flight';

// smarty-code#902: the page's own prompt call is pending from its POST until the owner answers (15-18 s on a loaded
// Dev1), through the real composer send. A refusal is an answer: pending ends with it.
let mounted: Awaited<ReturnType<typeof mountedNativeComposer>> | undefined;
afterEach(async () => { await mounted?.dispose(); mounted = undefined; });
const pending = () => usePromptsInFlight.getState().pending[session.id] ?? 0;

async function existingSession() {
  const c = mounted = await mountedNativeComposer(true);
  await c.replace('start'); await c.submit(); await act(() => sleep(0));
  expect(useSessionUIStore.getState().currentSessionId).toBe(session.id);
  expect(pending()).toBe(0);
  return c;
}

test('a send to an existing session is pending until the owner answers its prompt call', async () => {
  const c = await existingSession();
  let answer!: () => void;
  const held = new Promise<void>(resolve => { answer = resolve; });
  c.handlers.prompt = async () => { await held; return new Response(null, { status: 204 }); };
  await c.replace('a message to a busy session'); await c.submit(); await act(() => sleep(0));
  expect(c.prompts().length).toBe(2);
  expect(pending()).toBe(1);
  const before = Date.now();
  await act(async () => { answer(); await sleep(0); await sleep(0); });
  expect(pending()).toBe(0);
  expect(usePromptsInFlight.getState().answeredAt[session.id]).toBeGreaterThanOrEqual(before);
});

test('counterexample: a refused prompt ends pending with its answer (its refusal shows as before)', async () => {
  const c = await existingSession();
  c.handlers.prompt = async () => Response.json({ name: 'Refused', data: { message: 'refused' } }, { status: 409 });
  await c.replace('a refused message'); await c.submit(); await act(() => sleep(0)); await act(() => sleep(0));
  expect(c.prompts().length).toBe(2);
  expect(pending()).toBe(0);
});
