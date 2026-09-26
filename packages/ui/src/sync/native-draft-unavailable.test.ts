import { afterEach, expect, test } from 'bun:test';
import { composerSend, failure, fx, h, interactive, operationId, record, repliedActions, replies, resetInteractive, send, sentMark, unavailable } from './native-draft-interactive';
import { startNativeDraft, startNativeDraftInstead } from './native-draft-start';

// smarty-code#126 (3.18 walk): the gateway answers 'unavailable' while the new owner cannot be read for a moment (its Pi
// is still starting), and the operation stays unsettled. That is not an outcome: Send keeps re-reading until its limit,
// never answers or creates again meanwhile, and only then reports the start as unknown, sending nothing.
afterEach(resetInteractive);

test("an 'unavailable' create answer, then the real state: the start continues and the message is sent once", async () => {
  interactive(unavailable);
  h.reads = [unavailable()];
  await startNativeDraft([], async () => {}); await send();
  expect(fx().creates()).toHaveLength(1);
  expect(await repliedActions()).toEqual(['trust', 'ready']);
  expect(fx().prompts()).toHaveLength(1);
});

test("an 'unavailable' answer to the ready reply is re-read, never answered again; then the message is sent once", async () => {
  interactive(() => h.operation);
  const answer = h.reply;
  h.reply = body => { const next = answer(body); return body.action === 'ready' ? unavailable() : next; };
  h.reads = [unavailable()];
  await startNativeDraft([], async () => {}); await send();
  expect(fx().creates()).toHaveLength(1);
  expect(await repliedActions()).toEqual(['trust', 'ready']);
  expect(fx().prompts()).toHaveLength(1);
});

test("'unavailable' until the time limit: the start is unknown, nothing is sent, created or answered again", async () => {
  interactive(unavailable);
  h.reads = Array.from({ length: 1000 }, unavailable);
  const now = Date.now; let clock = now();
  Date.now = () => (clock += 30_000);
  try { expect(await failure(startNativeDraft([], async () => {}))).toBe('unknown'); } finally { Date.now = now; }
  expect(fx().creates()).toHaveLength(1); expect(replies()).toHaveLength(0); expect(fx().prompts()).toHaveLength(0);
  // It re-read until the limit, rather than giving up on the first 'unavailable'.
  expect(fx().requests.filter(r => new URL(r.url).pathname.endsWith(`/creation/${operationId}`)).length).toBeGreaterThan(1);
  expect(record()?.status).toBe('pending');
});

for (const action of ['trust', 'ready'] as const) {
  test(`an 'unavailable' answer to the ${action} reply, then a read with no newer state: never answered again; unknown at the limit`, async () => {
    interactive(() => h.operation);
    const answer = h.reply;
    let answered = false;
    h.reply = body => {
      if (body.action !== action) return answer(body);
      answered = true; return unavailable(); // The reply's outcome is not known: the server state did not move.
    };
    h.reads = [unavailable()];
    const now = Date.now; let clock = now();
    Date.now = () => (clock += answered ? 30_000 : 0);
    try { expect(await failure(startNativeDraft([], async () => {}))).toBe('unknown'); } finally { Date.now = now; }
    const sent = await repliedActions();
    expect(sent.filter(value => value === action)).toHaveLength(1);
    expect(fx().creates()).toHaveLength(1); expect(fx().prompts()).toHaveLength(0);
  });
}

test('the first-input answer is POSTed once, even while the owner still reports ready-required right after it', async () => {
  interactive(() => h.operation);
  const answer = h.reply;
  // The owner arms input a moment after the answer: its reply still says ready-required (a newer revision), then ready.
  h.reply = body => {
    const next = answer(body);
    if (body.action !== 'ready') return next;
    h.reads = [{ ...next, phase: 'ready' }];
    return { ...next, phase: 'ready-required', canInitialReady: true };
  };
  await startNativeDraft([], async () => {}); await send();
  expect(await repliedActions()).toEqual(['trust', 'ready']);
  expect(fx().prompts()).toHaveLength(1);
});

test('#117: the accepted start marks its text as sent; an admitted send marks it admitted, so other tabs consume it', async () => {
  interactive(() => h.operation);
  let marked: string | null = null;
  const answer = h.reply;
  h.reply = body => { marked ??= sentMark(); return answer(body); }; // Seen while the start is still being answered.
  await startNativeDraft([], async () => {}); await composerSend();
  expect(marked).toContain(h.operation.clientRequestId!);
  expect(JSON.parse(sentMark()!)).toMatchObject({ clientRequestId: h.operation.clientRequestId, admitted: true });
  expect(fx().prompts()).toHaveLength(1);
});

test('#340: "Start a new session instead" abandons the unreadable start, then Send starts one new session and sends once', async () => {
  interactive(unavailable);
  h.reads = Array.from({ length: 1000 }, unavailable);
  const now = Date.now; let clock = now();
  Date.now = () => (clock += 30_000);
  try { expect(await failure(startNativeDraft([], async () => {}))).toBe('unknown'); } finally { Date.now = now; }
  const old = { ...h.operation };
  // A refused abandon keeps the start as it was.
  h.abandon = () => Response.json({ name: 'APIError', data: { message: 'This start already finished' } }, { status: 409 });
  expect(await failure(startNativeDraftInstead())).not.toBe('resolved');
  expect(record()?.status).toBe('pending');
  h.abandon = value => Response.json({ nativeCreation: { ...value, revision: 0, generation: null, phase: 'cancelled' } });
  expect(await startNativeDraftInstead()).toBe(true);
  expect(record()).toBeNull(); expect(sentMark()).toBeNull();
  expect(fx().requests.filter(r => new URL(r.url).pathname.endsWith('/abandon'))).toHaveLength(2);
  h.reads = [];
  h.operation = { ...h.operation, operationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', revision: 1, phase: 'awaiting-trust', clientRequestId: undefined };
  fx().handlers.create = async request => {
    h.operation = { ...h.operation, clientRequestId: JSON.parse(await request.clone().text()).clientRequestId };
    return Response.json({ nativeCreation: h.operation }, { status: 202 });
  };
  // The composer's Send passes the list it read before the abandon (Astra pre-check): that start is settled all the same.
  await startNativeDraft([old], async () => {}); await send();
  const ids = await Promise.all(fx().creates().map(async r => JSON.parse(await r.clone().text()).clientRequestId));
  expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]);
  expect(fx().prompts()).toHaveLength(1);
});
