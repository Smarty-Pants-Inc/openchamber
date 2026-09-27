import { afterEach, expect, test } from 'bun:test';
import { directory, nativeDraftFixture, session } from './native-draft-fixture';

// smarty-code#536 / #562 (a frozen Pi): a history open that never answers kept the page on its loading skeleton for
// over a minute with nothing said (three 30 s tries). A read that timed out is not tried again: the open fails at once,
// and the page shows why, with Try again. Other transient failures are still retried.
let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });
const reads = () => fixture!.requests.filter(request => new URL(request.url).pathname.endsWith('/message')).length;

test('a history read that times out fails after one try, and the open shows its error', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new Error('OpenCode request timed out after 30000ms'); };
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'navigation' });
  expect(reads()).toBe(1);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
});

test('a transient failure that is not a timeout is still tried again', async () => {
  fixture = nativeDraftFixture();
  let n = 0;
  fixture.handlers.history = async () => (++n < 2 ? Response.json({ message: 'unavailable' }, { status: 503 }) : Response.json([]));
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'navigation' });
  expect(reads()).toBe(2);
  expect(fixture.loader.getSnapshot(target).status).not.toBe('error');
});

test('a tail refresh that times out keeps its tries: its view stays shown meanwhile', async () => {
  fixture = nativeDraftFixture();
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'navigation' });
  const opened = reads();
  let n = 0;
  fixture.handlers.history = async () => { if (++n < 2) throw new Error('OpenCode request timed out after 30000ms'); return Response.json([]); };
  await fixture.loader.refreshTail(target, 20);
  expect(reads() - opened).toBe(2);
});

test('after an open timed out, the page\'s automatic re-ensures start no new read; Try again does', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new Error('OpenCode request timed out after 30000ms'); };
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'reactive' });
  expect(reads()).toBe(1);
  await fixture.loader.ensure(target, { reason: 'reactive' }); // A session update re-runs the page's effect.
  await fixture.loader.prefetch(target);
  expect(reads()).toBe(1);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  fixture.handlers.history = async () => Response.json([]);
  await fixture.loader.ensure(target, { force: true, reason: 'reactive' }); // Try again.
  expect(reads()).toBe(2);
  expect(fixture.loader.getSnapshot(target).status).not.toBe('error');
});

test('after another failure, an automatic re-ensure still loads again (recovery is kept)', async () => {
  fixture = nativeDraftFixture();
  let failing = true;
  fixture.handlers.history = async () => (failing ? Response.json({ name: 'APIError', data: { message: 'x' } }, { status: 400 }) : Response.json([]));
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'reactive' });
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  failing = false;
  await fixture.loader.ensure(target, { reason: 'reactive' });
  expect(fixture.loader.getSnapshot(target).status).not.toBe('error');
});

test('a tail refresh queued behind an open that times out reads nothing (one open, one timeout)', async () => {
  fixture = nativeDraftFixture();
  let release = () => {};
  fixture.handlers.history = async () => { await new Promise<void>(resolve => { release = resolve; }); throw new Error('OpenCode request timed out after 30000ms'); };
  const target = { directory, sessionID: session.id };
  const opening = fixture.loader.ensure(target, { reason: 'reactive' });
  await new Promise(resolve => setTimeout(resolve, 10));
  const queued = fixture.loader.refreshTail(target, 20); // As a pinned-message section asks, while the open is out.
  release(); await opening; await queued;
  expect(reads()).toBe(1);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
});

test('a cold tail refresh (before any open) that times out is one read', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new Error('OpenCode request timed out after 30000ms'); };
  const target = { directory, sessionID: session.id };
  await fixture.loader.refreshTail(target, 20); // A pinned-message section, before the page's open.
  await fixture.loader.ensure(target, { reason: 'reactive' }); // Then the page's open.
  expect(reads()).toBe(1);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
});

