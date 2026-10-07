import './native-test-network';
import { expect, test } from 'bun:test';
import { nativeDraftFixture, deferred, directory, session } from './native-draft-fixture';
import { routeMessage } from './session-ui-store';
import { sendAdmission } from './send-admission';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

// smarty-code#1427: the actual route, loader, optimistic records and SDK. Admission is claimed before the first await.
const pending = (runtimeKey: string) => sendAdmission.unconfirmed(runtimeKey, session.id) !== undefined;
const ordinaryRow = Object.assign({}, session, { nativeRuntime: 'ordinary', ordinary: { generation: 'g1', sequence: 1,
  model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' } });
const prepare = async (f: ReturnType<typeof nativeDraftFixture>) => {
  f.children.ensureChild(directory, { bootstrap: false }).setState({ session: [ordinaryRow] });
  await f.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
};

test('route refuses another same-session Send before the first await, then admits a deliberate one', async () => {
  const f = nativeDraftFixture(), firstResponse = deferred<Response>();
  await prepare(f);
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? firstResponse.promise : new Response(null, { status: 204 });
  const params = { runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'First', providerID: 'p', modelID: 'm', messageID: 'msg_first' };
  const first = routeMessage(params);
  try {
    expect(pending(f.runtimeA)).toBe(true);
    const second = await routeMessage({ ...params, content: 'Unrelated', messageID: 'msg_second' }).then(() => 'sent', () => 'refused');
    expect(second).toBe('refused');
    expect(posts).toBeLessThanOrEqual(1);
  } finally {
    firstResponse.resolve(new Response(null, { status: 204 }));
    await first;
    expect(pending(f.runtimeA)).toBe(false);
    expect((await f.prompts()[0].json()).messageID).toBe('msg_first');
    await routeMessage({ ...params, content: 'Deliberate', messageID: 'msg_after' });
    expect(posts).toBe(2);
    f.dispose();
  }
});

// Astra round 5 P1: an ambiguous Send must not fence the session for good. The same message, re-sent with its original
// client ID, reaches the gateway; its answer settles the outcome; a later deliberate Send goes.
test('an ambiguous ordinary Send admits its same-ID retry, whose answer releases the session', async () => {
  const f = nativeDraftFixture();
  await prepare(f);
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? new Response(null, { status: 503 }) : new Response(null, { status: 204 });
  const params = { runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'Lost', providerID: 'p', modelID: 'm', messageID: 'msg_lost' };
  try {
    expect(await routeMessage(params).then(() => 'sent', () => 'failed')).toBe('failed');
    expect(sendAdmission.unconfirmed(f.runtimeA, session.id)).toMatchObject({ messageID: 'msg_lost' });
    expect(await routeMessage({ ...params, content: 'Other', messageID: 'msg_other' }).then(() => 'sent', () => 'refused')).toBe('refused');
    expect(await routeMessage(params).then(() => 'sent', () => 'refused')).toBe('sent');
    const ids = await Promise.all(f.prompts().map(async request => (await request.clone().json()).messageID));
    expect(ids).toEqual(['msg_lost', 'msg_lost']);
    expect(pending(f.runtimeA)).toBe(false);
    expect(await routeMessage({ ...params, content: 'Next', messageID: 'msg_next' }).then(() => 'sent', () => 'refused')).toBe('sent');
  } finally { f.dispose(); }
});

// Security round 2 P2 1: the model comes from the same source that classified the session, and is checked again
// right before the request leaves. A global-only owner whose native model changes during preparation is refused.
test('a global-only owner pins its own model and refuses when the native model changes before dispatch', async () => {
  const f = nativeDraftFixture(), conversion = deferred<void>(), started = deferred<void>();
  f.children.ensureChild(directory, { bootstrap: false }).setState({ session: [] });
  useGlobalSessionsStore.getState().applySnapshot([ordinaryRow], []);
  await f.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
  const { opencodeClient } = await import('@/lib/opencode/client');
  Reflect.set(opencodeClient, 'toNormalizedFilePartInput', async () => { started.resolve(); await conversion.promise;
    return { type: 'file', mime: 'text/plain', filename: 'a.txt', url: 'data:text/plain;base64,WA==' }; });
  const route = routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'Pinned', providerID: 'stale-p',
    modelID: 'stale-m', files: [{ type: 'file', mime: 'text/plain', filename: 'a.txt', url: 'data:text/plain;base64,WA==' }] })
    .then(() => 'sent', () => 'refused');
  try {
    await started.promise;
    // The native model changes while the request is being prepared.
    const changed = { ...ordinaryRow, ordinary: { ...ordinaryRow.ordinary, generation: 'g2', sequence: 2,
      model: { providerID: 'p2', modelID: 'm2', name: 'M2' } } };
    useGlobalSessionsStore.setState(state => ({ entityById: new Map(state.entityById).set(session.id, changed) }));
    conversion.resolve();
    expect(await route).toBe('refused');
    expect(f.prompts()).toHaveLength(0);
    expect(pending(f.runtimeA)).toBe(false);
  } finally { conversion.resolve(); Reflect.deleteProperty(opencodeClient, 'toNormalizedFilePartInput'); await route; f.dispose(); }
});

test('a global-only owner sends with its native model, not the caller\'s stale one', async () => {
  const f = nativeDraftFixture();
  f.children.ensureChild(directory, { bootstrap: false }).setState({ session: [] });
  useGlobalSessionsStore.getState().applySnapshot([ordinaryRow], []);
  await f.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
  try {
    expect(await routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'Model', providerID: 'stale-p',
      modelID: 'stale-m', agent: 'build' }).then(() => 'sent', () => 'refused')).toBe('sent');
    const body = await f.prompts()[0].json();
    expect(body.model).toEqual({ providerID: 'p', modelID: 'm' });
    expect(body.agent).toBeUndefined();
  } finally { f.dispose(); }
});

