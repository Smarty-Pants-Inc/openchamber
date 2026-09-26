import { afterEach, expect, test } from 'bun:test';
import { holdViewOnlyWatch, setViewOnlyWatchFetch, viewOnlyWatchesHeld } from './view-only-watch';

// smarty-code#455 (smarty-dev#777): a page holds one quiet watch stream per shown View only session, released when the
// view closes; a gateway without readOnlyWatch is never asked.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Call = { path: string; query: Record<string, string> };
function gateway(options: { watch?: boolean; failFirst?: number } = {}) {
  const calls: Call[] = [];
  let open = 0, most = 0, failures = options.failFirst ?? 0;
  const fetch = async (path: string, init: { query: Record<string, string>; signal?: AbortSignal }) => {
    calls.push({ path, query: init.query });
    if (path === '/api/global/health') return Response.json({ healthy: true, capabilities: options.watch === false ? {} : { readOnlyWatch: 1 } });
    if (failures > 0) { failures--; return Response.json({ name: 'APIError', data: { isRetryable: true } }, { status: 503 }); }
    let closeStream = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        open++; most = Math.max(most, open);
        controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","properties":{}}\n\n'));
        closeStream = () => { open--; closeStream = () => {}; };
        init.signal?.addEventListener('abort', () => { closeStream(); try { controller.close(); } catch { /* closed */ } }, { once: true });
      },
      cancel() { closeStream(); },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, calls, open: () => open, most: () => most, watches: () => calls.filter((call) => call.path === '/api/event') };
}
afterEach(() => { setViewOnlyWatchFetch(); });

test('opening and closing 70 View only session views holds exactly one watch at a time, and none after', async () => {
  const g = gateway(); setViewOnlyWatchFetch(g.fetch as never);
  let release = () => {};
  for (let i = 0; i < 70; i++) { // The page switches from one View only session to the next.
    release(); release = holdViewOnlyWatch(`session-${i}`, '/project');
    await sleep(2);
    expect([viewOnlyWatchesHeld(), g.open()]).toEqual([1, 1]);
  }
  release(); await sleep(5);
  expect([viewOnlyWatchesHeld(), g.open(), g.most()]).toEqual([0, 0, 1]);
  expect(g.watches().map((call) => call.query.watch)).toEqual(Array.from({ length: 70 }, (_, i) => `session-${i}`));
  expect(g.watches().every((call) => call.query.directory === '/project')).toBe(true);
  expect(g.calls.filter((call) => call.path === '/api/global/health')).toHaveLength(1); // Asked once per directory.
});

test('two views of one session share one stream until the last closes; a release is idempotent', async () => {
  const g = gateway(); setViewOnlyWatchFetch(g.fetch as never);
  const first = holdViewOnlyWatch('s', '/p'), second = holdViewOnlyWatch('s', '/p');
  await sleep(5); expect([g.open(), g.watches().length]).toEqual([1, 1]);
  first(); first(); await sleep(5); expect(g.open()).toBe(1); // The other view still shows it.
  second(); await sleep(5); expect([g.open(), viewOnlyWatchesHeld()]).toEqual([0, 0]);
});

test('a gateway that does not advertise readOnlyWatch is never asked to watch', async () => {
  const g = gateway({ watch: false }); setViewOnlyWatchFetch(g.fetch as never);
  const release = holdViewOnlyWatch('s', '/old'); await sleep(10);
  expect(g.watches()).toHaveLength(0); release();
});

test('a 503 (the catalog was briefly unavailable) is retried until the watch is held', async () => {
  const g = gateway({ failFirst: 1 }); setViewOnlyWatchFetch(g.fetch as never);
  const release = holdViewOnlyWatch('s', '/p');
  for (let i = 0; i < 150 && g.open() === 0; i++) await sleep(10); // The first retry waits one second.
  expect([g.watches().length, g.open()]).toEqual([2, 1]);
  release(); await sleep(5); expect(g.open()).toBe(0);
});
