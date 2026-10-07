import { expect, test } from 'bun:test';
import { acceptedView, directory, session } from '@/sync/native-draft-fixture';
import { admitted, conflict, flight, pause, pending, receiptRace902, words } from './receiptRace902.fixture';
import { errors } from './nativeComposer.fixture';

const NO_REPLY = 'did not start a reply';
const TAKEN = 'Sent: the session has this message';

// Combined #902 path, not a trackPrompt/helper simulation: CodeMirror -> mounted form -> ChatInput recovery ->
// session UI store -> routeMessage -> optimisticSend -> client -> SDK -> synthetic HTTP. Real notice and sync hooks
// subscribe to that same child. No full SyncProvider lifecycle, SSE socket, browser/proxy or native owner is mounted.
for (const receipt of ['queued', 'accepted'] as const) {
  for (const order of ['original-first', 'conflict-first'] as const) {
    test(`${receipt}, ${order}: watchdog same-ID retry cannot revoke the original admission`, async () => {
      const c = await receiptRace902();
      try {
        const sentAt = Date.now();
        await c.submit();
        expect(c.prompts()).toHaveLength(1);
        expect(c.prompts()[0].headers.get('x-smarty-ordinary-view')).toBe(acceptedView);
        expect(new URL(c.prompts()[0].url).searchParams.get('directory')).toBe(directory);
        expect(pending()).toBe(1);
        expect(c.text()).toBe('');
        await pause(7_000);
        await c.idle(); // Authoritative idle uses the production event entrypoint, not a store status overwrite.
        expect(Date.now() - sentAt).toBeGreaterThanOrEqual(7_000);
        expect(pending()).toBe(1);
        expect(c.child.getState().session_status[session.id]?.type).toBe('idle');
        expect(c.notice()).toContain('Sending…');
        expect(c.notice()).not.toContain(NO_REPLY);
        const originalRow = c.rows()[0];
        const originalParts = c.child.getState().part[originalRow.id];
        expect(originalRow.time).toMatchObject({ completed: 0 });
        await pause(Math.max(0, 45_100 - (Date.now() - sentAt)));
        expect(c.text()).toBe(words); // Production 45s recovery restored the untouched input.
        expect(pending()).toBe(1); // The watchdog neither canceled nor settled the original POST.
        expect(c.notice()).not.toContain(NO_REPLY);
        await c.submit();
        expect(c.prompts()).toHaveLength(2);
        const [first, retry] = await c.ids();
        expect(retry).toBe(first);
        expect(originalRow.id).toBe(first);
        expect(pending()).toBe(2);
        if (order === 'original-first') {
          await c.answer(0, admitted(receipt)); await c.idle();
          expect(pending()).toBe(1);
          expect(flight().receipt[session.id]).toBe(receipt);
          await c.answer(1, conflict());
        } else {
          await c.answer(1, conflict()); await c.idle();
          expect(pending()).toBe(1);
          expect(c.notice()).toContain('Sending…');
          expect(c.notice()).not.toContain(NO_REPLY);
          await c.answer(0, admitted(receipt));
        }
        await c.idle();
        expect(pending()).toBe(0);
        expect(c.rows()).toEqual([originalRow]);
        expect(c.child.getState().part[first]).toBe(originalParts);
        expect(c.failures()).toEqual([]); // A reservation conflict is not a message refusal.
        await pause(5_200);
        console.info('902 receipt completion', { receipt, order, pending: pending(),
          retainedReceipt: flight().receipt[session.id], notice: c.notice(), rows: c.rows().length });
        // RED on this HEAD for original-first: the notice falsely declares failure and the receipt is gone.
        expect(c.notice()).not.toContain(NO_REPLY);
        expect(c.notice()).toContain(TAKEN);
        expect(flight().receipt[session.id]).toBe(receipt);
        // Authoritative active state suppresses the diagnostic through the real status subscription.
        await c.event({ id: crypto.randomUUID(), type: 'session.status', properties: { sessionID: session.id, status: { type: 'busy' } } });
        expect(c.notice()).toBe('');
        await c.idle();
        expect(c.notice()).toContain(TAKEN);
        // A newer assistant also suppresses it through the real message subscription.
        await c.event({ id: crypto.randomUUID(), type: 'message.updated', properties: { sessionID: session.id, info: { id: 'msg_receipt902_reply',
          sessionID: session.id, role: 'assistant', parentID: first, modelID: 'm', providerID: 'p',
          mode: 'build', agent: 'build', path: { cwd: directory, root: directory },
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() } } } });
        expect(c.notice()).toBe('');
        expect(c.prompts()).toHaveLength(2);
      } finally { await c.dispose(); }
    }, 70_000);
  }
}

test('a different message answered header-free must not borrow the older message receipt', async () => {
  const c = await receiptRace902();
  try {
    await c.submit(); await c.answer(0, admitted('queued')); await c.idle();
    expect(flight().receipt[session.id]).toBe('queued');
    await c.replace('a different message'); await c.submit();
    const [first, next] = await c.ids();
    expect(next).not.toBe(first);
    await c.answer(1, new Response(null, { status: 204 })); await c.idle();
    expect(pending()).toBe(0);
    expect(c.rows()).toHaveLength(2);
    expect(c.rows().at(-1)?.id).toBe(next);
    expect(flight().receipt[session.id]).toBeUndefined();
    await pause(5_200);
    expect(c.notice()).not.toContain(TAKEN);
    expect(c.notice()).toContain(NO_REPLY); // Existing unanswered-turn diagnostic, not a definite refusal.
    expect(c.failures()).toEqual([]);
    expect(c.prompts()).toHaveLength(2);
  } finally { await c.dispose(); }
}, 15_000);

test('definite prompt-blocked refusal still surfaces promptly through SDK, rollback and the actual notice', async () => {
  const c = await receiptRace902();
  try {
    await c.submit();
    const reason = 'The session terminal is busy. Nothing was sent.';
    await c.answer(0, Response.json({ name: 'APIError', data: { message: reason,
      isRetryable: false, code: 'smarty.prompt-blocked' } }, { status: 409 }));
    expect(errors).toContain(reason); // Refusal surfaces even while the session is still shown busy.
    await c.idle();
    // No five-second diagnostic wait and no watchdog expiry.
    expect(pending()).toBe(0);
    expect(flight().receipt[session.id]).toBeUndefined();
    expect(c.notice()).toContain('This message was not sent');
    expect(c.notice()).toContain(reason);
    expect(c.notice()).not.toContain(NO_REPLY);
    expect(c.text()).toBe(words);
    expect(c.rows()).toEqual([]);
    expect(c.failures()).toHaveLength(1);
    expect(c.failures()[0].sendOutcome).toBe('refused');
    expect(c.prompts()).toHaveLength(1);
  } finally { await c.dispose(); }
}, 15_000);
