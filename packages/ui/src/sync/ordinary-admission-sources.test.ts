import './native-test-network';
import { expect, test } from 'bun:test';
import { nativeDraftFixture, deferred, directory as A, session } from './native-draft-fixture';
import { routeMessage } from './session-ui-store';
import { sessionSendState } from './session-send-state';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';

// smarty-code#1427 round 2, from the independent audit of 71aa1b3e. Every ordinary prompt that leaves the page
// holds a session reservation and carries an accepted history view, whichever source first said "ordinary".
const B = '/native-project-b';
const ordinary = { generation: 'g1', sequence: 1, model: { providerID: 'p', modelID: 'm', name: 'M' }, thinkingLevel: 'high' as const };
const ordinaryRow = { ...session, nativeRuntime: 'ordinary' as const, ordinary };
const view = (request: Request) => request.headers.get('x-smarty-ordinary-view');
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

type Fixture = ReturnType<typeof nativeDraftFixture>;
async function heldPair(f: Fixture, params: Parameters<typeof routeMessage>[0]) {
  const held = deferred<Response>();
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? held.promise : new Response(null, { status: 204 });
  const first = routeMessage(params).then(() => 'sent', () => 'refused');
  await tick(10);
  const second = await routeMessage({ ...params, content: 'Unrelated second input' }).then(() => 'sent', () => 'refused');
  return { held, first, second, posts: () => posts };
}

// R4C-1427-GLOBAL-ROW-DISPATCH-GAP-01
test('a global-only ordinary row without loaded history sends with an accepted view, or not at all', async () => {
  const f = nativeDraftFixture();
  f.children.ensureChild(A, { bootstrap: false }).setState({ session: [] });
  useGlobalSessionsStore.getState().applySnapshot([ordinaryRow], []);
  const run = await heldPair(f, { runtimeKey: f.runtimeA, sessionId: session.id, directory: A, content: 'First', providerID: 'p', modelID: 'm' });
  try {
    expect(run.posts()).toBe(1);
    expect(f.prompts().every(request => view(request) !== null)).toBe(true);
    expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(true);
    expect(run.second).toBe('refused');
  } finally { run.held.resolve(new Response(null, { status: 204 })); await run.first; f.dispose(); }
});

// R4C-1427-ADMISSION-DISPATCH-RACE-01
test('a stock-classified send refuses before POST when the session turns ordinary during preparation', async () => {
  const f = nativeDraftFixture(), probeStarted = deferred<void>(), probeRelease = deferred<boolean>();
  const originalProbe = useConfigStore.getState().probeConnection;
  f.children.ensureChild(A, { bootstrap: false }).setState({ session: [] });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  useConfigStore.setState({ isConnected: false, probeConnection: async () => { probeStarted.resolve(); return probeRelease.promise; } });
  const held = deferred<Response>();
  let posts = 0;
  f.handlers.prompt = async () => ++posts === 1 ? held.promise : new Response(null, { status: 204 });
  const params = { runtimeKey: f.runtimeA, sessionId: session.id, directory: A, content: 'Starts as stock', providerID: 'p', modelID: 'm' };
  try {
    const first = routeMessage(params).then(() => 'sent', () => 'refused');
    await probeStarted.promise;
    useGlobalSessionsStore.getState().applySnapshot([ordinaryRow], []);
    probeRelease.resolve(true);
    expect(await first).toBe('refused');
    expect(posts).toBe(0);
    // The next deliberate Send is admitted as ordinary: reserved and carrying an accepted view.
    const second = routeMessage({ ...params, content: 'Deliberate ordinary Send' }).then(() => 'sent', () => 'refused');
    await tick(10);
    expect(posts).toBe(1);
    expect(view(f.prompts()[0])).not.toBeNull();
    expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(true);
    held.resolve(new Response(null, { status: 204 }));
    expect(await second).toBe('sent');
  } finally { held.resolve(new Response(null, { status: 204 })); probeRelease.resolve(true); useConfigStore.setState({ probeConnection: originalProbe }); f.dispose(); }
});

// R4C-1427-CROSS-DIRECTORY-INDEX-MASK-01
test('a stock duplicate in the target directory does not mask another directory\'s ordinary row', async () => {
  const f = nativeDraftFixture();
  f.children.ensureChild(B, { bootstrap: false }).setState({ session: [{ ...ordinaryRow, directory: B }] });
  f.children.ensureChild(A, { bootstrap: false }).setState({ session: [{ ...session, directory: A }] });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  expect([...f.children.children.keys()]).toEqual([B, A]);
  const run = await heldPair(f, { runtimeKey: f.runtimeA, sessionId: session.id, directory: A, content: 'First', providerID: 'p', modelID: 'm' });
  try {
    expect(run.posts()).toBeLessThanOrEqual(1);
    expect(f.prompts().every(request => view(request) !== null)).toBe(true);
    expect(run.second).toBe('refused');
  } finally { run.held.resolve(new Response(null, { status: 204 })); await run.first; f.dispose(); }
});

// R4C-1427-DIRECTORY-FALLBACK-KEY-MISMATCH-01
test('an omitted directory classifies against the directory the SDK sends to', async () => {
  const f = nativeDraftFixture();
  f.children.ensureChild(A, { bootstrap: false }).setState({ session: [] });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  await f.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' });
  f.children.getChild(A)!.setState({ session: [] });
  const run = await heldPair(f, { runtimeKey: f.runtimeA, sessionId: session.id, content: 'First', providerID: 'p', modelID: 'm' });
  try {
    expect(run.posts()).toBe(1);
    expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(true);
    expect(run.second).toBe('refused');
  } finally { run.held.resolve(new Response(null, { status: 204 })); await run.first; f.dispose(); }
});