test('a loader-only ordinary owner names no model, so the Send is refused rather than sent as stock', async () => {
  const f = nativeDraftFixture();
  await prepare(f);
  f.children.getChild(directory)!.setState({ session: [] });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  try {
    expect(await routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'No model', providerID: 'p',
      modelID: 'm' }).then(() => 'sent', () => 'refused')).toBe('refused');
    expect(f.prompts()).toHaveLength(0);
  } finally { f.dispose(); }
});

test('stock prompt concurrency remains unchanged', async () => {
  const f = nativeDraftFixture(), held = deferred<Response>();
  f.children.ensureChild(directory, { bootstrap: false }).setState({ session: [session] });
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? held.promise : new Response(null, { status: 204 });
  const params = { runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'Stock input', providerID: 'p', modelID: 'm' };
  const first = routeMessage(params);
  try {
    await routeMessage({ ...params, content: 'Stock steer' });
    expect(posts).toBe(2);
    expect(pending(f.runtimeA)).toBe(false);
  } finally { held.resolve(new Response(null, { status: 204 })); await first; f.dispose(); }
});

// Security pass on a5716127, P2: the row this Send goes to says its Pi is reloading or has ended, with no global mark.
for (const [label, mark] of [['reloading', { ordinaryReloading: true }], ['ended', { herdrState: 'ended', herdrPaneLive: false }]] as const) {
  test(`a ${label} target row refuses before any request leaves`, async () => {
    const f = nativeDraftFixture();
    f.children.ensureChild(directory, { bootstrap: false }).setState({ session: [{ ...ordinaryRow, ...mark }] });
    await f.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
    try {
      expect(await routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'Must not send',
        providerID: 'p', modelID: 'm' }).then(() => 'sent', () => 'refused')).toBe('refused');
      expect(f.prompts()).toHaveLength(0);
      expect(pending(f.runtimeA)).toBe(false);
    } finally { f.dispose(); }
  });
}

test('without Web Locks an ordinary Send is refused and nothing is posted; stock still sends', async () => {
  const f = nativeDraftFixture();
  await prepare(f);
  const locks = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { ...globalThis.navigator, locks: undefined } });
  try {
    expect(await routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'No locks', providerID: 'p',
      modelID: 'm' }).then(() => 'sent', () => 'refused')).toBe('refused');
    expect(f.prompts()).toHaveLength(0);
    expect(pending(f.runtimeA)).toBe(false);
  } finally { if (locks) Object.defineProperty(globalThis, 'navigator', locks); f.dispose(); }
});

// openchamber#566 security P1 (smarty-code#1443): Review Flow uses the same Send route. While an ordinary Send is
// unresolved, a Review Flow message to that session is refused; to a stock session it still goes.
test('a Review Flow send to an ordinary session with an unresolved Send is refused', async () => {
  const f = nativeDraftFixture(), held = deferred<Response>();
  await prepare(f);
  const review = { ...session, id: '01234567-1234-4234-9234-0123456789aa', title: 'review',
    metadata: { openchamber: { kind: 'review', originalSessionID: session.id } } };
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET' && new URL(request.url).pathname.endsWith(`/session/${review.id}`)) return Response.json(review);
    return fixtureFetch(input, init);
  };
  // Review Flow resolves its model from the session's last choice; give it one so only admission can refuse it.
  const { useConfigStore } = await import('@/stores/useConfigStore');
  useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? held.promise : new Response(null, { status: 204 });
  const first = routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'First', providerID: 'p', modelID: 'm' });
  try {
    expect(pending(f.runtimeA)).toBe(true);
    const { sendReviewFeedbackToOriginal } = await import('@/lib/reviewFlow');
    let failure = '';
    const outcome = await sendReviewFeedbackToOriginal(review.id, directory, 'Review findings', f.runtimeA)
      .then(() => 'sent', error => { failure = String(error); return 'refused'; });
    expect(outcome).toBe('refused');
    expect(failure).toContain('Waiting for your last message to be confirmed');
    expect(posts).toBe(1);
  } finally {
    held.resolve(new Response(null, { status: 204 })); await first;
    globalThis.fetch = fixtureFetch; f.dispose();
  }
});

