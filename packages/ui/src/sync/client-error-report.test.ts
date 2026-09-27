import { afterEach, expect, test } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { resetClientErrorReportsForPage } from '@/lib/clientErrorReport';
import { directory, nativeDraftFixture, session } from './native-draft-fixture';

// smarty-code#536 item 3 (Paul, 3.38): "Session could not be loaded" was shown to him and nothing in the fleet saw it.
// The loader's error path reports what the page shows to the gateway (POST /api/client-error), once per 30 s per kind.
let fixture: ReturnType<typeof nativeDraftFixture> | undefined;
afterEach(() => { fixture?.dispose(); fixture = undefined; resetClientErrorReportsForPage(); });
const reports = () => fixture!.requests.filter(request => new URL(request.url).pathname === '/api/client-error');

test('a session whose messages cannot be loaded is reported once, with its session and status', async () => {
  fixture = nativeDraftFixture();
  // The server's words may quote the person's content: never reported.
  fixture.handlers.history = async () => Response.json({ name: 'APIError', data: { message: "Refused: 'keep the merger plan private'", isRetryable: false } }, { status: 503 });
  const target = { directory, sessionID: session.id };
  await fixture.loader.ensure(target, { reason: 'navigation' });
  expect(fixture.loader.getSnapshot(target).status).toBe('error'); // What the page shows as "Session could not be loaded".
  await sleep(50); // The report goes out in the background.
  expect(reports()).toHaveLength(1);
  const body = await reports()[0]!.json() as Record<string, unknown>;
  expect(body).toMatchObject({ kind: 'session-messages.initial', sessionID: session.id, status: 503 });
  expect(typeof body.message).toBe('string');
  expect(JSON.stringify(body).includes('merger')).toBe(false);
  expect(typeof body.at).toBe('number');
  for (const key of Object.keys(body)) expect(['at', 'kind', 'message', 'sessionID', 'status']).toContain(key); // No content, no route.
  // The same failure again within 30 s: shown again, not reported again.
  await fixture.loader.ensure(target, { reason: 'navigation', force: true });
  expect(fixture.loader.getSnapshot(target).status).toBe('error');
  await sleep(50);
  expect(reports()).toHaveLength(1);
});

test('a history open that timed out is reported as a timeout, with its session', async () => {
  fixture = nativeDraftFixture();
  fixture.handlers.history = async () => { throw new Error('OpenCode request timed out after 30000ms'); };
  await fixture.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
  await sleep(50);
  const bodies = await Promise.all(reports().map(request => request.json() as Promise<Record<string, unknown>>));
  expect(bodies.map(body => [body.kind, body.sessionID])).toEqual([['session-messages.initial.timeout', session.id]]);
});

test('a load that succeeds reports nothing', async () => {
  fixture = nativeDraftFixture();
  await fixture.loader.ensure({ directory, sessionID: session.id }, { reason: 'navigation' });
  await sleep(50);
  expect(reports()).toHaveLength(0);
});

test('an error toast is reported without its text, by the code that showed it: different sites each, one site once per 30 s', async () => {
  fixture = nativeDraftFixture();
  const { toast } = await import('@/components/ui');
  // Block bodies: a tail call (JavaScriptCore, Safari) would report its caller's site, which is still one code location.
  const showMerger = () => { toast.error('No commits found in range main...feature/merger'); };
  const showPayroll = () => { toast.error('Failed to attach payroll.xlsx'); };
  showMerger(); showMerger(); showPayroll();
  await sleep(50);
  const bodies = await Promise.all(reports().map(request => request.json() as Promise<Record<string, unknown>>));
  expect(bodies).toHaveLength(2); // Two sites, two reports; the repeat of one site within 30 s is not sent again.
  for (const body of bodies) expect(/^toast\.client-error-report-test\.\d+\.\d+$/.test(String(body.kind))).toBe(true);
  expect(bodies[0]!.kind).not.toBe(bodies[1]!.kind);
  expect(bodies[0]!.message).toBeUndefined();
  expect(/merger|payroll/.test(JSON.stringify(bodies))).toBe(false);
});

