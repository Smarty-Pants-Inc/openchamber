import { expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { setTimeout as sleep } from 'node:timers/promises';
import { mountedNativeComposer } from './nativeComposer.fixture';
import { directory as A, session } from '@/sync/native-draft-fixture';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { sendAdmission } from '@/sync/send-admission';
import { sendUnconfirmed } from '@/lib/sendUnconfirmed';
import { toast } from '@/components/ui';

// Astra round 5 P1 (openchamber#549, smarty-code#1427): an ambiguous ordinary Send must not fence the session for good.
// The actual composer: the lost request's text comes back, an unrelated Send waits, the unchanged re-send goes with the
// original client ID, its answer releases the session, and a later deliberate Send is a new message.
const row = { ...session, nativeRuntime: 'ordinary', herdrState: 'idle', herdrPaneLive: true,
  ordinary: { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' } };
const until = async (ok: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await act(async () => { await sleep(25); });
  expect(ok()).toBe(true);
};

test('an ambiguous Send: its unchanged re-send keeps the client ID, settles the outcome, and frees the session', async () => {
  const info = spyOn(toast, 'info').mockImplementation(() => 'test-toast');
  const c = await mountedNativeComposer(false, undefined, undefined, undefined, f => {
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [row] });
    useSessionUIStore.setState(state => ({ currentSessionId: session.id, currentSessionDirectory: A, newSessionDraft: { ...state.newSessionDraft, open: false } }));
    useInputStore.setState({ pendingInputText: null, attachedFiles: [], pendingSyntheticParts: [] });
  });
  const was = sendUnconfirmed.ms;
  sendUnconfirmed.ms = 250;
  let posts = 0;
  c.handlers.prompt = async () => ++posts === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
  try {
    await c.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' });
    await c.replace('The lost message'); await c.submit();
    await until(() => posts === 1 && sendAdmission.unconfirmed(c.runtimeA, session.id) !== undefined);
    await until(() => c.text() === 'The lost message'); // Given back by the watchdog.
    // Let the first request's own failure settle (its confirmation read), so the outcome is unknown, not in flight. A
    // re-send while it is still in flight is refused like any other (covered in send-admission.test.ts).
    await act(async () => { await sleep(500); });
    // Anything else waits for that outcome.
    const before = info.mock.calls.length;
    await c.replace('An unrelated message'); await c.submit(); await act(async () => { await sleep(50); });
    expect(posts).toBe(1);
    expect(info.mock.calls.slice(before).map(call => String(call[0]))).toContain('Waiting for your last message to be confirmed.');
    // The same message goes again with its original client ID; the gateway's answer settles it.
    await c.replace('The lost message'); await c.submit();
    await until(() => posts >= 2);
    expect(posts).toBe(2);
    const [first, retry] = await Promise.all(c.prompts().map(request => request.clone().json()));
    expect(retry.messageID).toBe(first.messageID);
    await until(() => sendAdmission.unconfirmed(c.runtimeA, session.id) === undefined);
    // A later deliberate Send is a new message.
    await c.replace('A new message'); await c.submit();
    await until(() => posts === 3);
    const third = await c.prompts()[2].clone().json();
    expect(third.messageID).not.toBe(first.messageID);
  } finally { sendUnconfirmed.ms = was; info.mockRestore(); await c.dispose(); }
}, 30_000);