// openchamber#566 security P1: a stock row for this session in ANOTHER directory does not hide the global ordinary owner
// of the target directory; with no accepted loader view the Send is still reserved, never sent unreserved as stock.
test('a stock row in another directory does not suppress the global ordinary owner of the target', async () => {
  const f = nativeDraftFixture(), held = deferred<Response>();
  const elsewhere = '/native-project-b';
  f.children.ensureChild(directory, { bootstrap: false }).setState({ session: [] });
  f.children.ensureChild(elsewhere, { bootstrap: false }).setState({ session: [{ ...session, directory: elsewhere }] });
  useGlobalSessionsStore.getState().applySnapshot([{ ...ordinaryRow, directory }], []);
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? held.promise : new Response(null, { status: 204 });
  const params = { runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'First', providerID: 'p', modelID: 'm' };
  const first = routeMessage(params).catch(() => undefined);
  try {
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(pending(f.runtimeA)).toBe(true);
    const second = await routeMessage({ ...params, content: 'Unrelated' }).then(() => 'sent', () => 'refused');
    expect(second).toBe('refused');
    expect(posts).toBeLessThanOrEqual(1);
  } finally { held.resolve(new Response(null, { status: 204 })); await first; f.dispose(); }
});

test('a Review Flow send to a stock session still goes while another prompt is in flight', async () => {
  const f = nativeDraftFixture(), held = deferred<Response>();
  f.children.ensureChild(directory, { bootstrap: false }).setState({ session: [session] });
  const review = { ...session, id: '01234567-1234-4234-9234-0123456789ab', title: 'review',
    metadata: { openchamber: { kind: 'review', originalSessionID: session.id } } };
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET' && new URL(request.url).pathname.endsWith(`/session/${review.id}`)) return Response.json(review);
    return fixtureFetch(input, init);
  };
  const { useConfigStore } = await import('@/stores/useConfigStore');
  useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? held.promise : new Response(null, { status: 204 });
  const first = routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'First', providerID: 'p', modelID: 'm' });
  try {
    const { sendReviewFeedbackToOriginal } = await import('@/lib/reviewFlow');
    expect(await sendReviewFeedbackToOriginal(review.id, directory, 'Review findings', f.runtimeA).then(() => 'sent', () => 'refused')).toBe('sent');
    expect(posts).toBe(2);
    expect(pending(f.runtimeA)).toBe(false);
  } finally { held.resolve(new Response(null, { status: 204 })); await first; globalThis.fetch = fixtureFetch; f.dispose(); }
});

// openchamber#566 review delta P2: a refused Review Flow send does not force the transcript to scroll; an accepted one
// scrolls after its row is inserted.
test('Review Flow scrolls only after its row is inserted, never for a refused send', async () => {
  const f = nativeDraftFixture(), held = deferred<Response>();
  await prepare(f);
  const review = { ...session, id: '01234567-1234-4234-9234-0123456789ac', title: 'review',
    metadata: { openchamber: { kind: 'review', originalSessionID: session.id } } };
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET' && new URL(request.url).pathname.endsWith(`/session/${review.id}`)) return Response.json(review);
    return fixtureFetch(input, init);
  };
  // Bun has no window: give the scroll request a real event target to land on.
  const hadWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  const scrolls: number[] = [];
  target.addEventListener('openchamber:chat-force-scroll-bottom', () => { scrolls.push(posts); });
  const { useConfigStore } = await import('@/stores/useConfigStore');
  useConfigStore.setState({ currentProviderId: 'p', currentModelId: 'm' });
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? held.promise : new Response(null, { status: 204 });
  const first = routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'First', providerID: 'p', modelID: 'm' });
  try {
    const { sendReviewFeedbackToOriginal } = await import('@/lib/reviewFlow');
    // Refused: the first Send is unresolved. No scroll.
    expect(await sendReviewFeedbackToOriginal(review.id, directory, 'Review findings', f.runtimeA).then(() => 'sent', () => 'refused')).toBe('refused');
    expect(scrolls).toEqual([]);
    held.resolve(new Response(null, { status: 204 })); await first;
    // Accepted: one scroll, after the row is inserted and before its POST.
    expect(await sendReviewFeedbackToOriginal(review.id, directory, 'Review findings', f.runtimeA).then(() => 'sent', () => 'refused')).toBe('sent');
    expect(scrolls).toEqual([1]);
  } finally {
    held.resolve(new Response(null, { status: 204 })); await first;
    if (hadWindow) Object.defineProperty(globalThis, 'window', hadWindow); else Reflect.deleteProperty(globalThis, 'window');
    globalThis.fetch = fixtureFetch; f.dispose();
  }
});