test('a report is redacted: no query strings, tokens, addresses, quoted text, file names or paths', async () => {
  const { redactClientError } = await import('@/lib/clientErrorReport');
  expect(redactClientError('Failed https://code.example/api/x?token=abc for paul@example.com with sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123'))
    .toBe('Failed https://code.example/api/x for <email> with <redacted>');
  expect(redactClientError('Could not rename "Merger plan for Friday" session')).toBe('Could not rename "…" session');
  expect(redactClientError('File "payroll.csv" is too large (max 10MB)')).toBe('File "…" is too large (max 10MB)');
  expect(redactClientError('Failed to attach payroll.xlsx')).toBe('Failed to attach <file>');
  expect(redactClientError('Cannot read /home/paul/secret/notes.md: denied')).toBe('Cannot read <path>: denied');
});

test('a report made for one server is never sent after a switch to another', async () => {
  fixture = nativeDraftFixture();
  const { reportClientError } = await import('@/lib/clientErrorReport');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  reportClientError({ kind: 'toast', message: 'shown for A', sessionID: 'ses_a' });
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: `other-${crypto.randomUUID()}` });
  await sleep(50);
  expect(reports()).toHaveLength(0);
});

// Review of #301 (P1): a failure is reported only to the server its operation belonged to, captured before its first
// await. A fork that fails after the page switched from server A to B is reported nowhere; never to B with B's token.
test('a fork that fails after a switch to another server is reported nowhere; without a switch, to its own server', async () => {
  fixture = nativeDraftFixture();
  const { forkFromMessage } = await import('./session-actions');
  const { switchRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch');
  const seen: Array<{ runtime: string; path: string }> = [];
  let release = () => {};
  const forkHeld = () => new Promise<void>(resolve => { release = resolve; });
  const served = globalThis.fetch;
  let hold: Promise<void> | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith('/client-error')) { seen.push({ runtime: getRuntimeKey(), path }); return new Response(null, { status: 204 }); }
    if (path.endsWith('/fork')) { if (hold) await hold; return Response.json({ name: 'APIError', data: { message: 'fork refused', isRetryable: false } }, { status: 500 }); }
    return served(input, init);
  }) as typeof fetch;
  try {
    const runtimeA = getRuntimeKey();
    // With a switch: the fork is sent on A, A goes away while it is out, then it fails.
    hold = forkHeld();
    const failing = forkFromMessage(session.id, 'msg_1').catch(() => undefined);
    await sleep(10);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: `server-b-${crypto.randomUUID()}` });
    release(); await failing; await sleep(50);
    expect(seen).toEqual([]); // Nowhere: never B.
    // Without a switch: back on A, the same failure is reported to A.
    switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: runtimeA });
    hold = undefined;
    await forkFromMessage(session.id, 'msg_2').catch(() => undefined); await sleep(50);
    expect(seen).toEqual([{ runtime: runtimeA, path: '/api/client-error' }]);
  } finally { globalThis.fetch = served; }
});

// Review of #301 (P2): a switch does not stop reporting for good. A generic toast (no runtime of its own) is not sent
// for a while after a switch (a late failure of the previous server's); after that, toasts report again. An operation
// that captures its runtime reports exactly: begun on B, it reports to B at once.
test('after a switch, a late toast is not reported, later toasts are, and an operation begun on the new server reports at once', async () => {
  fixture = nativeDraftFixture();
  const { toast } = await import('@/components/ui');
  const { requestSmallModel } = await import('@/lib/smallModelRequest');
  const { switchRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch');
  const runtimeA = getRuntimeKey();
  const { Window } = await import('happy-dom');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new Window({ url: 'http://localhost' }) });
  const served = globalThis.fetch;
  const seen: Array<{ runtime: string; kind: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith('/client-error')) { seen.push({ runtime: getRuntimeKey(), kind: String((await request.json()).kind) }); return new Response(null, { status: 204 }); }
    if (path.endsWith('/small-model/generate')) return Response.json({ error: 'no model' }, { status: 503 });
    return served(input, init);
  }) as typeof fetch;
  const lateToast = () => toast.error('Failed to generate a title');
  try {
    toast.error('Shown before any switch'); // Subscribes on the page's window (as at page load); reported.
    await sleep(50);
    expect(seen).toHaveLength(1);
    const runtimeB = `server-b-${crypto.randomUUID()}`;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: runtimeB });
    lateToast(); // A's request finished just after the switch: not reported.
    await sleep(50);
    expect(seen).toHaveLength(1);
    await requestSmallModel({ method: 'POST', body: '{}' }); await sleep(50); // Begun on B, fails on B: reported to B now.
    expect(seen.slice(1)).toEqual([{ runtime: runtimeB, kind: 'small-model' }]);
    const now = Date.now; Date.now = () => now() + 3 * 60_000; // Minutes later, a new toast reports again.
    try { lateToast(); } finally { Date.now = now; }
    await sleep(50);
    expect(seen).toHaveLength(3);
    expect(seen[2]!.runtime).toBe(runtimeB);
    expect(seen[2]!.kind.startsWith('toast.')).toBe(true);
  } finally {
    globalThis.fetch = served;
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
  switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: runtimeA });
});

