import './native-test-network';
import { expect, test } from 'bun:test';
import { nativeDraftFixture, deferred, directory, session } from './native-draft-fixture';
import { routeMessage } from './session-ui-store';
import { sessionSendState } from './session-send-state';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { markAmbiguousTransportFailure } from '@/lib/relay/transport-error';
import { isAmbiguousSendFailure } from './send-failure-classification';
import { isClientIdConflict } from '@/lib/sendRecovery';

// The actual route, loader, optimistic records and SDK remain in this regression.
// The first response stays held while a second caller tries a different client ID.
test('route atomically refuses another same-session Send before the first await', async () => {
  const f = nativeDraftFixture(), firstResponse = deferred<Response>();
  f.children.ensureChild(directory, { bootstrap: false }).setState({ session: [Object.assign({}, session, {
    nativeRuntime: 'ordinary', ordinary: { generation: 'g1', sequence: 1,
      model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' },
  })] });
  await f.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? firstResponse.promise : new Response(null, { status: 204 });
  const params = { runtimeKey: f.runtimeA, sessionId: session.id, directory,
    content: 'First deliberate input', providerID: 'p', modelID: 'm', messageID: 'msg_first' };
  const first = routeMessage(params);
  try {
    const second = await routeMessage({ ...params, content: 'Unrelated second input', messageID: 'msg_second' })
      .then(() => 'accepted', () => 'refused');
    expect(second).toBe('refused');
    expect(posts).toBeLessThanOrEqual(1);
    expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(true);
  } finally {
    firstResponse.resolve(new Response(null, { status: 204 }));
    await first;
    expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(false);
    const body = await f.prompts()[0].json();
    expect(body.messageID).toBe('msg_first');
    await routeMessage({ ...params, content: 'Known-settled deliberate Send', messageID: 'msg_after_settlement' });
    expect(posts).toBe(2);
    f.dispose();
  }
});

// smarty-code#1427: ownership comes from every authoritative source, not only the directory row.
const globalOrdinary = Object.assign({}, session, { nativeRuntime: 'ordinary', ordinary: { generation: 'g1', sequence: 1,
  model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' } });
for (const [label, prepare] of [
  ['global-only row before directory bootstrap', async (f: ReturnType<typeof nativeDraftFixture>) => {
    f.children.ensureChild(directory, { bootstrap: false }).setState({ session: [] });
    useGlobalSessionsStore.getState().applySnapshot([globalOrdinary], []);
  }],
  ['accepted loader view with no indexed row', async (f: ReturnType<typeof nativeDraftFixture>) => {
    const child = f.children.ensureChild(directory, { bootstrap: false });
    child.setState({ session: [globalOrdinary] });
    await f.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
    child.setState({ session: [] });
  }],
] as const) {
  test(`route reserves an ordinary owner known from ${label}`, async () => {
    const f = nativeDraftFixture(), held = deferred<Response>();
    let posts = 0;
    f.handlers.prompt = async () => ++posts === 1 ? held.promise : new Response(null, { status: 204 });
    const params = { runtimeKey: f.runtimeA, sessionId: session.id, directory, content: 'First', providerID: 'p', modelID: 'm' };
    try {
      await prepare(f);
      const first = routeMessage(params).catch(() => undefined);
      expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(true);
      const second = await routeMessage({ ...params, content: 'Unrelated' }).then(() => 'accepted', () => 'refused');
      expect(second).toBe('refused');
      expect(posts).toBeLessThanOrEqual(1);
      held.resolve(new Response(null, { status: 204 }));
      await first;
      expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(false);
    } finally { held.resolve(new Response(null, { status: 204 })); f.dispose(); }
  });
}

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
    expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(false);
  } finally { held.resolve(new Response(null, { status: 204 })); await first; f.dispose(); }
});

const runtime = () => `send-state-${crypto.randomUUID()}`;
const claim = (r: string, s = 'session', id = 'msg_first') => {
  const attempt = sessionSendState.begin(r, s, id);
  if (!attempt) throw new Error('Expected admission');
  return attempt;
};

test('one synchronous claim, irrespective of client ID and owner directory', () => {
  const r = runtime(), first = claim(r);
  expect(first.messageID).toBe('msg_first');
  expect(sessionSendState.begin(r, 'session', 'msg_second')).toBeNull();
  expect(sessionSendState.begin(r, 'session', 'msg_first')).toBeNull();
  expect(first.canDispatch()).toBe(true);
  first.accepted();
  expect(sessionSendState.isPending(r, 'session')).toBe(false);
  expect(first.canDispatch()).toBe(false);
  const next = claim(r, 'session', 'msg_next');
  first.accepted(); // A stale callback cannot remove a newer claim.
  expect(sessionSendState.isPending(r, 'session')).toBe(true);
  next.accepted();
});

test('module re-import and replacement readers retain the held request', async () => {
  const r = runtime(), attempt = claim(r);
  const replacement = (await import('./session-send-state')).sessionSendState;
  expect(replacement).toBe(sessionSendState);
  expect(replacement.isPending(r, 'session')).toBe(true);
  expect(replacement.begin(r, 'session', 'msg_after_remount')).toBeNull();
  attempt.accepted();
  expect(replacement.isPending(r, 'session')).toBe(false);
});

test('other sessions and equal session UUIDs in other runtimes remain independent', () => {
  const a = runtime(), b = runtime(), first = claim(a), other = claim(a, 'other'), second = claim(b);
  first.dispatched(); second.dispatched();
  first.failed('unknown');
  second.accepted(); other.accepted();
  expect(sessionSendState.isPending(a, 'session')).toBe(true);
  expect(sessionSendState.isPending(b, 'session')).toBe(false);
  // The returning A reader still sees its unknown, independently of B settlement.
  expect(sessionSendState.begin(a, 'session', 'msg_return_to_a')).toBeNull();
});

for (const error of [new Error('Client message id already exists or a submission is pending'),
  markAmbiguousTransportFailure(new Error('stream lost')), new TypeError('Failed to fetch')]) {
  test(`dispatched uncertainty retains reservation: ${error.message}`, () => {
    const r = runtime(), attempt = claim(r);
    attempt.dispatched();
    attempt.failed(isClientIdConflict(error.message) || isAmbiguousSendFailure(error) ? 'unknown' : 'refused');
    expect(sessionSendState.isPending(r, 'session')).toBe(true);
    expect(attempt.canDispatch()).toBe(false);
    attempt.dispatched(); attempt.failed('refused'); // Duplicate callbacks cannot erase unknown.
    expect(sessionSendState.isPending(r, 'session')).toBe(true);
    expect(sessionSendState.begin(r, 'session', 'msg_new')).toBeNull();
  });
}

test('known acceptance or refusal permits another deliberate Send immediately', () => {
  const r = runtime(), first = claim(r);
  first.dispatched(); first.failed('refused');
  expect(sessionSendState.isPending(r, 'session')).toBe(false);
  const next = claim(r); next.dispatched(); next.accepted();
  expect(sessionSendState.isPending(r, 'session')).toBe(false);
});

test('preparation throws release even when their text resembles transport ambiguity', () => {
  const r = runtime(), first = claim(r);
  first.failed(isAmbiguousSendFailure(new TypeError('Failed to fetch attachment before dispatch')) ? 'unknown' : 'refused');
  expect(sessionSendState.isPending(r, 'session')).toBe(false);
  const next = claim(r); next.accepted();
});
