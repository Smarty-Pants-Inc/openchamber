import { afterEach, expect, test } from 'bun:test';
import { session } from './native-draft-fixture';
import { failure, fx, h, interactive, record, resetInteractive } from './native-draft-interactive';
import { startNativeDraft } from './native-draft-start';

// smarty-code#931 (3.52, op b29d75a3): the start reached 'ready', then the page's read of the new session timed out under
// a gateway read burst, and the page said "It is not clear whether the session started". A read replays nothing: it is
// read again with backoff, and the session opens. A definite answer (404) is not read again.
afterEach(resetInteractive);
const sessionReads = () => fx().requests.filter(r => new URL(r.url).pathname.endsWith(`/session/${session.id}`)).length;
/** The first `n` reads of the new session fail as the page's request timeout does (no HTTP status). */
function failFirstReads(n: number, status?: number) {
  const inner = globalThis.fetch; let left = n;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(new Request(input, init).url).pathname;
    if (path.endsWith(`/session/${session.id}`) && left > 0) {
      left--; fx().requests.push(new Request(input, init));
      if (status) return Response.json({ name: 'NotFound', data: { message: 'gone' } }, { status });
      throw new DOMException('The operation timed out.', 'TimeoutError');
    }
    return inner(input, init);
  }) as typeof fetch;
  globalThis.fetch = wrapped;
  const restore = h.restore; h.restore = () => { globalThis.fetch = inner; restore(); };
}

test('the read after ready times out once, then succeeds: the session opens, no "unknown"', async () => {
  interactive(() => h.operation);
  failFirstReads(1);
  expect(await failure(startNativeDraft([], async () => {}))).toBe('resolved');
  expect(record()?.status).toBe('created');
  expect(sessionReads()).toBe(2);
}, 30_000);

test('counterexample: a 404 for the new session is a definite answer: read once, not retried', async () => {
  interactive(() => h.operation);
  failFirstReads(5, 404);
  expect(await failure(startNativeDraft([], async () => {}))).not.toBe('resolved');
  expect(sessionReads()).toBe(1);
}, 30_000);