test('a failed context pin and a failed OpenCode upgrade each report their own code and status', async () => {
  fixture = nativeDraftFixture();
  const { setContextObligatoryMessage } = await import('./session-actions');
  const { runtimeFetch } = await import('@/lib/runtime-fetch');
  const served = globalThis.fetch;
  const kinds: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith('/client-error')) { const body = await request.json(); kinds.push(`${body.kind}:${body.status ?? ''}`); return new Response(null, { status: 204 }); }
    if (request.method === 'PATCH' || path.endsWith('/opencode/upgrade')) return Response.json({ error: 'refused' }, { status: 500 });
    return served(input, init);
  }) as typeof fetch;
  try {
    await setContextObligatoryMessage(session.id, directory, { id: 'msg_1', createdAt: 1, role: 'user' }, true).catch(() => undefined);
    await runtimeFetch('/api/opencode/upgrade', { method: 'POST', body: '{}' });
    await sleep(50);
    expect(kinds.sort()).toEqual(['context-pin:', 'opencode-upgrade:500']);
  } finally { globalThis.fetch = served; }
});

// Review of #301 (P2): no error toast bypasses reporting. A file that shows one without the reporting wrapper (sonner,
// or the unwrapped toast module) reports that failure itself, with its runtime (context pin, upgrade, small model, ...).
test('every error toast shown outside the reporting wrapper is reported by its own code', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url).pathname;
  // A reviewed branded file keeps its bytes: the operation it calls reports instead (checked below).
  const reportedByOperation: Record<string, [string, RegExp]> = {
    'components/chat/ChatMessage.tsx': ['sync/session-actions.ts', /kind: "context-pin"/],
    'components/update/OpenCodeUpdateToast.tsx': ['lib/runtime-fetch.ts', /kind: 'opencode-upgrade'/],
  };
  const bypass: string[] = [];
  for (const file of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(file) || /\.test\.|__tests__|components\/ui\/(index|toast)\./.test(file)) continue;
    const text = readFileSync(root + file, 'utf8');
    if (/from '(sonner|@\/components\/ui\/toast|\.\/toast)'/.test(text) && /toast\.error\(/.test(text) && !/reportClientError\(/.test(text)
      && !(reportedByOperation[file] && reportedByOperation[file]![1].test(readFileSync(root + reportedByOperation[file]![0], 'utf8')))) bypass.push(file);
  }
  expect(bypass).toEqual([]);
});

test('a native app\'s first connection (from no server) is not a switch: its error toasts are still reported', async () => {
  fixture = nativeDraftFixture();
  const { toast } = await import('@/components/ui');
  const { Window } = await import('happy-dom');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const win = new Window({ url: 'http://localhost' });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  try {
    toast.error('Subscribes on the page window'); await sleep(50);
    const before = reports().length;
    const { resetClientErrorReportsForPage } = await import('@/lib/clientErrorReport');
    resetClientErrorReportsForPage(); // A new 30 s window for the next toast report.
    // The cold boot's first connection: from the uninitialized default to the first server.
    win.dispatchEvent(new win.CustomEvent('openchamber:runtime-endpoint-changed', { detail: { apiBaseUrl: 'http://synthetic.invalid',
      previousApiBaseUrl: '', runtimeKey: 'first-server', previousRuntimeKey: 'url:default' } }) as never);
    toast.error('An error after the first connection'); await sleep(50);
    expect(reports().length).toBe(before + 1);
  } finally { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});