test('genuine stock sessions keep concurrent prompts with no reservation', async () => {
  const f = nativeDraftFixture();
  f.children.ensureChild(A, { bootstrap: false }).setState({ session: [{ ...session, directory: A }] });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  const run = await heldPair(f, { runtimeKey: f.runtimeA, sessionId: session.id, directory: A, content: 'First', providerID: 'p', modelID: 'm' });
  try {
    expect(run.second).toBe('sent');
    expect(run.posts()).toBe(2);
    expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(false);
  } finally { run.held.resolve(new Response(null, { status: 204 })); await run.first; f.dispose(); }
});

// smarty-code#1427 round 3, from the independent audit of 85c63ee1.
const retainedRow = { ...session, nativeRuntime: 'ordinary' as const,
  ordinary: { generation: null, sequence: 0, model: null, thinkingLevel: null }, smartyRetainedUnavailable: true };
const endedRow = { ...ordinaryRow, herdrState: 'ended', herdrPaneLive: false };
const fileInput = { type: 'file' as const, mime: 'text/plain', filename: 'probe.txt', url: 'data:text/plain;base64,WA==' };

// Holds the SDK's file preparation until the test releases it.
function holdFilePreparation() {
  const started = deferred<void>(), release = deferred<void>();
  Reflect.set(opencodeClient, 'toNormalizedFilePartInput', async () => {
    started.resolve(); await release.promise;
    return { type: 'file', mime: fileInput.mime, filename: fileInput.filename, url: fileInput.url };
  });
  return { started, release, restore: () => { release.resolve(); Reflect.deleteProperty(opencodeClient, 'toNormalizedFilePartInput'); } };
}
const posted = (f: Fixture, suffix: string) => f.requests.filter(request => request.method === 'POST' && new URL(request.url).pathname.endsWith(suffix));

// R4C-1427-DIRECTORY-FALLBACK-KEY-MISMATCH-01 (in-flight directory change)
test('an omitted directory is captured once: a later client directory change cannot misdirect the final check', async () => {
  const f = nativeDraftFixture(), hold = holdFilePreparation();
  f.children.ensureChild(A, { bootstrap: false }).setState({ session: [] });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  const route = routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, content: 'Omitted directory',
    providerID: 'p', modelID: 'm', files: [fileInput] }).then(() => 'sent', () => 'refused');
  try {
    await hold.started.promise;
    await f.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' }); // A turns ordinary.
    opencodeClient.setDirectory(B);
    hold.release.resolve();
    expect(await route).toBe('refused');
    expect(f.prompts()).toHaveLength(0);
    expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(false);
  } finally { hold.restore(); await route; opencodeClient.setDirectory(A); f.dispose(); }
});

// R4C-1427-ADMISSION-DISPATCH-RACE-01 (slash commands)
test('a stock-classified command refuses before its POST when the session turns ordinary during file preparation', async () => {
  const f = nativeDraftFixture(), hold = holdFilePreparation();
  // SAFETY: the child store accepts the fixture's minimal command record; only its name is read here.
  f.children.ensureChild(A, { bootstrap: false }).setState({ session: [{ ...session, directory: A }], command: [{ name: 'probe' }] as never });
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  const route = routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory: A, content: '/probe',
    providerID: 'p', modelID: 'm', files: [fileInput] }).then(() => 'sent', () => 'refused');
  try {
    await hold.started.promise;
    f.children.getChild(A)!.setState({ session: [{ ...ordinaryRow, directory: A }] });
    hold.release.resolve();
    expect(await route).toBe('refused');
    expect(posted(f, '/command')).toHaveLength(0);
  } finally { hold.restore(); await route; f.dispose(); }
});

// R4C-1427-GLOBAL-ROW-FRESHNESS-01
test('a live stock directory row outranks a stale global ordinary row', async () => {
  const f = nativeDraftFixture();
  f.children.ensureChild(A, { bootstrap: false }).setState({ session: [{ ...session, directory: A }] });
  useGlobalSessionsStore.getState().applySnapshot([ordinaryRow], []);
  f.handlers.history = async () => Response.json([]);
  try {
    const outcome = await routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory: A,
      content: 'Stock session', providerID: 'p', modelID: 'm' }).then(() => 'sent', () => 'refused');
    expect(outcome).toBe('sent');
    expect(f.prompts()).toHaveLength(1);
    expect(view(f.prompts()[0])).toBeNull();
    expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(false);
  } finally { f.dispose(); }
});

// R4C-1427-UNADMITTED-ORDINARY-AVAILABILITY-BYPASS-01
for (const [label, row] of [['retained-unavailable', retainedRow], ['ended', endedRow]] as const) {
  test(`a global-only ${label} owner refuses before POST even without catalog admission`, async () => {
    const f = nativeDraftFixture();
    f.children.ensureChild(A, { bootstrap: false }).setState({ session: [] });
    useProjectsStore.setState({ managedCatalogAdmitted: false, managedCatalogStatus: 'stock' });
    useGlobalSessionsStore.getState().applySnapshot([row], []);
    await f.loader.ensure({ directory: A, sessionID: session.id }, { reason: 'navigation' });
    try {
      const outcome = await routeMessage({ runtimeKey: f.runtimeA, sessionId: session.id, directory: A,
        content: 'Must not send', providerID: 'p', modelID: 'm' }).then(() => 'sent', () => 'refused');
      expect(outcome).toBe('refused');
      expect(f.prompts()).toHaveLength(0);
      expect(sessionSendState.isPending(f.runtimeA, session.id)).toBe(false);
    } finally { f.dispose(); }
  });
}