test('a loaded session\'s tail refresh that times out does not latch: the next automatic refresh reads again', async () => {
  fixture = nativeDraftFixture();
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'reactive' }); // Loaded.
  fixture.handlers.history = async () => { throw new Error('OpenCode request timed out after 30000ms'); };
  await fixture.loader.refreshTail(target, 20).catch(() => undefined); // Its tries all time out.
  const before = reads();
  fixture.handlers.history = async () => Response.json([]);
  await fixture.loader.refreshTail(target, 20); // The server is back: an automatic refresh (send, idle) reads again.
  expect(reads()).toBe(before + 1);
});

test('a loaded session that disconnects and then times out is not latched as an open', async () => {
  fixture = nativeDraftFixture();
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'reactive' }); // Loaded once.
  fixture.handlers.history = async () => { throw new Error('OpenCode request timed out after 30000ms'); };
  await fixture.loader.ensure(target, { force: true, reason: 'reactive' }).catch(() => undefined); // A reload times out.
  fixture.handlers.history = async () => Response.json([]);
  const before = reads();
  await fixture.loader.ensure(target, { reason: 'reactive' }); // The page's reconnect reload: it reads again.
  expect(reads()).toBeGreaterThan(before);
});

test('a new connection (re-login) lets the page\'s reloads try a timed-out open again', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new Error('OpenCode request timed out after 30000ms'); };
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'reactive' });
  expect(reads()).toBe(1);
  fixture.handlers.history = async () => Response.json([]);
  const { opencodeClient } = await import('@/lib/opencode/client');
  const current = opencodeClient.getSdkClient();
  // SAFETY: a copy of the client with the same prototype and fields: a distinct client, as after re-login.
  const relogged = Object.assign(Object.create(Object.getPrototypeOf(current)), current) as typeof current;
  fixture.loader.configure({ sdk: relogged, runtimeKey: fixture.runtimeA }); // A new client, as after re-login.
  await fixture.loader.ensure(target, { reason: 'reactive' });
  expect(reads()).toBe(2);
  expect(fixture.loader.getSnapshot(target).status).not.toBe('error');
});

test('a stream reconnect lets the page\'s recovery reload try a timed-out open again', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new Error('OpenCode request timed out after 30000ms'); };
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'reactive' });
  fixture.handlers.history = async () => Response.json([]);
  fixture.loader.connectionRestored(); // The event stream is back (same client).
  await fixture.loader.refreshTail(target, 20); // Reconnect recovery.
  expect(reads()).toBe(2);
  expect(fixture.loader.getSnapshot(target).status).not.toBe('error');
});

// The candidate run on the smarty-code#605 gateway: a frozen Pi's history read is answered 503 after the gateway's own
// 12 s transport limit, with code smarty.pi-timed-out (#605 e82e5de6). The open made three of them, about 38 s.
/** The gateway's refusal body (smarty-code errors.ts). */
type GatewayRefusal = { message: string; isRetryable: boolean; code?: string };
const gateway503 = (code?: string) => {
  const data: GatewayRefusal = { message: 'Pi unavailable; mutation outcome may be unknown. Do not retry automatically.', isRetryable: false };
  if (code) data.code = code;
  return Response.json({ name: 'APIError', data }, { status: 503 });
};

test('an open the gateway says timed out on the Pi (a frozen Pi) is one read, and the page\'s reloads wait', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => gateway503('smarty.pi-timed-out');
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'reactive' });
  expect(reads()).toBe(1);
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  await fixture.loader.ensure(target, { reason: 'reactive' }); // A session update re-runs the page's effect.
  expect(reads()).toBe(1);
});

test('a not-retryable 503 without that code (a probe blip, an interrupted read) keeps its tries and recovers', async () => {
  fixture = nativeDraftFixture();
  let n = 0;
  fixture.handlers.history = async () => (++n < 2 ? gateway503() : Response.json([]));
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'reactive' });
  expect(reads()).toBe(2);
  expect(fixture.loader.getSnapshot(target).status).not.toBe('error');
});
