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
  // Separate failures arrive in separate tasks (network answers); within one task they would be one failure.
  showMerger(); await sleep(0); showMerger(); await sleep(0); showPayroll();
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

// Review of #301 (P2, 5854326593): old work never gates new reports. A report without scope goes to the page's current
// server; a report that carries an old server's scope is dropped.
test('with an old request still pending, a new error on the new server is reported once to it; the old operation\'s late failure is dropped', async () => {
  fixture = nativeDraftFixture();
  const { toast } = await import('@/components/ui');
  const { forkFromMessage } = await import('./session-actions');
  const { switchRuntimeEndpoint, getRuntimeKey } = await import('@/lib/runtime-switch');
  const runtimeA = getRuntimeKey();
  const served = globalThis.fetch;
  const seen: Array<{ runtime: string; kind: string }> = [];
  let releaseA = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith('/client-error')) { seen.push({ runtime: getRuntimeKey(), kind: String((await request.json()).kind) }); return new Response(null, { status: 204 }); }
    if (path.endsWith('/fork')) { await new Promise<void>(resolve => { releaseA = resolve; }); return Response.json({ name: 'APIError', data: { message: 'refused' } }, { status: 500 }); }
    return served(input, init);
  }) as typeof fetch;
  try {
    const lateA = forkFromMessage(session.id, 'msg_1').catch(() => undefined); // A's operation, still pending.
    await sleep(10);
    const runtimeB = `server-b-${crypto.randomUUID()}`;
    switchRuntimeEndpoint({ apiBaseUrl: 'http://synthetic.invalid', runtimeKey: runtimeB });
    toast.error('Could not load stashes'); await sleep(50); // A new error on B, while A's request is out.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.runtime).toBe(runtimeB);
    expect(seen[0]!.kind.startsWith('toast.')).toBe(true);
    releaseA(); await lateA; await sleep(50); // A's own failure, late: it carries A's scope, so it goes nowhere.
    expect(seen).toHaveLength(1);
  } finally { globalThis.fetch = served; }
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
    await sleep(0); // The upgrade is a separate failure, in its own task.
    await runtimeFetch('/api/opencode/upgrade', { method: 'POST', body: '{}' });
    await sleep(50);
    expect(kinds.sort()).toEqual(['context-pin:', 'opencode-upgrade:500']);
    // A 200 that says it did not succeed, and a request that never got an answer, are failures too.
    const { resetClientErrorReportsForPage } = await import('@/lib/clientErrorReport');
    resetClientErrorReportsForPage(); kinds.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (path.endsWith('/client-error')) { const body = await request.json(); kinds.push(`${body.kind}:${body.status ?? ''}`); return new Response(null, { status: 204 }); }
      return Response.json({ success: false, error: 'npm refused' }, { status: 200 });
    }) as typeof fetch;
    await runtimeFetch('/api/opencode/upgrade', { method: 'POST', body: '{}' }); await sleep(50);
    expect(kinds).toEqual(['opencode-upgrade:200']);
    resetClientErrorReportsForPage(); kinds.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init), path = new URL(request.url).pathname;
      if (path.endsWith('/client-error')) { const body = await request.json(); kinds.push(`${body.kind}:${body.status ?? ''}`); return new Response(null, { status: 204 }); }
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await runtimeFetch('/api/opencode/upgrade', { method: 'POST', body: '{}' }).catch(() => undefined); await sleep(50);
    expect(kinds).toEqual(['opencode-upgrade:']);
  } finally { globalThis.fetch = served; }
});

// Review of #301 (P2): no error toast bypasses reporting. A file that shows one without the reporting wrapper (sonner,
// or the unwrapped toast module) reports that failure itself, with its runtime (context pin, upgrade, small model, ...).
// One shown error, one report: a send refused by the page's own check, then its caller's toast in the same task.
test('within one task, a failure\'s first report stands and its consequences are not reported; other sessions and later tasks report', async () => {
  fixture = nativeDraftFixture();
  const { reportClientError } = await import('@/lib/clientErrorReport');
  const { toast } = await import('@/components/ui');
  const kinds: string[] = [];
  const served = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), path = new URL(request.url).pathname;
    if (path.endsWith('/client-error')) { kinds.push(String((await request.json()).kind)); return new Response(null, { status: 204 }); }
    return served(input, init);
  }) as typeof fetch;
  try {
    await Promise.resolve().then(() => {
      reportClientError({ kind: 'send.unavailable', sessionID: session.id }); // The operation's own report...
    }).then(() => { toast.error('This session is unavailable right now'); }); // ...and its caller's toast, same task.
    await sleep(50);
    expect(kinds).toEqual(['send.unavailable']);
    await Promise.resolve().then(() => { toast.error('Could not read the mentioned file'); }) // A toast first...
      .then(() => reportClientError({ kind: 'send.unavailable', sessionID: 'ses_other' })); // ...then the refusal.
    await sleep(50);
    expect(kinds).toHaveLength(2); // One more: the toast, the first report of that failure.
    await Promise.resolve().then(() => reportClientError({ kind: 'session-messages.initial', sessionID: 'ses_x' }))
      .then(() => reportClientError({ kind: 'start.history', sessionID: 'ses_x' })) // The start that failure refused.
      .then(() => reportClientError({ kind: 'session-messages.initial', sessionID: 'ses_y' })); // Another session: its own.
    await sleep(50);
    expect(kinds.slice(2)).toEqual(['session-messages.initial', 'session-messages.initial']);
    const later = () => { toast.error('Could not load stashes'); };
    later(); await sleep(50); // A new error, in a later task: reported.
    expect(kinds).toHaveLength(5);
    expect(kinds[4]!.startsWith('toast.')).toBe(true);
  } finally { globalThis.fetch = served; }
});

test('every error toast shown outside the reporting wrapper is reported by its own code', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const root = new URL('..', import.meta.url).pathname;
  // A reviewed branded file keeps its bytes: the operation it calls reports instead (checked below).
  const reportedByOperation: Record<string, [string, RegExp]> = {
    'components/chat/ChatMessage.tsx': ['sync/session-actions.ts', /kind: "context-pin"/],
    'components/chat/work-status/WorkStatusPinnedSection.tsx': ['sync/session-actions.ts', /kind: "context-pin"/],
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
  // One shown error, one report: a caller of an operation that reports its own failure (the context pin) shows its
  // toast unwrapped, or a failed unpin in Work Status would report twice.
  const twice: string[] = [];
  for (const file of readdirSync(root, { recursive: true }) as string[]) {
    if (!/\.tsx?$/.test(file) || /\.test\.|__tests__/.test(file)) continue;
    const text = readFileSync(root + file, 'utf8');
    if (/setContextObligatoryMessage\(/.test(text) && /from '@\/components\/ui'/.test(text) && /toast\.error\(/.test(text)) twice.push(file);
  }
  expect(twice).toEqual([]);
});
