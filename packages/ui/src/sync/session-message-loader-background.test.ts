import { afterEach, expect, test } from 'bun:test';
import { directory, nativeDraftFixture } from './native-draft-fixture';

// smarty-code#867: a stream reconnect (or the stale-stream watchdog) refreshed every cached session at once. Each read
// makes the gateway re-read a large journal window, so all of them timed out together and the page marked loaded
// sessions "could not be loaded". Background refreshes run at most two at once, the viewed session never waits behind
// them, and a background timeout keeps the loaded messages.
let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; });

const sessionOf = (request: Request) => new URL(request.url).pathname.split('/').at(-2) ?? '';
const reads = () => fixture!.requests.filter(request => new URL(request.url).pathname.endsWith('/message'));
const message = (sessionID: string) => ({
  info: { id: `msg_${sessionID}`, sessionID, role: 'user', time: { created: 1 } },
  parts: [{ id: `prt_${sessionID}`, sessionID, messageID: `msg_${sessionID}`, type: 'text', text: 'hello' }],
});
const page = (sessionID: string) => Response.json([message(sessionID)]);
const timeout = () => new Error('OpenCode request timed out after 6700ms');

test('8 cached sessions refreshing at once: at most 2 background reads in flight, the viewed one first', async () => {
  fixture = nativeDraftFixture();
  const ids = Array.from({ length: 8 }, (_, i) => `ses_${i}`);
  const viewed = 'ses_viewed';
  // Every session loaded once (as the page's cache holds them).
  fixture.handlers.history = async () => page(sessionOf(fixture!.requests.at(-1)!));
  for (const id of [...ids, viewed]) await fixture.loader.ensure({ directory, sessionID: id }, { reason: 'navigation' });

  const before = reads().length;
  let inFlight = 0, maxBackground = 0;
  const releases: Array<() => void> = [];
  fixture.handlers.history = async () => {
    const id = sessionOf(fixture!.requests.at(-1)!);
    const background = id !== viewed;
    if (background) maxBackground = Math.max(maxBackground, ++inFlight);
    await new Promise<void>(resolve => releases.push(resolve));
    if (background) inFlight--;
    return page(id);
  };
  // As the reconnect resync asks: the viewed session in the foreground, every other one in the background.
  const all = [
    fixture.loader.refreshTail({ directory, sessionID: viewed }, 50),
    ...ids.map(id => fixture!.loader.refreshTail({ directory, sessionID: id }, 50, { background: true })),
  ];
  // Release reads one by one until all are done.
  for (let guard = 0; guard < 100 && reads().length - before < ids.length + 1; guard++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    releases.shift()?.();
  }
  while (releases.length) { releases.shift()?.(); await new Promise(resolve => setTimeout(resolve, 5)); }
  await Promise.all(all);

  const refreshed = reads().slice(before).map(sessionOf);
  expect(refreshed[0]).toBe(viewed);
  expect(refreshed.length).toBe(ids.length + 1);
  expect(maxBackground).toBeLessThanOrEqual(2);
});

test('a background refresh that times out on a loaded session keeps its messages and shows no error', async () => {
  fixture = nativeDraftFixture();
  const target = { directory, sessionID: 'ses_loaded' };
  fixture.handlers.history = async () => page(target.sessionID);
  await fixture.loader.ensure(target, { reason: 'navigation' });
  expect(fixture.children.ensureChild(directory).getState().message[target.sessionID]?.length).toBe(1);

  const before = reads().length;
  fixture.handlers.history = async () => { throw timeout(); };
  await fixture.loader.refreshTail(target, 50, { background: true });

  const snapshot = fixture.loader.getSnapshot(target);
  expect(snapshot.status).not.toBe('error');
  expect(snapshot.error).toBeNull();
  expect(snapshot.resolved).toBe(true);
  expect(fixture.children.ensureChild(directory).getState().message[target.sessionID]?.length).toBe(1);
  expect(reads().length - before).toBe(1); // Not retried at once: the next resync tries again.

  fixture.handlers.history = async () => page(target.sessionID);
  await fixture.loader.refreshTail(target, 50, { background: true });
  expect(fixture.loader.getSnapshot(target).status).toBe('ready');
});
